// ═══════════════════════════════════════════════════════════
// LUMA — Cloudflare Pages Functions
// Bindings required:
//   AI               → Workers AI
//   KV               → KV Namespace
//   GOOGLE_CLIENT_ID → Secret (Environment Variable)
//   GITHUB_TOKEN     → Secret — Personal Access Token (repo scope)
//   GITHUB_REPO      → Secret — "username/repo-name"
//   KAGGLE_DATASET   → Secret — "username/dataset-name"
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
  // POST /api  →  AI parses text → job → SVGs in background
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

    // ── AI prompt ──
    const prompt = `Return ONLY valid JSON. No explanation. No markdown. No code fences.

Task: Split the input into separate posts and structure as JSON.

CRITICAL RULES — follow exactly:
1. REMOVE any post/section numbering from titles. Examples to strip:
   - "1. Aries" → title becomes "Aries"
   - "Post 1: Cancer" → title becomes "Cancer"
   - "第一：白羊座" → title becomes "白羊座"
   - "1)" / "1:" / "(1)" prefix → strip it entirely
   The number is a reference marker, NOT part of the title.

2. Copy every word, emoji, symbol, punctuation from the input EXACTLY — no changes, no additions.

3. Wrap IMPORTANT words in **double asterisks** for bold:
   - Zodiac sign names (Aries, Taurus, Gemini, Cancer, Leo, Virgo, Libra, Scorpio, Sagittarius, Capricorn, Aquarius, Pisces and Chinese equivalents like 白羊座, 金牛座 etc.)
   - Planet names (Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune)
   - Key power words: strength, love, success, wealth, abundance, growth, clarity
   - Numbers/dates that are significant
   Do NOT bold every word — only genuinely important keywords.

4. Keep all emojis exactly as they appear.

Output format (no other text):
{"posts":[{"title":"actual title without numbering","content":["line with **bold** words","next line",""]}]}

Rules:
- title = first meaningful line of each post, with numbering stripped
- content = all remaining lines, one string per element, empty lines become ""
- Posts are separated by blank lines or new numbered sections

INPUT:
${text}

JSON:`;

    let aiRaw = '';
    try {
      const r = await env.AI.run(model, { prompt, max_tokens: 4096, temperature: 0.1 });
      if      (typeof r === 'string') aiRaw = r;
      else if (r?.response)           aiRaw = r.response;
      else if (r?.result?.response)   aiRaw = r.result.response;
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

    // ── Post-process every post ──
    // 1. Strip any remaining post numbers the AI missed
    // 2. Auto-bold zodiac signs missed by the AI
    posts = posts.map(p => ({
      title:   ensureZodiacBold(stripPostNumber(p.title || '')),
      content: (p.content || []).map(line =>
        line ? ensureZodiacBold(line) : line
      ),
    }));

    // ── Create job record in KV ──
    const ts    = Date.now();
    const jobId = `job:${deviceId}:${template}:${ts}`;
    const cleanLabel = cleanText(posts[0]?.title || 'Session').slice(0, 80);

    await env.KV.put(jobId, JSON.stringify({
      status: 'processing', total: posts.length, done: 0,
      label:  cleanLabel,
      timestamp: ts, template, deviceId, results: [],
    }), { expirationTtl: TTL });

    // ── Respond immediately; render SVGs in background ──
    const response = json({ jobId, total: posts.length }, 200, H);

    context.waitUntil((async () => {
      const results = [];
      for (let i = 0; i < posts.length; i++) {
        try {
          const post = posts[i];
          const cleanTitle = cleanText(post.title);
          results.push({
            title:   cleanTitle,   // plain text title, always stored
            content: post.content,
            svg:     generateSVG(post),
          });
          const cur = await env.KV.get(jobId, { type: 'json' });
          if (!cur) break; // deleted mid-process
          await env.KV.put(jobId, JSON.stringify({
            ...cur,
            done:    i + 1,
            total:   posts.length,  // always keep total correct
            results,
            status:  i === posts.length - 1 ? 'done' : 'processing',
          }), { expirationTtl: TTL });
        } catch(err) {
          console.error(`SVG gen error post ${i}:`, err.message);
        }
      }
    })());

    return response;
  }

  // ═══════════════════════════════════════════════════════
  // GET /api/job?jobId=x
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
  // POST /api/video  →  Create video render job → trigger GitHub Actions
  // ═══════════════════════════════════════════════════════
  if (path === '/api/video' && method === 'POST') {
    if (!env.KV)           return json({ error: 'KV binding missing' }, 500, H);
    if (!env.GITHUB_TOKEN) return json({ error: 'GITHUB_TOKEN secret missing' }, 500, H);
    if (!env.GITHUB_REPO)  return json({ error: 'GITHUB_REPO secret missing' }, 500, H);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'Invalid JSON body' }, 400, H); }

    const text     = (body.text     || '').trim();
    const duration = parseInt(body.duration || 30, 10);
    const deviceId = (body.deviceId || '').trim();

    if (!text)     return json({ error: 'No text provided' }, 400, H);
    if (!deviceId) return json({ error: 'Not signed in' }, 401, H);
    if (duration < 5 || duration > 300) return json({ error: 'Duration must be 5–300 seconds' }, 400, H);

    const ts    = Date.now();
    const jobId = `job:${deviceId}:vidgen:${ts}`;
    const label = text.slice(0, 80);

    // Store job in KV immediately
    await env.KV.put(jobId, JSON.stringify({
      status: 'processing', total: 1, done: 0,
      label, timestamp: ts, template: 'vidgen', deviceId,
      results: [], videoUrl: null,
    }), { expirationTtl: TTL });

    // Trigger GitHub Actions workflow
    const [owner, repo] = (env.GITHUB_REPO || '/').split('/');
    const ghPayload = {
      event_type: 'render-video',
      client_payload: {
        jobId,
        overlayText: text.slice(0, 200),
        duration,
        kaggleDataset: env.KAGGLE_DATASET || '',
      },
    };

    try {
      const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify(ghPayload),
      });

      if (!ghRes.ok) {
        const errText = await ghRes.text();
        // Mark job failed in KV
        await env.KV.put(jobId, JSON.stringify({
          status: 'error', total: 1, done: 0,
          label, timestamp: ts, template: 'vidgen', deviceId,
          results: [], videoUrl: null,
          error: `GitHub trigger failed: ${ghRes.status} ${errText.slice(0, 200)}`,
        }), { expirationTtl: TTL });
        return json({ error: `Failed to trigger render: ${ghRes.status} | token_starts: ${env.GITHUB_TOKEN?.slice(0,10)} | repo: ${env.GITHUB_REPO} | detail: ${errText.slice(0,300)}` }, 500, H);
      }
    } catch(e) {
      await env.KV.put(jobId, JSON.stringify({
        status: 'error', total: 1, done: 0,
        label, timestamp: ts, template: 'vidgen', deviceId,
        results: [], videoUrl: null, error: e.message,
      }), { expirationTtl: TTL });
      return json({ error: `GitHub trigger error: ${e.message}` }, 500, H);
    }

    return json({ jobId, total: 1 }, 200, H);
  }

  // ═══════════════════════════════════════════════════════
  // /history
  // ═══════════════════════════════════════════════════════
  if (path === '/history') {
    if (!env.KV) return json({ error: 'KV binding missing' }, 500, H);

    if (method === 'GET') {
      const deviceId = url.searchParams.get('deviceId');
      const template = url.searchParams.get('template') || 'imggen';
      if (!deviceId) return json({ error: 'No deviceId' }, 400, H);
      try {
        const list     = await env.KV.list({ prefix: `job:${deviceId}:${template}:` });
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
  // GET /config
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
// TEXT HELPERS
// ══════════════════════════════════════════════════════════

// Strip leading post numbers: "1.", "1:", "1)", "(1)", "Post 1:", "第一：" etc.
function stripPostNumber(title) {
  return (title || '')
    .replace(/^\s*(?:post\s*)?\d+\s*[.:\)]\s*/i, '')   // 1. / 1: / 1) / Post 1:
    .replace(/^\s*\(\d+\)\s*/,                '')        // (1)
    .replace(/^\s*第\s*[\d一二三四五六七八九十百]+\s*[：:条篇部张节]\s*/i, '') // 第一：
    .replace(/^\s*#+\s*/,                      '')        // ## markdown headings
    .trim();
}

// Remove ** markers to get plain text
function cleanText(t) {
  return (t || '').replace(/\*\*/g, '').trim();
}

// All zodiac signs (English + Chinese + Japanese + Spanish)
const ZODIAC_RE = /(?<!\*\*)(白羊座|牡羊座|金牛座|雙子座|双子座|巨蟹座|獅子座|狮子座|處女座|处女座|天秤座|天蠍座|天蝎座|射手座|摩羯座|水瓶座|雙魚座|双鱼座|牡牛座|蟹座|乙女座|蠍座|山羊座|魚座|Aries|Taurus|Gemini|Cancer|Leo|Virgo|Libra|Scorpio|Sagittarius|Capricorn|Aquarius|Pisces|Ario|Tauro|Géminis|Cáncer|Virgo|Escorpio|Sagitario|Capricornio|Acuario|Piscis)(?!\*\*)/gi;

// Ensure zodiac names are bolded (idempotent — won't double-bold)
function ensureZodiacBold(text) {
  if (!text) return text;
  return text.replace(ZODIAC_RE, '**$1**');
}

// ══════════════════════════════════════════════════════════
// SVG IMAGE GENERATOR
// 1080×1920 — server-side, no browser needed
// Features: emoji fonts, CJK char-wrap, bold tspan, clip overflow
// ══════════════════════════════════════════════════════════
const EMOJI_FONT = `'Apple Color Emoji','Noto Color Emoji','Segoe UI Emoji','Segoe UI Symbol'`;
const BASE_FONT  = `ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif,${EMOJI_FONT}`;

function generateSVG(post) {
  const W = 1080, H = 1920;
  // PX = 110px ≈ visually 3-4cm margin on a standard phone display
  const PX = 110, PY = 130;
  const CW     = W - PX * 2;   // 860px usable width
  const BOTTOM = H - PY;       // 1790 — hard floor

  const rawTitle = (post.title   || '').trim();
  const content  = (post.content || []);
  const plainT   = cleanText(rawTitle);

  // Adaptive sizing — all font sizes increased 20% from previous values
  const visLen = charVisLen(plainT) + charVisLen(content.map(l => cleanText(l||'')).join(''));
  let ts, bs, tlh, blh, gap;
  if      (visLen < 80)  { ts=96; bs=62; tlh=134; blh=90; gap=76; }
  else if (visLen < 150) { ts=86; bs=55; tlh=120; blh=82; gap=68; }
  else if (visLen < 260) { ts=74; bs=49; tlh=104; blh=72; gap=58; }
  else if (visLen < 420) { ts=65; bs=44; tlh= 92; blh=64; gap=50; }
  else if (visLen < 620) { ts=55; bs=40; tlh= 80; blh=58; gap=44; }
  else if (visLen < 900) { ts=48; bs=35; tlh= 70; blh=50; gap=36; }
  else                   { ts=41; bs=31; tlh= 60; blh=44; gap=32; }

  // CPL in visual units.
  // Factor 0.50 = accurate for CJK (each CJK char = 1em wide, counted as 2 visual units → 0.5px per VU).
  // For Latin at ~0.52em avg glyph: factor 0.50 fills lines to the margin without overflowing.
  // This ensures text reaches the right margin edge rather than wrapping too early.
  const tCPL = Math.floor(CW / (ts * 0.50));
  const bCPL = Math.floor(CW / (bs * 0.50));

  // Wrap title
  const titleLines = smartWrap(rawTitle, tCPL);

  // Wrap body
  const bodyLines = [];
  for (const line of content) {
    const raw = line || '';
    if (!cleanText(raw)) {
      bodyLines.push({ raw: '', gap: true });
    } else {
      for (const w of smartWrap(raw, bCPL)) bodyLines.push({ raw: w, gap: false });
    }
  }

  // Total height
  const titleH = titleLines.length * tlh;
  const bodyH  = bodyLines.reduce((s, l) => s + (l.gap ? blh * 0.5 : blh), 0);
  const totalH = titleH + (bodyLines.length ? gap + bodyH : 0);

  // Vertical centering
  let y = totalH > (H - PY * 2)
    ? PY + ts
    : Math.max(PY + ts, Math.round((H - totalH) / 2) + ts);

  const els = [];

  // Title
  for (const line of titleLines) {
    if (y > BOTTOM + ts) break;
    els.push(renderLine(PX, y, BASE_FONT, ts, 800, '#FFFFFF', line));
    y += tlh;
  }

  // Accent bar
  if (bodyLines.length) {
    const ay = y + Math.round(gap * 0.28);
    if (ay < BOTTOM) {
      els.push(`<rect x="${PX}" y="${ay}" width="44" height="4" rx="2" fill="rgba(139,92,246,0.75)"/>`);
    }
    y += gap;
  }

  // Body
  for (const line of bodyLines) {
    if (!line.gap && y > BOTTOM + bs) break;
    if (!line.gap) {
      els.push(renderLine(PX, y, BASE_FONT, bs, 400, 'rgba(255,255,255,0.85)', line.raw));
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

// ── Render one text line (supports **bold** tspan) ──────
function renderLine(px, y, ff, fs, fw, fill, rawText) {
  const segs    = parseBold(rawText);
  const hasBold = segs.some(s => s.bold);

  if (!hasBold) {
    return `<text x="${px}" y="${y}" font-family="${ff}" font-size="${fs}" font-weight="${fw}" fill="${fill}" xml:space="preserve">${xe(cleanText(rawText))}</text>`;
  }
  const spans = segs.map(s => {
    const w = s.bold ? 900 : fw;
    const c = s.bold ? '#FFFFFF' : fill;
    return `<tspan font-weight="${w}" fill="${c}">${xe(s.t)}</tspan>`;
  }).join('');
  return `<text x="${px}" y="${y}" font-family="${ff}" font-size="${fs}" font-weight="${fw}" fill="${fill}" xml:space="preserve">${spans}</text>`;
}

// ── Parse **bold** markers into segments ────────────────
function parseBold(text) {
  const segs = [], re = /\*\*(.*?)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segs.push({ t: text.slice(last, m.index), bold: false });
    if (m[1])           segs.push({ t: m[1], bold: true });
    last = re.lastIndex;
  }
  if (last < text.length) segs.push({ t: text.slice(last), bold: false });
  return segs.filter(s => s.t);
}

// ── Visual char length (CJK + emoji = 2) ───────────────
function charVisLen(str) {
  let n = 0;
  for (const ch of [...(str || '')]) n += isWide(ch) ? 2 : 1;
  return n;
}

function isWide(ch) {
  const cp = ch.codePointAt(0);
  return (
    cp >= 0x1F000 ||
    (cp >= 0x2600 && cp <= 0x27FF)  ||
    (cp >= 0xFE00 && cp <= 0xFE0F)  ||
    (cp >= 0x4E00 && cp <= 0x9FFF)  ||  // CJK Unified
    (cp >= 0x3400 && cp <= 0x4DBF)  ||  // CJK Ext A
    (cp >= 0x20000&& cp <= 0x2FA1F) ||  // CJK Ext B-F
    (cp >= 0x3040 && cp <= 0x30FF)  ||  // Hiragana/Katakana
    (cp >= 0xAC00 && cp <= 0xD7AF)  ||  // Korean Hangul
    (cp >= 0x1100 && cp <= 0x11FF)  ||
    (cp >= 0xFF00 && cp <= 0xFFEF)  ||  // Fullwidth
    (cp >= 0x3000 && cp <= 0x303F)  ||  // CJK Symbols
    (cp >= 0x3200 && cp <= 0x33FF)      // Enclosed CJK
  );
}

// ── Smart wrap: CJK char-level, Latin word-level ────────
function smartWrap(text, cpl) {
  if (!text) return [''];
  const plain      = cleanText(text);
  const spaceCount = (plain.match(/ /g) || []).length;
  const wideCount  = [...plain].filter(isWide).length;
  const isCJK      = wideCount > plain.length * 0.3 || (wideCount > 2 && spaceCount < 2);
  return isCJK ? wrapCJK(text, cpl) : wrapLatin(text, cpl);
}

// CJK: break at any char boundary, preserve ** markers
function wrapCJK(text, cpl) {
  const lines = [];
  let curRaw = '', curLen = 0, inBold = false;
  const chars = [...text];
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === '*' && chars[i+1] === '*') {
      curRaw += '**'; inBold = !inBold; i += 2; continue;
    }
    const ch    = chars[i];
    const chLen = isWide(ch) ? 2 : 1;
    if (curLen + chLen > cpl && cleanText(curRaw).length > 0) {
      if (inBold) curRaw += '**';
      lines.push(curRaw);
      curRaw = inBold ? '**' + ch : ch;
      curLen = chLen;
    } else {
      curRaw += ch; curLen += chLen;
    }
    i++;
  }
  if (cleanText(curRaw)) lines.push(curRaw);
  return lines.length ? lines : [''];
}

// Latin: word-level wrap
function wrapLatin(text, cpl) {
  const words = text.split(' ');
  const lines = [];
  let cur = '', curLen = 0;
  for (const word of words) {
    const wLen = charVisLen(cleanText(word));
    const sep  = cur ? 1 : 0;
    if (curLen + sep + wLen > cpl && cur) {
      lines.push(cur); cur = word; curLen = wLen;
    } else {
      cur    = cur ? `${cur} ${word}` : word;
      curLen += sep + wLen;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

// ── XML escape ───────────────────────────────────────────
function xe(s) {
  return (s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── JSON repair ─────────────────────────────────────────
function repairJSON(str) {
  try { JSON.parse(str); return str; } catch {}
  let s = str.replace(/,\s*$/, '');
  let b = 0, br = 0, inS = false, esc = false;
  for (const c of s) {
    if (esc) { esc = false; continue; }
    if (c === '\\' && inS) { esc = true; continue; }
    if (c === '"') { inS = !inS; continue; }
    if (inS) continue;
    if (c === '{') b++; if (c === '}') b--;
    if (c === '[') br++;if (c === ']') br--;
  }
  if (inS) s += '"';
  s = s.replace(/,\s*$/, '');
  while (br-- > 0) s += ']';
  while (b--  > 0) s += '}';
  return s;
}

function extractFallback(raw) {
  const posts = [];
  const re    = /"title"\s*:\s*"([^"]+)"[^}]*?"content"\s*:\s*(\[[^\]]+\])/gs;
  let m;
  while ((m = re.exec(raw)) !== null) {
    try { posts.push({ title: m[1], content: JSON.parse(m[2]) }); } catch {}
  }
  return posts;
}
