export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { text, model } = await request.json();
    if (!text) return Response.json({ error: 'No text provided' }, { status: 400 });

    const selectedModel = model || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

    const SYSTEM = `You format zodiac post text into JSON. Rules:
1. Split input into separate posts. Each post has a title line then content lines.
2. TITLE: remove ALL emojis, asterisks (*), hash symbols (#). Keep exact wording.
3. CONTENT - check zodiac sign count per line:
   • 1-2 signs: single line with emoji + **BoldName** + colon + text. E.g. "✨ **Aries**, **Taurus**: Your text."
   • 3+ signs: three entries: ["🌟 **Aries**, **Leo**, **Sagittarius**", "🔮 Explanation here.", ""]
4. Every non-empty content line must start with an emoji. Remove all # symbols. Do NOT rewrite text.
Output ONLY raw JSON with no markdown fences: {"posts":[{"title":"string","content":["string"]}]}`;

    const response = await env.AI.run(selectedModel, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: `Format this:\n\n${text}` }
      ],
      max_tokens: 2048,
      temperature: 0.2
    });

    const raw   = (response?.response || '').replace(/```json|```/g, '').trim();
    const start = Math.min(...[raw.indexOf('{'), raw.indexOf('[')].filter(i => i >= 0));
    const end   = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));

    if (start === Infinity || end === -1) {
      return Response.json({ error: 'Model returned no JSON. Try again.' }, { status: 500 });
    }

    const parsed = JSON.parse(raw.slice(start, end + 1));
    const posts  = Array.isArray(parsed) ? parsed : (parsed.posts || []);

    return Response.json({ posts });

  } catch (e) {
    return Response.json({ error: e.message || 'Unknown error' }, { status: 500 });
  }
}
