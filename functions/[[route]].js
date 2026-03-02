// ═══════════════════════════════════════════════════════════
// LUMA — Cloudflare Pages Functions
// Bindings required:
//   AI              → Workers AI
//   KV              → KV Namespace
//   GOOGLE_CLIENT_ID → Secret (Environment Variable)
// ═══════════════════════════════════════════════════════════

const TTL = 60 * 60 * 24 * 3; // 3 days

export async function onRequest(context) {
  const { request, env } = context;
  const url    = new URL(request.url);
  const path   = url.pathname;
  const method = request.method;
  const H      = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      ...H, 'Access-Control-Allow-Methods': 'GET,POST,DELETE',
      'Access-Control-Allow-Headers': 'Content-Type',
    }});
  }

  // ═══════════════════════════════════════════════════════
  // POST /api  →  AI parses text, creates job, renders SVGs in background
  // ═══════════════════════════════════════════════════════
  if (path === '/api' && method === 'POST') {
    if (!env.AI) return json({ error: 'AI binding missing — name it: AI' }, 500, H);
    if (!env.KV) return json({ error: 'KV binding missing — name it: KV' }, 500, H);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'Invalid JSON body' }, 400, H); }

    const text     = (body.text     || '').trim();
    const model    = body.model     || '@cf/meta/llama-3.1-8b-instruct-fast';
    const deviceId = (body.deviceId || '').trim();
    const template = body.template  || 'imggen';

    if (!text)     return json({ error: 'No text provided' }, 400, H);
    if (!deviceId) return json({ error: 'Not signed in' }, 401, H);

    // ── AI: parse text into structured posts ──
    const prompt = `Return ONLY valid JSON. No explanation. No markdown. No code fences.

Your job: split the input into separate posts and structure as JSON.
CRITICAL: Copy every word, emoji, symbol, and punctuation EXACTLY as-is. Do not change, add, or remove anything.

Output format:
{"posts":[{"title":"exact first line","content":["exact line","exact line",""]}]}

- title = first line of each post, copied exactly
- content = remaining lines, one string per element, copied exactly
- empty lines become "" in content array
- posts separated by blank lines or clear new titles

INPUT:
${text}

JSON:`;

    let aiRaw = '';
    try {
      const r = await env.AI.run(model, { prompt, max_tokens: 4096, temperature: 0.1 });
      if      (typeof r === 'string')   aiRaw = r;
      else if (r?.response)             aiRaw = r.response;
      else if (r?.result?.response)     aiRaw = r.result.response;
      else return json({ error: 'Unexpected AI response shape' }, 500, H);
    } catch(e) {
      return json({ error: `AI error: ${e.message}` }, 500, H);
    }

    aiRaw = aiRaw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```$/i,'').trim();
    const si = aiRaw.indexOf('{'), ei = aiRaw.lastIndexOf('}');
    if (si === -1) return json({ error: `No JSON in AI response. Got: "${aiRaw.slice(0,200)}"` }, 500, H);

    let posts;
    try {
      const p = JSON.parse(repairJSON(aiRaw.slice(si, ei + 1)));
      posts = Array.isArray(p) ? p : (p.posts || []);
    } catch {
      posts = extractFallback(aiRaw);
    }
    if (!posts.length) return json({ error: 'No posts parsed. Try again.' }, 500, H);

    // ── Create job record in KV ──
    const ts    = Date.now();
    const jobId = `job:${deviceId}:${template}:${ts}`;
    await env.KV.put(jobId, JSON.stringify({
      status: 'processing', total: posts.length, done: 0,
      label:  (posts[0]?.title || 'Session').trim().slice(0, 80),
      timestamp: ts, template, deviceId, results: [],
    }), { expirationTtl: TTL });

    // ── Respond immediately, then process SVGs in background ──
    const response = json({ jobId, total: posts.length }, 200, H);

    context.waitUntil((async () => {
      const results = [];
      for (let i = 0; i < posts.length; i++) {
        try {
          results.push({
            title:   (posts[i].title   || '').trim(),
            content: (posts[i].content || []),
            svg:     generateSVG(posts[i]),
          });
          const cur = await env.KV.get(jobId, { type: 'json' });
          if (!cur) break; // deleted while processing
          await env.KV.put(jobId, JSON.stringify({
            ...cur, done: i + 1, results,
            status: i === posts.length - 1 ? 'done' : 'processing',
          }), { expirationTtl: TTL });
        } catch(err) {
          console.error(`SVG gen error post ${i}:`, err.message);
        }
      }
    })());

    return response;
  }

  // ═══════════════════════════════════════════════════════
  // GET /api/job?jobId=x  →  poll job (returns results so far)
  // ═══════════════════════════════════════════════════════
  if (path === '/api/job' && method === 'GET') {
    if (!env.KV) return json({ error: 'KV binding missing' }, 500, H);
    const jobId = url.searchParams.get('jobId');
    if (!jobId) return json({ error: 'No jobId' }, 400, H);
    try {
      const job = await env.KV.get(jobId, { type: 'json' });
      if (!job) return json({ status: 'expired', results: [], done: 0, total: 0 }, 200, H);
      return json(job, 200, H);
    } catch(e) {
      return json({ error: e.message }, 500, H);
    }
  }

  // ═══════════════════════════════════════════════════════
  // /history  →  GET list sessions   DELETE remove session
  // ═══════════════════════════════════════════════════════
  if (path === '/history') {
    if (!env.KV) return json({ error: 'KV binding missing' }, 500, H);

    if (method === 'GET') {
      const deviceId = url.searchParams.get('deviceId');
      const template = url.searchParams.get('template') || 'imggen';
      if (!deviceId) return json({ error: 'No deviceId' }, 400, H);
      try {
        const list = await env.KV.list({ prefix: `job:${deviceId}:${template}:` });
        const sessions = [];
        for (const key of list.keys) {
          try {
            const d = await env.KV.get(key.name, { type: 'json' });
            if (d) sessions.push({
              jobId:     key.name,
              label:     d.label || 'Session',
              total:     d.total || 0,
              done:      d.done  || 0,
              status:    d.status,
              timestamp: d.timestamp,
            });
          } catch {}
        }
        sessions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        return json({ sessions }, 200, H);
      } catch(e) {
        return json({ error: `KV error: ${e.message}` }, 500, H);
      }
    }

    if (method === 'DELETE') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, H); }
      const { jobId } = body;
      if (!jobId) return json({ error: 'No jobId' }, 400, H);
      await env.KV.delete(jobId).catch(() => {});
      return json({ success: true }, 200, H);
    }
  }

  // ═══════════════════════════════════════════════════════
  // GET /config  →  serve Google Client ID from secret
  // ═══════════════════════════════════════════════════════
  if (path === '/config' && method === 'GET') {
    return json({ googleClientId: env.GOOGLE_CLIENT_ID || '' }, 200, H);
  }

  return context.next();
}

// ── JSON helper ─────────────────────────────────────────
function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// ── SVG Image Generator ─────────────────────────────────
// Generates a 1080×1920 SVG entirely server-side.
// No browser needed — stored in KV, served as data URI.
function generateSVG(post) {
  const W = 1080, H = 1920, PX = 92;
  const CW = W - PX * 2; // 896px usable width

  const title   = (post.title   || '').trim();
  const content = (post.content || []);

  // Adaptive font sizing
  const len = title.length + content.join('').length;
  let ts, bs, tlh, blh, gap;
  if      (len < 120) { ts=76; bs=50; tlh=104; blh=72; gap=60; }
  else if (len < 250) { ts=68; bs=45; tlh= 94; blh=66; gap=54; }
  else if (len < 420) { ts=60; bs=40; tlh= 84; blh=58; gap=48; }
  else if (len < 620) { ts=52; bs=36; tlh= 74; blh=52; gap=42; }
  else                { ts=44; bs=32; tlh= 64; blh=46; gap=36; }

  // Chars per line (avg char ≈ 0.54× font size for sans-serif)
  const tCPL = Math.floor(CW / (ts * 0.54));
  const bCPL = Math.floor(CW / (bs * 0.54));

  const titleLines = wrap(title, tCPL);

  const bodyLines = [];
  for (const line of content) {
    if (!(line || '').trim()) {
      bodyLines.push({ t: '', gap: true });
    } else {
      for (const w of wrap(line, bCPL)) bodyLines.push({ t: w, gap: false });
    }
  }

  // Calculate block height → vertical center
  const titleH = titleLines.length * tlh;
  const bodyH  = bodyLines.reduce((s, l) => s + (l.gap ? blh * 0.5 : blh), 0);
  const totalH = titleH + (bodyLines.length ? gap + bodyH : 0);
  let y = Math.max(PX + ts, Math.floor((H - totalH) / 2) + ts);

  const els = [];

  // Title
  for (const line of titleLines) {
    els.push(`<text x="${PX}" y="${y}" font-family="ui-sans-serif,system-ui,-apple-system,sans-serif" font-size="${ts}" font-weight="800" fill="#FFFFFF">${x(line)}</text>`);
    y += tlh;
  }

  // Accent line between title and body
  if (bodyLines.length) {
    els.push(`<rect x="${PX}" y="${y + Math.floor(gap * 0.3)}" width="40" height="3" rx="2" fill="rgba(139,92,246,0.6)"/>`);
    y += gap;
  }

  // Body
  for (const line of bodyLines) {
    if (!line.gap) {
      els.push(`<text x="${PX}" y="${y}" font-family="ui-sans-serif,system-ui,-apple-system,sans-serif" font-size="${bs}" font-weight="400" fill="rgba(255,255,255,0.78)">${x(line.t)}</text>`);
    }
    y += line.gap ? blh * 0.5 : blh;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
<defs>
  <linearGradient id="g" x1="0" y1="0" x2="${W}" y2="${H}" gradientUnits="userSpaceOnUse">
    <stop offset="0%" stop-color="#06020f"/>
    <stop offset="100%" stop-color="#00091a"/>
  </linearGradient>
</defs>
<rect width="${W}" height="${H}" fill="url(#g)"/>
${els.join('\n')}
</svg>`;
}

