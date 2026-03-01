// Cloudflare Pages — single catch-all handler
// Bindings needed: AI (Workers AI) + KV (KV Namespace)

const TTL = 60 * 60 * 24 * 3; // 3 days

export async function onRequest(context) {
  const { request, env } = context;
  const url    = new URL(request.url);
  const path   = url.pathname;
  const method = request.method;

  // ── CORS for local dev ──
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  // ════════════════════════════════════════
  // POST /api  →  AI formatting
  // ════════════════════════════════════════
  if (path === '/api' && method === 'POST') {
    if (!env.AI) return json({ error: 'AI binding missing. Add binding variable name: AI' }, 500, headers);

    let text, model;
    try {
      const body = await request.json();
      text  = (body?.text || '').trim();
      model = body?.model || '@cf/meta/llama-3.1-8b-instruct-fast';
    } catch (e) {
      return json({ error: 'Invalid request body' }, 400, headers);
    }

    if (!text) return json({ error: 'No text provided' }, 400, headers);

    const prompt = `You are a JSON formatter. Return ONLY a JSON object. No explanation, no markdown, no code fences.

Format zodiac text into this structure:
{"posts":[{"title":"string","content":["string"]}]}

Rules:
1. Split into separate posts by title
2. Title: remove emojis * # — keep exact words
3. Every content line must start with an emoji
4. Bold zodiac sign names: **Aries**
5. 1-2 signs per line = one line: "✨ **Aries**: explanation"
6. 3+ signs per line = three items: ["🌟 **Aries**, **Leo**, **Virgo**", "🔮 explanation", ""]
7. Remove all # characters from lines

INPUT:
${text}

JSON:`;

    let aiResult;
    try {
      aiResult = await env.AI.run(model, { prompt, max_tokens: 4096, temperature: 0.1 });
    } catch (e) {
      return json({ error: `AI error: ${e.message}` }, 500, headers);
    }

    let raw = '';
    if      (typeof aiResult === 'string')      raw = aiResult;
    else if (aiResult?.response)                raw = aiResult.response;
    else if (aiResult?.result?.response)        raw = aiResult.result.response;
    else if (aiResult?.generations?.[0]?.text)  raw = aiResult.generations[0].text;
    else return json({ error: `Unexpected AI response shape: ${JSON.stringify(aiResult).slice(0,200)}` }, 500, headers);

    raw = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```$/i,'').trim();
    if (!raw) return json({ error: 'Model returned empty response' }, 500, headers);

    const fB = raw.indexOf('{'), fBr = raw.indexOf('[');
    let start = fB === -1 && fBr === -1 ? -1 : fB === -1 ? fBr : fBr === -1 ? fB : Math.min(fB, fBr);
    if (start === -1) return json({ error: `No JSON found. Got: "${raw.slice(0,200)}"` }, 500, headers);

    const end     = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
    const jsonStr = repairJSON(raw.slice(start, end + 1));

    let parsed;
    try { parsed = JSON.parse(jsonStr); }
    catch (e) {
      const posts = extractFallback(raw);
      if (posts.length > 0) return json({ posts }, 200, headers);
      return json({ error: `Parse failed. Model said: "${raw.slice(0,300)}"` }, 500, headers);
    }

    const posts = Array.isArray(parsed) ? parsed : (parsed.posts || []);
    if (!posts.length) return json({ error: 'Empty posts. Try again.' }, 500, headers);
    return json({ posts }, 200, headers);
  }

  // ════════════════════════════════════════
  // GET    /history?deviceId=x  → { sessions }
  // POST   /history             → save session
  // DELETE /history             → delete session
  // ════════════════════════════════════════
  if (path === '/history') {
    if (!env.KV) return json({ error: 'KV binding missing. Add binding variable name: KV' }, 500, headers);

    if (method === 'GET') {
      const deviceId = url.searchParams.get('deviceId');
      if (!deviceId) return json({ error: 'No deviceId provided' }, 400, headers);
      try {
        const list     = await env.KV.list({ prefix: `session:${deviceId}:` });
        const sessions = [];
        for (const key of list.keys) {
          try {
            const data = await env.KV.get(key.name, { type: 'json' });
            if (data) sessions.push({ ...data, key: key.name });
          } catch(e) { /* skip bad entries */ }
        }
        sessions.sort((a, b) => (b.timestamp||0) - (a.timestamp||0));
        return json({ sessions }, 200, headers);
      } catch(e) {
        return json({ error: `KV read failed: ${e.message}` }, 500, headers);
      }
    }

    if (method === 'POST') {
      let body;
      try { body = await request.json(); } catch(e) { return json({ error: 'Invalid JSON body' }, 400, headers); }
      const { deviceId, posts, timestamp, label, count } = body;
      if (!deviceId) return json({ error: 'Missing deviceId' }, 400, headers);
      if (!posts || !Array.isArray(posts) || posts.length === 0) return json({ error: 'Missing or empty posts' }, 400, headers);
      try {
        const ts  = timestamp || Date.now();
        const key = `session:${deviceId}:${ts}`;
        const val = JSON.stringify({ posts, timestamp: ts, label: label || '', count: count || posts.length });
        await env.KV.put(key, val, { expirationTtl: TTL });
        return json({ success: true, key }, 200, headers);
      } catch(e) {
        return json({ error: `KV write failed: ${e.message}` }, 500, headers);
      }
    }

    if (method === 'DELETE') {
      const { key } = await request.json();
      if (!key) return json({ error: 'No key' }, 400, headers);
      await env.KV.delete(key);
      return json({ success: true }, 200, headers);
    }
  }

  // ════════════════════════════════════════
  // GET /config  →  returns public config (Google Client ID from secret)
  // ════════════════════════════════════════
  if (path === '/config' && method === 'GET') {
    return json({
      googleClientId: env.GOOGLE_CLIENT_ID || ''
    }, 200, headers);
  }

  // ── Pass through to static files (index.html etc) ──
  return context.next();
}

// ── Helpers ──
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
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
    if (ch === '{') braces++;   if (ch === '}') braces--;
    if (ch === '[') brackets++; if (ch === ']') brackets--;
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
