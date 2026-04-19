const crypto = require('crypto');

// AES-256-GCM encryption of secrets at rest.
// Key derived from SESSION_SECRET via scrypt so a single env var is all you need.

let cachedKey = null;
function key() {
  if (cachedKey) return cachedKey;
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('SESSION_SECRET must be set and at least 16 chars.');
  }
  cachedKey = crypto.scryptSync(secret, 'buyserv-v1', 32);
  return cachedKey;
}

function encrypt(plaintext) {
  if (plaintext == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1:' + Buffer.concat([iv, tag, ct]).toString('base64');
}

function decrypt(payload) {
  if (payload == null) return null;
  if (typeof payload !== 'string' || !payload.startsWith('v1:')) {
    // backward compatibility: treat as plaintext
    return payload;
  }
  const buf = Buffer.from(payload.slice(3), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
