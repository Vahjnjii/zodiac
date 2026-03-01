export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body  = await request.json();
    const text  = body?.text;
    const model = body?.model || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

    if (!text) return Response.json({ error: 'No text provided' }, { status: 400 });

    // Short, direct system prompt — reduces truncation risk
    const SYSTEM = `Format the user's zodiac text into JSON.
Output ONLY this JSON, nothing else, no markdown fences:
{"posts":[{"title":"string","content":["string"]}]}

Rules:
- Split into separate posts by title
- TITLE: strip emojis * # — keep exact words
- Each content line must start with an emoji
- Bold sign names: **Aries**
- 1-2 signs on one line: "✨ **Aries**: text"
- 3+ signs: ["🌟 **Aries**, **Leo**, **Virgo**", "🔮 explanation", ""]
- Remove all # characters from content
- Do NOT rewrite any text, only reformat`;

    const response = await env.AI.run(model, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: text }
      ],
      max_tokens: 4096,
      temperature: 0.1
    });

    let raw = (response?.response || '').trim();

    // Strip markdown fences if model added them
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

    if (!raw) {
      return Response.json({ error: 'Model returned empty response. Try again.' }, { status: 500 });
    }

    // Find JSON boundaries
    const fBrace   = raw.indexOf('{');
    const fBracket = raw.indexOf('[');
    let start = -1;
    if (fBrace === -1 && fBracket === -1) {
      return Response.json({ error: 'Model returned no JSON. Try again.' }, { status: 500 });
    }
    if (fBrace === -1) start = fBracket;
    else if (fBracket === -1) start = fBrace;
    else start = Math.min(fBrace, fBracket);

    const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
    if (end < start) {
      return Response.json({ error: 'Incomplete JSON from model. Try again.' }, { status: 500 });
    }

    let jsonStr = repairJSON(raw.slice(start, end + 1));

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      // Last-resort regex extraction
      const posts = extractPostsFallback(raw);
      if (posts.length > 0) return Response.json({ posts });
      return Response.json({ error: `Parse error: ${e.message}` }, { status: 500 });
    }

    const posts = Array.isArray(parsed) ? parsed : (parsed.posts || []);
    if (!posts.length) {
      return Response.json({ error: 'No posts found in response. Try again.' }, { status: 500 });
    }

    return Response.json({ posts });

  } catch (e) {
    return Response.json({ error: e.message || 'Unknown error' }, { status: 500 });
  }
}

// Close any truncated JSON safely
function repairJSON(str) {
  try { JSON.parse(str); return str; } catch (_) {}

  let s = str.replace(/,\s*$/, ''); // trim trailing comma
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

  if (inStr)          s += '"';
  s = s.replace(/,\s*$/, '');
  while (brackets > 0) { s += ']'; brackets--; }
  while (braces > 0)   { s += '}'; braces--; }

  return s;
}

// Regex fallback — extract whatever complete posts exist
function extractPostsFallback(raw) {
  const posts = [];
  const re = /"title"\s*:\s*"([^"]+)"[^}]*?"content"\s*:\s*(\[[^\]]+\])/gs;
  let m;
  while ((m = re.exec(raw)) !== null) {
    try { posts.push({ title: m[1], content: JSON.parse(m[2]) }); } catch (_) {}
  }
  return posts;
}
