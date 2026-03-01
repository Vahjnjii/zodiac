// Cloudflare Pages Function → handles POST /api
// Requires AI binding with variable name: AI

export async function onRequestPost(context) {
  const { request, env } = context;

  // Guard: AI binding must exist
  if (!env.AI) {
    return Response.json(
      { error: 'AI binding missing. Go to Pages → Settings → Functions → AI Bindings and add binding with variable name: AI' },
      { status: 500 }
    );
  }

  let text, model;
  try {
    const body = await request.json();
    text  = body?.text;
    model = body?.model || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  } catch (e) {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!text || !text.trim()) {
    return Response.json({ error: 'No text provided' }, { status: 400 });
  }

  const SYSTEM = `Format the user's zodiac text into JSON.
Output ONLY valid JSON, no markdown, no explanation:
{"posts":[{"title":"string","content":["string"]}]}

Rules:
- Split into individual posts by title
- TITLE: remove emojis, *, # — keep exact wording
- Every content line must start with an emoji
- Bold sign names with **Name**
- 1-2 signs: one line "✨ **Aries**: text here"
- 3+ signs: ["🌟 **Aries**, **Leo**, **Virgo**", "🔮 explanation", ""]
- Remove all # from content lines
- Do NOT rewrite or change any text, only reformat`;

  let response;
  try {
    response = await env.AI.run(model, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: text }
      ],
      max_tokens: 4096,
      temperature: 0.1
    });
  } catch (e) {
    return Response.json({ error: `AI model error: ${e.message}` }, { status: 500 });
  }

  let raw = (response?.response || '').trim();
  raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

  if (!raw) {
    return Response.json({ error: 'Model returned empty response. Try again.' }, { status: 500 });
  }

  // Find JSON boundaries
  const fBrace   = raw.indexOf('{');
  const fBracket = raw.indexOf('[');
  let start = -1;
  if (fBrace === -1 && fBracket === -1) {
    return Response.json({ error: `Model returned no JSON. Got: ${raw.slice(0, 100)}` }, { status: 500 });
  }
  if (fBrace === -1)       start = fBracket;
  else if (fBracket === -1) start = fBrace;
  else                      start = Math.min(fBrace, fBracket);

  const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
  if (end < start) {
    return Response.json({ error: 'Incomplete JSON from model. Try again.' }, { status: 500 });
  }

  const jsonStr = repairJSON(raw.slice(start, end + 1));

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    const posts = extractPostsFallback(raw);
    if (posts.length > 0) return Response.json({ posts });
    return Response.json({ error: `JSON parse failed: ${e.message}` }, { status: 500 });
  }

  const posts = Array.isArray(parsed) ? parsed : (parsed.posts || []);
  if (!posts.length) {
    return Response.json({ error: 'Empty posts array from model. Try again.' }, { status: 500 });
  }

  return Response.json({ posts });
}

// Close truncated JSON
function repairJSON(str) {
  try { JSON.parse(str); return str; } catch (_) {}

  let s = str.replace(/,\s*$/, '');
  let braces = 0, brackets = 0, inStr = false, esc = false;

  for (const ch of s) {
    if (esc)  { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') braces++;
    if (ch === '}') braces--;
    if (ch === '[') brackets++;
    if (ch === ']') brackets--;
  }

  if (inStr) s += '"';
  s = s.replace(/,\s*$/, '');
  while (brackets > 0) { s += ']'; brackets--; }
  while (braces > 0)   { s += '}'; braces--; }

  return s;
}

// Regex fallback
function extractPostsFallback(raw) {
  const posts = [];
  const re = /"title"\s*:\s*"([^"]+)"[^}]*?"content"\s*:\s*(\[[^\]]+\])/gs;
  let m;
  while ((m = re.exec(raw)) !== null) {
    try { posts.push({ title: m[1], content: JSON.parse(m[2]) }); } catch (_) {}
  }
  return posts;
}