function wrap(text, cpl) {
  if (!text) return [''];
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const word of words) {
    const test = cur ? `${cur} ${word}` : word;
    if (test.length > cpl && cur) { lines.push(cur); cur = word; }
    else cur = test;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function x(s) { // XML/SVG escape
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function repairJSON(str) {
  try { JSON.parse(str); return str; } catch {}
  let s = str.replace(/,\s*$/, '');
  let b = 0, br = 0, inS = false, esc = false;
  for (const c of s) {
    if (esc) { esc = false; continue; }
    if (c === '\\' && inS) { esc = true; continue; }
    if (c === '"') { inS = !inS; continue; }
    if (inS) continue;
    if (c === '{') b++;  if (c === '}') b--;
    if (c === '[') br++; if (c === ']') br--;
  }
  if (inS) s += '"';
  s = s.replace(/,\s*$/, '');
  while (br-- > 0) s += ']';
  while (b--  > 0) s += '}';
  return s;
}

function extractFallback(raw) {
  const posts = [];
  const re = /"title"\s*:\s*"([^"]+)"[^}]*?"content"\s*:\s*(\[[^\]]+\])/gs;
  let m;
  while ((m = re.exec(raw)) !== null) {
    try { posts.push({ title: m[1], content: JSON.parse(m[2]) }); } catch {}
  }
  return posts;
}
