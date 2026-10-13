/**
 * Versioned payload envelope shared by sync files and backups.
 *
 * Pipeline: JSON → UTF-8 → gzip (optional) → AES-256-GCM (optional) → base64
 * The header records every parameter needed to reverse it. For encrypted
 * envelopes the header is bound to the ciphertext as AES-GCM additional
 * authenticated data, so it cannot be altered without detection.
 */

import { APP_VERSION } from '../../config.js';
import { bytesToBase64, base64ToBytes, stableStringify, sha256Hex } from '../util.js';
import { gzip, gunzip, DEFAULT_MAX_DECOMPRESSED } from './compress.js';
import { deriveKey, encryptBytes, decryptBytes, randomBytes, KDF_ITERATIONS, SALT_BYTES, CryptoError } from './crypto.js';

export const ENVELOPE_VERSION = 1;
export const MAX_ENVELOPE_CHARS = 64 * 1024 * 1024;

export class EnvelopeError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * Keyring: a derived key plus the salt/iteration parameters it came from.
 * The salt is stored in every envelope header; the key never is.
 */
export async function createKeyring(passphrase, { salt = randomBytes(SALT_BYTES), iterations = KDF_ITERATIONS } = {}) {
  return { key: await deriveKey(passphrase, salt, iterations), salt, iterations };
}

function headerAad(header) {
  return new TextEncoder().encode(stableStringify(header));
}

/**
 * @param {object} value JSON-serialisable payload
 * @param {object} opts { format, compress=true, keyring=null, deviceId, compressionImpl }
 */
export async function seal(value, { format, compress = true, keyring = null, deviceId = null, compressionImpl = 'auto' } = {}) {
  const json = JSON.stringify(value);
  const plain = new TextEncoder().encode(json);
  let bytes = plain;
  let compression = 'none';
  let impl = null;
  if (compress) {
    const z = await gzip(plain, { implementation: compressionImpl });
    bytes = z.bytes;
    compression = 'gzip';
    impl = z.implementation;
  }
  const header = {
    format,
    envelope: ENVELOPE_VERSION,
    compression,
    encryption: keyring
      ? { alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA-256', iterations: keyring.iterations, salt: bytesToBase64(keyring.salt) }
      : null,
  };
  const envelope = {
    ...header,
    app: APP_VERSION,
    createdAt: Date.now(),
    deviceId,
    compressionImpl: impl,
    sizes: { plain: plain.length, compressed: compression === 'gzip' ? bytes.length : null },
  };
  if (keyring) {
    const { iv, ciphertext } = await encryptBytes(keyring.key, bytes, headerAad(header));
    envelope.iv = bytesToBase64(iv);
    envelope.payload = bytesToBase64(ciphertext);
  } else {
    envelope.sha256 = await sha256Hex(plain);
    envelope.payload = compression === 'gzip' ? bytesToBase64(bytes) : json;
  }
  envelope.sizes.sealed = envelope.payload.length;
  return envelope;
}

export function isEnvelope(obj) {
  return !!obj && typeof obj === 'object' && typeof obj.format === 'string' && obj.envelope != null && 'payload' in obj;
}

/**
 * @param {object} envelope
 * @param {object} opts { passphrase, keyring, maxBytes, expectedFormat }
 */
export async function open(envelope, { passphrase = null, keyring = null, maxBytes = DEFAULT_MAX_DECOMPRESSED, expectedFormat = null } = {}) {
  if (!isEnvelope(envelope)) throw new EnvelopeError('Not an Axon payload', 'format');
  if (expectedFormat && envelope.format !== expectedFormat) throw new EnvelopeError(`Expected ${expectedFormat}, found ${envelope.format}`, 'format');
  if (envelope.envelope > ENVELOPE_VERSION) throw new EnvelopeError('This payload was written by a newer version of Axon; update the app to read it', 'version-unsupported');
  if (typeof envelope.payload !== 'string' || envelope.payload.length > MAX_ENVELOPE_CHARS) throw new EnvelopeError('Payload is missing or too large', 'too-large');
  const header = { format: envelope.format, envelope: envelope.envelope, compression: envelope.compression, encryption: envelope.encryption };
  let bytes;
  if (envelope.encryption) {
    const enc = envelope.encryption;
    if (enc.alg !== 'AES-256-GCM' || enc.kdf !== 'PBKDF2-SHA-256') throw new EnvelopeError('Unsupported encryption parameters', 'version-unsupported');
    let key = null;
    if (keyring && bytesToBase64(keyring.salt) === enc.salt && keyring.iterations === enc.iterations) key = keyring.key;
    else if (passphrase) key = await deriveKey(passphrase, base64ToBytes(enc.salt), enc.iterations);
    else throw new EnvelopeError('This data is encrypted; enter the passphrase', 'passphrase-required');
    try {
      bytes = await decryptBytes(key, base64ToBytes(envelope.iv), base64ToBytes(envelope.payload), headerAad(header));
    } catch (err) {
      if (err instanceof CryptoError) throw new EnvelopeError(err.message, 'wrong-passphrase');
      throw err;
    }
  } else if (envelope.compression === 'gzip') {
    bytes = base64ToBytes(envelope.payload);
  } else {
    bytes = new TextEncoder().encode(envelope.payload);
  }
  let plain = bytes;
  if (envelope.compression === 'gzip') {
    try {
      plain = await gunzip(bytes, { maxBytes });
    } catch (err) {
      throw new EnvelopeError(err.message, err.code === 'too-large' ? 'too-large' : 'corrupt');
    }
  } else if (envelope.compression !== 'none') {
    throw new EnvelopeError(`Unknown compression ${envelope.compression}`, 'version-unsupported');
  }
  if (plain.length > maxBytes) throw new EnvelopeError('Payload exceeds the safety limit', 'too-large');
  if (envelope.sha256 && (await sha256Hex(plain)) !== envelope.sha256) throw new EnvelopeError('Integrity check failed: the data is damaged', 'integrity');
  try {
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new EnvelopeError('Payload is not valid JSON', 'corrupt');
  }
}
