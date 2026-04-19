// Amazon Product Advertising API v5 client.
// Uses AWS SigV4 signing. Credentials are per-deployment, stored encrypted in settings.
//
// Note on API access: Amazon grants PA-API keys to Associates only after they've
// made 3 qualifying sales within 180 days. If you don't have keys yet, use the
// generic URL scraper + your Associate tag on the affiliate_url.

const crypto = require('crypto');
const db = require('./db');
const { encrypt, decrypt } = require('./crypto');

// Region hosts for marketplace → (host, region)
const MARKETPLACES = {
  'www.amazon.com':    { host: 'webservices.amazon.com',    region: 'us-east-1' },
  'www.amazon.co.uk':  { host: 'webservices.amazon.co.uk',  region: 'eu-west-1' },
  'www.amazon.de':     { host: 'webservices.amazon.de',     region: 'eu-west-1' },
  'www.amazon.fr':     { host: 'webservices.amazon.fr',     region: 'eu-west-1' },
  'www.amazon.it':     { host: 'webservices.amazon.it',     region: 'eu-west-1' },
  'www.amazon.es':     { host: 'webservices.amazon.es',     region: 'eu-west-1' },
  'www.amazon.ca':     { host: 'webservices.amazon.ca',     region: 'us-east-1' },
  'www.amazon.com.au': { host: 'webservices.amazon.com.au', region: 'us-west-2' },
  'www.amazon.co.jp':  { host: 'webservices.amazon.co.jp',  region: 'us-west-2' },
  'www.amazon.in':     { host: 'webservices.amazon.in',     region: 'eu-west-1' },
  'www.amazon.com.mx': { host: 'webservices.amazon.com.mx', region: 'us-east-1' }
};

const SERVICE = 'ProductAdvertisingAPI';
const RESOURCES = [
  'Images.Primary.Large',
  'Images.Primary.Medium',
  'Images.Variants.Large',
  'ItemInfo.Title',
  'ItemInfo.Features',
  'ItemInfo.ByLineInfo',
  'Offers.Listings.Price',
  'Offers.Summaries.LowestPrice',
  'BrowseNodeInfo.BrowseNodes',
  'ItemInfo.ProductInfo'
];

// ---------- Credentials ----------
function getCreds() {
  const v = db.getSetting('amazon_credentials');
  if (!v) return null;
  try { return JSON.parse(decrypt(v)); }
  catch { return null; }
}

function saveCreds({ access_key, secret_key, associate_tag, marketplace }) {
  if (!access_key || !secret_key || !associate_tag) throw new Error('access_key, secret_key, associate_tag required');
  marketplace = marketplace || 'www.amazon.com';
  if (!MARKETPLACES[marketplace]) throw new Error(`Unsupported marketplace: ${marketplace}`);
  db.setSetting('amazon_credentials', encrypt(JSON.stringify({
    access_key, secret_key, associate_tag, marketplace
  })));
}

function clearCreds() { db.setSetting('amazon_credentials', null); }

function isConfigured() { return !!getCreds(); }

// ---------- AWS SigV4 ----------
function hex(buf) { return Buffer.from(buf).toString('hex'); }
function sha256(data) { return crypto.createHash('sha256').update(data).digest(); }
function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }

function amzDate() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return { amz: `${date}T${time}Z`, date };
}

function signingKey(secret, date, region, service) {
  const kDate = hmac('AWS4' + secret, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

async function call(operation, payload) {
  const creds = getCreds();
  if (!creds) throw new Error('Amazon credentials not configured');
  const mp = MARKETPLACES[creds.marketplace] || MARKETPLACES['www.amazon.com'];
  const { host, region } = mp;
  const path = '/paapi5/' + operation.toLowerCase();
  const url = `https://${host}${path}`;
  const body = JSON.stringify({
    ...payload,
    PartnerTag: creds.associate_tag,
    PartnerType: 'Associates',
    Marketplace: creds.marketplace
  });
  const { amz, date } = amzDate();
  const target = `com.amazon.paapi5.v1.ProductAdvertisingAPIv1.${operation}`;

  const canonicalHeaders =
    `content-encoding:amz-1.0\n` +
    `content-type:application/json; charset=utf-8\n` +
    `host:${host}\n` +
    `x-amz-date:${amz}\n` +
    `x-amz-target:${target}\n`;
  const signedHeaders = 'content-encoding;content-type;host;x-amz-date;x-amz-target';
  const payloadHash = hex(sha256(body));
  const canonicalRequest = ['POST', path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amz, scope, hex(sha256(canonicalRequest))].join('\n');
  const key = signingKey(creds.secret_key, date, region, SERVICE);
  const signature = hex(hmac(key, stringToSign));
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${creds.access_key}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'amz-1.0',
      'Content-Type': 'application/json; charset=utf-8',
      'Host': host,
      'X-Amz-Date': amz,
      'X-Amz-Target': target,
      'Authorization': authorization
    },
    body
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = data?.Errors?.[0] || data?.__type || data?.raw || res.statusText;
    const msg = typeof err === 'string' ? err : (err?.Message || JSON.stringify(err));
    throw new Error(`Amazon PA-API ${res.status}: ${msg}`);
  }
  return data;
}

// ---------- Product shape ----------
function normalizeItem(item, associateTag, marketplace) {
  const asin = item.ASIN;
  const title = item.ItemInfo?.Title?.DisplayValue || '';
  const features = item.ItemInfo?.Features?.DisplayValues || [];
  const description = features.slice(0, 3).join(' ');
  const image = item.Images?.Primary?.Large?.URL || item.Images?.Primary?.Medium?.URL;
  const priceInfo = item.Offers?.Listings?.[0]?.Price || item.Offers?.Summaries?.[0]?.LowestPrice;
  const price = priceInfo?.DisplayAmount || null;
  const detail = item.DetailPageURL;
  const url = detail
    ? addTag(detail, associateTag)
    : `https://${marketplace}/dp/${asin}?tag=${encodeURIComponent(associateTag)}`;
  return { asin, title, description, image_url: image, price, url };
}

function addTag(url, tag) {
  if (!tag) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('tag', tag);
    return u.toString();
  } catch { return url + (url.includes('?') ? '&' : '?') + 'tag=' + encodeURIComponent(tag); }
}

// ---------- Public operations ----------
async function searchItems(keywords, { itemCount = 10, itemPage = 1, searchIndex = 'All' } = {}) {
  const creds = getCreds();
  if (!creds) throw new Error('Amazon credentials not configured');
  const data = await call('SearchItems', {
    Keywords: keywords,
    SearchIndex: searchIndex,
    ItemCount: Math.max(1, Math.min(10, itemCount)),
    ItemPage: itemPage,
    Resources: RESOURCES
  });
  const items = data?.SearchResult?.Items || [];
  return items.map(it => normalizeItem(it, creds.associate_tag, creds.marketplace));
}

async function getItems(asins) {
  const creds = getCreds();
  if (!creds) throw new Error('Amazon credentials not configured');
  if (!Array.isArray(asins) || !asins.length) throw new Error('asins required');
  const data = await call('GetItems', {
    ItemIds: asins.slice(0, 10),
    Resources: RESOURCES
  });
  const items = data?.ItemsResult?.Items || [];
  return items.map(it => normalizeItem(it, creds.associate_tag, creds.marketplace));
}

async function test() {
  const r = await searchItems('coffee mug', { itemCount: 1 });
  return r.length > 0 ? { ok: true, sample: r[0] } : { ok: false, error: 'empty result' };
}

module.exports = {
  isConfigured, getCreds, saveCreds, clearCreds,
  searchItems, getItems, test,
  MARKETPLACES
};
