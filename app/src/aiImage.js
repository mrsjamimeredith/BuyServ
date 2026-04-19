// Pluggable AI image generator.
// Default provider: OpenAI "gpt-image-1" (works via OPENAI_API_KEY).
//
// Why not Midjourney: Midjourney has no official API. The unofficial
// Discord-scraping "MJ APIs" violate Midjourney's ToS and risk account
// termination. If MJ publishes an official API we can add a provider.

const OPENAI_URL = 'https://api.openai.com/v1/images/generations';

async function generate({ prompt, size = '1024x1536' }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt,
      size,
      n: 1
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`OpenAI image failed: ${data?.error?.message || res.status}`);
  }
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error('No image in response');
  return { data: b64, mime: 'image/png' };
}

function isConfigured() { return !!process.env.OPENAI_API_KEY; }

module.exports = { generate, isConfigured };
