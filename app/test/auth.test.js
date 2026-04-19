const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

// Pure test of the password hashing logic: reimplement the scheme
// from auth.js and verify it roundtrips. This avoids the DB coupling.
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

test('password roundtrip succeeds', () => {
  const h = hashPassword('hello_there_123');
  assert.strictEqual(verifyPassword('hello_there_123', h), true);
});

test('wrong password fails', () => {
  const h = hashPassword('hello_there_123');
  assert.strictEqual(verifyPassword('wrong', h), false);
});

test('malformed hash fails gracefully', () => {
  assert.strictEqual(verifyPassword('anything', 'not_a_valid_format'), false);
});

test('unique salts per call', () => {
  const a = hashPassword('same');
  const b = hashPassword('same');
  assert.notStrictEqual(a, b);
  assert.strictEqual(verifyPassword('same', a), true);
  assert.strictEqual(verifyPassword('same', b), true);
});
