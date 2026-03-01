// Cloudflare Pages Function → POST /api
// AI binding variable name must be: AI

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.AI) {
    return Response.json({
      error: 'AI binding not found. In Pages → Settings → Functions → AI Bindings, add binding with variable name exactly: AI'
    }, { status: 500 });
  }

  let text, model;
  try {
    const body = await request.json();
    text  = (body?.text || '').trim();
    model = body?.model || '@cf/meta/llama-3.1-8b-instruct-fast';
  } catch (e) {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!text) return Response.json({ error: 'No text provided' }, { status: 400 });

  // Very explicit prompt — model MUST return only JSON
  const prompt = `You are a JSON formatter. Return ONLY a JSON object. No explanation, no markdown, no code fences.

Convert this zodiac text into this exact JSON format:
{"posts":[{"title":"string","content":["string"]}]}

Formatting rules:
1. Split into separate posts by title
2. Title: remove emojis and symbols (* # ), keep exact words
3. Every content line must start with an emoji
4. Bold zodiac sign names: **Aries**
5. 1 or 2 signs per line = single line: "✨ **Aries**: explanation"
6. 3 or more signs per line = split into: ["🌟 **Aries**, **Leo**, **Virgo**", "🔮 explanation", ""]
7. Remove all # characters

INPUT TEXT:
${text}

JSON OUTPUT:`;

  let aiResult;
  try {
    aiResult = await env.AI.run(model, {
      prompt,
      max_tokens: 4096,
      temperature: 0.1
    });
  } catch (e) {
    return Response.json({ error: `AI run failed: ${e.message}` }, { status: 500 });
  }

  // CF AI can return response in different fields depending on model type
  // Try all known fields
  let raw = '';
  if (typeof aiResult === 'string') {
    raw = aiResult;
  } else if (aiResult?.response) {
    raw = aiResult.response;
  } else if (aiResult?.result?.response) {
    raw = aiResult.result.response;
  } else if (aiResult?.generations?.[0]?.text) {
    raw = aiResult.generations[0].text;
  } else {
    // Return the raw shape so user can debug
    return Response.json({
      error: `Unexpected AI response shape: ${JSON.stringify(aiResult).slice(0, 200)}`
    }, { status: 500 });
  }

  raw = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (!raw) {
    return Response.json({ error: 'Model returned empty text' }, { status: 500 });
  }

  // Find first { or [
  const fBrace   = raw.indexOf('{');
  const fBracket = raw.indexOf('[');
  let start = -1;
  if      (fBrace === -1 && fBracket === -1) start = -1;
  else if (fBrace === -1)                    start = fBracket;
  else if (fBracket === -1)                  start = fBrace;
  else                                       start = Math.min(fBrace, fBracket);

  if (start === -1) {
    // Return exactly what model said so frontend can show it for debugging
    return Response.json({
      error: `Model did not return JSON. Got: "${raw.slice(0, 300)}"`
    }, { status: 500 });
  }

  const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
  let jsonStr = repairJSON(raw.slice(start, end + 1));

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    const posts = extractFallback(raw);
    if (posts.length > 0) return Response.json({ posts });
    return Response.json({
      error: `JSON parse failed. Model returned: "${raw.slice(0, 300)}"`
    }, { status: 500 });
  }

  const posts = Array.isArray(parsed) ? parsed : (parsed.posts || []);
  if (!posts.length) {
    return Response.json({ error: 'Posts array is empty. Try again.' }, { status: 500 });
  }

  return Response.json({ posts });
}

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

function extractFallback(raw) {
  const posts = [];
  const re = /"title"\s*:\s*"([^"]+)"[^}]*?"content"\s*:\s*(\[[^\]]+\])/gs;
  let m;
  while ((m = re.exec(raw)) !== null) {
    try { posts.push({ title: m[1], content: JSON.parse(m[2]) }); } catch (_) {}
  }
  return posts;
}
