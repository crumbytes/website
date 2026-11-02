import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { unavailable } from './errors.js';

const b64 = buffer => buffer.toString('base64');
const unb64 = text => Buffer.from(text, 'base64');

// Holds decrypted values. Printing or serializing one shows nothing useful, so a
// stray log line or JSON response cannot leak the contents.
export class Secret {
  #value;
  constructor(value) { this.#value = value; }
  reveal() { return this.#value; }
  toJSON() { return '[secret]'; }
  toString() { return '[secret]'; }
  [inspect.custom]() { return '[secret]'; }
}

function gcmEncrypt(key, plaintext, aad) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag() };
}

function gcmDecrypt(key, { ciphertext, nonce, tag }, aad) {
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function parseKeks(text) {
  const keys = new Map();
  for (const entry of text.split(',').map(part => part.trim()).filter(Boolean)) {
    const separator = entry.indexOf(':');
    const id = entry.slice(0, separator);
    const key = unb64(entry.slice(separator + 1));
    if (separator < 1 || key.length !== 32) throw new Error('Each key must be id:base64 of 32 bytes');
    keys.set(id, key);
  }
  return keys;
}

// Envelope encryption: each credential gets its own data key, wrapped by a key
// that lives outside the database. The additional data ties the ciphertext to
// its connection, so copying a row onto another connection fails to decrypt.
export function createVault({ storageEnabled, keks, activeKey }) {
  const keys = storageEnabled ? parseKeks(keks) : new Map();
  if (storageEnabled && !keys.has(activeKey)) throw new Error('The active credential key is not configured');
  const aadFor = (connectionId, credentialId) => Buffer.from(`hub:v1:${connectionId}:${credentialId}`);
  return {
    enabled: storageEnabled,
    encrypt(connectionId, credentialId, secretFields) {
      if (!storageEnabled) throw unavailable('Credential storage is turned off for this environment.');
      const aad = aadFor(connectionId, credentialId);
      const dek = randomBytes(32);
      const body = gcmEncrypt(dek, Buffer.from(JSON.stringify(secretFields)), aad);
      const wrapped = gcmEncrypt(keys.get(activeKey), dek, aad);
      dek.fill(0);
      return {
        key_id: activeKey,
        wrapped_dek: b64(wrapped.ciphertext),
        dek_nonce: b64(wrapped.nonce),
        dek_tag: b64(wrapped.tag),
        ciphertext: b64(body.ciphertext),
        nonce: b64(body.nonce),
        auth_tag: b64(body.tag)
      };
    },
    rewrap(row) {
      if (!storageEnabled) throw unavailable('Credential storage is turned off for this environment.');
      const old = keys.get(row.key_id);
      if (!old) throw unavailable('The old credential key is not available.');
      const aad = aadFor(row.connection_id,row.id);
      const dek=gcmDecrypt(old,{ciphertext:unb64(row.wrapped_dek),nonce:unb64(row.dek_nonce),tag:unb64(row.dek_tag)},aad);
      try {
        const wrapped=gcmEncrypt(keys.get(activeKey),dek,aad);
        return {key_id:activeKey,wrapped_dek:b64(wrapped.ciphertext),dek_nonce:b64(wrapped.nonce),dek_tag:b64(wrapped.tag)};
      } finally {dek.fill(0);}
    },
    decrypt(row) {
      if (!storageEnabled) throw unavailable('Credential storage is turned off for this environment.');
      const key = keys.get(row.key_id);
      if (!key) throw unavailable('The key for this credential is not available.');
      const aad = aadFor(row.connection_id, row.id);
      const dek = gcmDecrypt(key, { ciphertext: unb64(row.wrapped_dek), nonce: unb64(row.dek_nonce), tag: unb64(row.dek_tag) }, aad);
      const plaintext = gcmDecrypt(dek, { ciphertext: unb64(row.ciphertext), nonce: unb64(row.nonce), tag: unb64(row.auth_tag) }, aad);
      dek.fill(0);
      return new Secret(JSON.parse(plaintext.toString()));
    }
  };
}
