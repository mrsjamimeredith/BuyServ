const { test } = require('node:test');
const assert = require('node:assert');
const { hasDisclosure, addDisclosure, validateProduct } = require('../src/compliance');

test('hasDisclosure detects #affiliate and #ad', () => {
  assert.strictEqual(hasDisclosure('great product #affiliate'), true);
  assert.strictEqual(hasDisclosure('Sponsored post #AD'), true);
  assert.strictEqual(hasDisclosure('mmkay #Affiliate link'), true);
  assert.strictEqual(hasDisclosure('no tags here'), false);
  assert.strictEqual(hasDisclosure(''), false);
  assert.strictEqual(hasDisclosure(null), false);
});

test('addDisclosure appends tags when missing and leaves them when present', () => {
  assert.ok(addDisclosure('hello').includes('#affiliate'));
  assert.ok(addDisclosure('hello').includes('#ad'));
  const already = 'I already have #affiliate';
  assert.strictEqual(addDisclosure(already), already);
});

test('addDisclosure respects Pinterest 500-char cap', () => {
  const long = 'x'.repeat(495);
  const out = addDisclosure(long);
  assert.ok(out.length <= 500);
});

test('validateProduct rejects invalid products', () => {
  assert.deepStrictEqual(validateProduct({ title: '', image_url: 'x', affiliate_url: 'https://a' }).length > 0, true);
  assert.deepStrictEqual(validateProduct({ title: 'Hello', image_url: 'x', affiliate_url: 'ftp://no' }).length > 0, true);
  assert.deepStrictEqual(validateProduct({ title: 'Hello', affiliate_url: 'https://a' }).length > 0, true);
  const ok = validateProduct({ title: 'Hello there', image_url: 'https://a/img.jpg', affiliate_url: 'https://a' });
  assert.deepStrictEqual(ok, []);
});
