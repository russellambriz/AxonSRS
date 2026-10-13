/**
 * Client-side encryption with Web Crypto.
 *
 *   key  = PBKDF2-SHA-256(passphrase, random 16-byte salt, 600 000 iterations)
 *   data = AES-256-GCM(key, fresh random 12-byte IV per encryption, AAD = header)
 *
 * The passphrase and derived key never leave the device and are never
 * written into a Gist, backup or export. Losing the passphrase makes an
 * encrypted payload unrecoverable.
 */

export const KDF_ITERATIONS = 600000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;

export class CryptoError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function subtle() {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new CryptoError('Web Crypto is not available in this browser', 'unsupported');
  return s;
}

export function randomBytes(n) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export async function deriveKey(passphrase, salt, iterations = KDF_ITERATIONS) {
  if (!passphrase) throw new CryptoError('A passphrase is required', 'passphrase-required');
  const material = await subtle().importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptBytes(key, plaintext, aad) {
  const iv = randomBytes(IV_BYTES);
  const params = { name: 'AES-GCM', iv, tagLength: 128 };
  if (aad) params.additionalData = aad;
  const ct = new Uint8Array(await subtle().encrypt(params, key, plaintext));
  return { iv, ciphertext: ct };
}

export async function decryptBytes(key, iv, ciphertext, aad) {
  const params = { name: 'AES-GCM', iv, tagLength: 128 };
  if (aad) params.additionalData = aad;
  try {
    return new Uint8Array(await subtle().decrypt(params, key, ciphertext));
  } catch {
    throw new CryptoError('Decryption failed: the passphrase is incorrect or the data is damaged', 'wrong-passphrase');
  }
}
