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

    // ── AI: parse text into structured posts, with bold markers ──
    const prompt = `Return ONLY valid JSON. No explanation. No markdown. No code fences.

Your job: split the input into separate posts and structure as JSON.
CRITICAL rules:
1. Copy every word, emoji, symbol, and punctuation EXACTLY as-is from the input.
2. Wrap IMPORTANT words in **double asterisks** for bold emphasis. Important = zodiac sign names, key nouns, planet names, numbers/dates, power words like "strength", "success", "love", action verbs at start of bullet points.
3. Do NOT wrap every word — only genuinely important keywords deserve bold.
4. Keep all emojis exactly as they appear in the input.

Output format:
{"posts":[{"title":"first line exactly","content":["line with **bold** words","next line",""]}]}

- title = first line of each post, copied exactly (you may bold key words in title too)
- content = remaining lines, one string per element
- empty lines become "" in content array
- posts are separated by blank lines or clear new topic titles

INPUT:
${text}

JSON:`;

    let aiRaw = '';
    try {
      const r = await env.AI.run(model, { prompt, max_tokens: 4096, temperature: 0.15 });
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
      label:  (posts[0]?.title || 'Session').replace(/\*\*/g,'').trim().slice(0, 80),
      timestamp: ts, template, deviceId, results: [],
    }), { expirationTtl: TTL });

    // ── Respond immediately, then process SVGs in background ──
    const response = json({ jobId, total: posts.length }, 200, H);

    context.waitUntil((async () => {
      const results = [];
      for (let i = 0; i < posts.length; i++) {
        try {
          results.push({
            title:   (posts[i].title   || '').replace(/\*\*/g,'').trim(),
            content: (posts[i].content || []),
            svg:     generateSVG(posts[i]),
          });
          const cur = await env.KV.get(jobId, { type: 'json' });
          if (!cur) break;
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

// ══════════════════════════════════════════════════════════
// SVG IMAGE GENERATOR
// 1080×1920 SVG, server-side. Supports:
//   • Emoji font stack
//   • CJK (Chinese/Japanese/Korean) character-level wrapping
//   • Bold words via **markers** → SVG tspan font-weight="800"
//   • Hard clip so nothing ever overflows canvas
// ══════════════════════════════════════════════════════════
const EMOJI_FONT = `'Apple Color Emoji','Noto Color Emoji','Segoe UI Emoji','Segoe UI Symbol'`;
const BASE_FONT  = `ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif,${EMOJI_FONT}`;

function generateSVG(post) {
  const W = 1080, H = 1920;
  const PX = 88,  PY = 130;   // horizontal / vertical padding
  const CW = W - PX * 2;      // 904px usable width
  const BOTTOM = H - PY;      // hard bottom boundary (1790)

  const rawTitle   = (post.title   || '').trim();
  const content    = (post.content || []);

  // Clean title (strip ** for length measurement)
  const cleanTitle = rawTitle.replace(/\*\*/g, '');

  // Adaptive sizing — measure visual length (CJK + emoji = wide)
  const totalVisLen = charVisLen(cleanTitle) + charVisLen(content.map(l => l || '').join(''));

  let ts, bs, tlh, blh, gap;
  if      (totalVisLen < 80)  { ts=80; bs=52; tlh=112; blh=76; gap=64; }
  else if (totalVisLen < 150) { ts=72; bs=46; tlh=100; blh=68; gap=56; }
  else if (totalVisLen < 260) { ts=62; bs=41; tlh= 88; blh=60; gap=48; }
  else if (totalVisLen < 420) { ts=54; bs=37; tlh= 76; blh=54; gap=42; }
  else if (totalVisLen < 620) { ts=46; bs=33; tlh= 66; blh=48; gap=36; }
  else if (totalVisLen < 900) { ts=40; bs=29; tlh= 58; blh=42; gap=30; }
  else                        { ts=34; bs=26; tlh= 50; blh=38; gap=26; }

  // CPL = chars per line.
  // Latin: avg glyph ≈ 0.56em. CJK: avg glyph ≈ 1.0em.
  // We measure in "visual units" (CJK/emoji = 2), so 0.56*2 ≈ 1.12em per VU.
  // tCPL/bCPL are in visual units.
  const tCPL = Math.floor(CW / (ts * 0.58));
  const bCPL = Math.floor(CW / (bs * 0.58));

  // Wrap title
  const titleLines = smartWrap(rawTitle, tCPL);

  // Wrap body — preserve empty lines as spacers, parse bold markers
  const bodyLines = [];
  for (const line of content) {
    const raw = line || '';
    if (!raw.replace(/\*\*/g,'').trim()) {
      bodyLines.push({ raw: '', gap: true });
    } else {
      for (const w of smartWrap(raw, bCPL)) {
        bodyLines.push({ raw: w, gap: false });
      }
    }
  }

  // Measure total block height
  const titleH = titleLines.length * tlh;
  const bodyH  = bodyLines.reduce((s, l) => s + (l.gap ? blh * 0.5 : blh), 0);
  const totalH = titleH + (bodyLines.length ? gap + bodyH : 0);

  // Vertically center; if too tall, pin to top padding
  let y = totalH > (H - PY * 2)
    ? PY + ts
    : Math.max(PY + ts, Math.round((H - totalH) / 2) + ts);

  const els = [];

  // ── Title ──
  for (const line of titleLines) {
    if (y > BOTTOM + ts) break;
    els.push(renderTextLine(PX, y, BASE_FONT, ts, 800, '#FFFFFF', line));
    y += tlh;
  }

  // ── Accent bar ──
  if (bodyLines.length) {
    const ay = y + Math.round(gap * 0.28);
    if (ay < BOTTOM) {
      els.push(`<rect x="${PX}" y="${ay}" width="44" height="4" rx="2" fill="rgba(139,92,246,0.75)"/>`);
    }
    y += gap;
  }

  // ── Body ──
  for (const line of bodyLines) {
    if (!line.gap && y > BOTTOM + bs) break;
    if (!line.gap) {
      els.push(renderTextLine(PX, y, BASE_FONT, bs, 400, 'rgba(255,255,255,0.85)', line.raw));
    }
    y += line.gap ? Math.round(blh * 0.5) : blh;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="${W}" y2="${H}" gradientUnits="userSpaceOnUse">
    <stop offset="0%"   stop-color="#06020f"/>
    <stop offset="55%"  stop-color="#080412"/>
    <stop offset="100%" stop-color="#00091a"/>
  </linearGradient>
  <clipPath id="clip"><rect width="${W}" height="${H}"/></clipPath>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<g clip-path="url(#clip)">
${els.join('\n')}
</g>
</svg>`;
}

// ── Render a single text line, supporting **bold** markers ──
// Returns an SVG <text> element string (with <tspan> for bold segments).
function renderTextLine(px, y, fontFamily, fontSize, baseWeight, fill, rawText) {
  const segments = parseBoldSegments(rawText);
  const hasBold  = segments.some(s => s.bold);

  if (!hasBold) {
    // Simple text — no tspan needed
    return `<text x="${px}" y="${y}" font-family="${fontFamily}" font-size="${fontSize}" font-weight="${baseWeight}" fill="${fill}" xml:space="preserve">${xe(rawText.replace(/\*\*/g, ''))}</text>`;
  }

  // Build inline tspan elements for mixed bold/normal
  const tspans = segments.map(seg => {
    const fw  = seg.bold ? 900 : baseWeight;
    const clr = seg.bold ? '#FFFFFF' : fill;
    return `<tspan font-weight="${fw}" fill="${clr}">${xe(seg.t)}</tspan>`;
  }).join('');

  return `<text x="${px}" y="${y}" font-family="${fontFamily}" font-size="${fontSize}" font-weight="${baseWeight}" fill="${fill}" xml:space="preserve">${tspans}</text>`;
}

// ── Parse **bold** markers into segments ──
function parseBoldSegments(text) {
  const segs = [];
  const re   = /\*\*(.*?)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segs.push({ t: text.slice(last, m.index), bold: false });
    if (m[1]) segs.push({ t: m[1], bold: true });
    last = re.lastIndex;
  }
  if (last < text.length) segs.push({ t: text.slice(last), bold: false });
  return segs.filter(s => s.t);
}

// ── Visual character length (CJK + emoji = 2 units each) ──
function charVisLen(str) {
  let n = 0;
  for (const ch of [...(str || '')]) {
    n += isWide(ch) ? 2 : 1;
  }
  return n;
}

// Returns true if a character is "wide" (CJK, emoji, fullwidth)
function isWide(ch) {
  const cp = ch.codePointAt(0);
  return (
    // Emoji & symbols
    (cp >= 0x1F000) ||
    (cp >= 0x2600 && cp <= 0x27FF) ||
    (cp >= 0xFE00 && cp <= 0xFE0F) ||
    // CJK Unified Ideographs (most Chinese characters)
    (cp >= 0x4E00 && cp <= 0x9FFF) ||
    // CJK Extension A
    (cp >= 0x3400 && cp <= 0x4DBF) ||
    // CJK Extension B–F
    (cp >= 0x20000 && cp <= 0x2FA1F) ||
    // Hiragana + Katakana (Japanese)
    (cp >= 0x3040 && cp <= 0x30FF) ||
    // Korean Hangul
    (cp >= 0xAC00 && cp <= 0xD7AF) ||
    (cp >= 0x1100 && cp <= 0x11FF) ||
    // Fullwidth forms
    (cp >= 0xFF00 && cp <= 0xFFEF) ||
    // CJK Symbols and Punctuation
    (cp >= 0x3000 && cp <= 0x303F) ||
    // Enclosed CJK
    (cp >= 0x3200 && cp <= 0x32FF) ||
    (cp >= 0x3300 && cp <= 0x33FF)
  );
}

// ── Smart word-wrap that handles both Latin (word-boundary) and CJK (char-boundary) ──
// Strips ** markers for length measurement but keeps them in output for bold rendering.
function smartWrap(text, cpl) {
  if (!text) return [''];

  const cleanText = text.replace(/\*\*/g, '');

  // Detect if this line is primarily CJK (no meaningful spaces = CJK/Japanese/Korean)
  const spaceCount = (cleanText.match(/ /g) || []).length;
  const wideCount  = [...cleanText].filter(isWide).length;
  const isCJK      = wideCount > cleanText.length * 0.3 || (wideCount > 2 && spaceCount < 2);

  if (isCJK) {
    return wrapCJK(text, cpl);
  } else {
    return wrapLatin(text, cpl);
  }
}

// CJK character-level wrap — can break at any character boundary
// Keeps ** markers intact in output
function wrapCJK(text, cpl) {
  const lines = [];
  let curRaw = '', curLen = 0;
  let inBold = false;

  // Iterate characters of the raw text (including ** markers)
  const chars = [...text];
  let i = 0;
  while (i < chars.length) {
    // Detect ** toggle
    if (chars[i] === '*' && chars[i+1] === '*') {
      curRaw += '**';
      inBold = !inBold;
      i += 2;
      continue;
    }

    const ch    = chars[i];
    const chLen = isWide(ch) ? 2 : 1;

    if (curLen + chLen > cpl && curRaw.replace(/\*\*/g,'').length > 0) {
      // Close any open bold before breaking
      if (inBold) curRaw += '**';
      lines.push(curRaw);
      // Open bold again on new line if we were mid-bold
      curRaw = inBold ? '**' + ch : ch;
      curLen = chLen;
    } else {
      curRaw += ch;
      curLen += chLen;
    }
    i++;
  }
  if (curRaw.replace(/\*\*/g,'')) lines.push(curRaw);
  return lines.length ? lines : [''];
}

// Latin word-level wrap — breaks at spaces
// Keeps ** markers intact within words
function wrapLatin(text, cpl) {
  const words  = text.split(' ');
  const lines  = [];
  let cur = '', curLen = 0;

  for (const word of words) {
    const cleanWord = word.replace(/\*\*/g, '');
    const wLen = charVisLen(cleanWord);
    const sep  = cur ? 1 : 0;

    if (curLen + sep + wLen > cpl && cur) {
      lines.push(cur);
      cur    = word;
      curLen = wLen;
    } else {
      cur    = cur ? `${cur} ${word}` : word;
      curLen += sep + wLen;
    }
  }

  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

// ── XML/SVG escape (no ** markers should reach here) ──
function xe(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Legacy alias
function x(s) { return xe(s); }

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
