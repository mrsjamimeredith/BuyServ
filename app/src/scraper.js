// Simple Open Graph / product page scraper: paste a URL, extract title/image/description.
// Uses regex parsing for zero-dep, accept-some-false-negatives tradeoff.

async function fetchHtml(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; BuyServBot/1.0; +https://buyserv.local)',
      Accept: 'text/html,application/xhtml+xml'
    }
  });
  if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/html') && !ct.includes('xml')) {
    throw new Error(`Not HTML (${ct})`);
  }
  const text = await res.text();
  return text.slice(0, 1_500_000); // cap to 1.5MB
}

function extractMeta(html, names) {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*['"]${name}['"][^>]+content\\s*=\\s*['"]([^'"]+)['"]`,
      'i'
    );
    const m = html.match(re);
    if (m) return decodeEntities(m[1].trim());
    const re2 = new RegExp(
      `<meta[^>]+content\\s*=\\s*['"]([^'"]+)['"][^>]+(?:property|name)\\s*=\\s*['"]${name}['"]`,
      'i'
    );
    const m2 = html.match(re2);
    if (m2) return decodeEntities(m2[1].trim());
  }
  return null;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function extractTitle(html) {
  const t = extractMeta(html, ['og:title', 'twitter:title']);
  if (t) return t;
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? decodeEntities(m[1].trim()) : null;
}

function extractImage(html, baseUrl) {
  const img = extractMeta(html, ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src']);
  if (!img) return null;
  try { return new URL(img, baseUrl).toString(); } catch { return img; }
}

function extractDescription(html) {
  return extractMeta(html, ['og:description', 'twitter:description', 'description']);
}

async function scrape(url) {
  const html = await fetchHtml(url);
  return {
    url,
    title: extractTitle(html),
    image_url: extractImage(html, url),
    description: extractDescription(html)
  };
}

module.exports = { scrape };
