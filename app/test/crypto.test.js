const { test } = require('node:test');
const assert = require('node:assert');

process.env.SESSION_SECRET = 'test_session_secret_long_enough';
const { encrypt, decrypt } = require('../src/crypto');

test('roundtrips plaintext through AES-GCM', () => {
  const secret = 'Pinterest access token abc123';
  const ct = encrypt(secret);
  assert.ok(ct.startsWith('v1:'));
  assert.notStrictEqual(ct, secret);
  assert.strictEqual(decrypt(ct), secret);
});

test('decrypt returns null for null', () => {
  assert.strictEqual(decrypt(null), null);
  assert.strictEqual(encrypt(null), null);
});

test('decrypt passes through plaintext for backward compat', () => {
  assert.strictEqual(decrypt('legacy_plain_token'), 'legacy_plain_token');
});

test('different IVs produce different ciphertexts', () => {
  const a = encrypt('hello');
  const b = encrypt('hello');
  assert.notStrictEqual(a, b);
  assert.strictEqual(decrypt(a), 'hello');
  assert.strictEqual(decrypt(b), 'hello');
});

test('tampered ciphertext fails', () => {
  const ct = encrypt('secret');
  const tampered = 'v1:' + Buffer.from(ct.slice(3), 'base64')
    .map((b, i) => i === 30 ? b ^ 1 : b)
    .toString('base64');
  assert.throws(() => decrypt(tampered));
});
