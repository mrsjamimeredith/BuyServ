// FTC + Pinterest guideline helpers.
//
// Pinterest (2024+) allows affiliate links but they must:
//   - link directly to the destination (no cloaking/redirect chains that hide it)
//   - be clearly disclosed (Pinterest defaults to #affiliate; FTC also accepts #ad)
//   - not be repeated across many pins in a spammy way
// https://help.pinterest.com/en/business/article/affiliate-links

const DISCLOSURE_TAGS = ['#affiliate', '#ad'];

function hasDisclosure(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return DISCLOSURE_TAGS.some(tag => lower.includes(tag));
}

function addDisclosure(description) {
  const base = (description || '').trim();
  if (hasDisclosure(base)) return base;
  const suffix = (base ? '\n\n' : '') + '#affiliate #ad';
  return (base + suffix).slice(0, 500);
}

function validateProduct(p) {
  const errs = [];
  if (!p.title || p.title.length < 3) errs.push('Title too short');
  if (p.title && p.title.length > 100) errs.push('Title > 100 chars');
  if (!p.affiliate_url || !/^https?:\/\//i.test(p.affiliate_url)) errs.push('Affiliate URL missing or not http(s)');
  if (!p.image_url && !p.image_data) errs.push('Image required');
  if (p.description && p.description.length > 500) errs.push('Description > 500 chars');
  return errs;
}

module.exports = { hasDisclosure, addDisclosure, validateProduct };
