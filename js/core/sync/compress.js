/**
 * Gzip compression with the native CompressionStream when available and
 * a pinned fflate fallback otherwise. Decompression is bounded so a
 * malicious or corrupt payload cannot exhaust memory.
 */

import { gzipSync, Gunzip } from '../../../vendor/fflate/fflate.mjs';

export const DEFAULT_MAX_DECOMPRESSED = 128 * 1024 * 1024;

export class CompressionError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function nativeCompressionAvailable() {
  return typeof globalThis.CompressionStream === 'function' && typeof globalThis.DecompressionStream === 'function';
}

async function readAll(stream, maxBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new CompressionError(`Decompressed data exceeds the ${Math.round(maxBytes / 1048576)} MB safety limit`, 'too-large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export async function gzip(bytes, { implementation = 'auto' } = {}) {
  if ((implementation === 'auto' && nativeCompressionAvailable()) || implementation === 'native') {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return { bytes: await readAll(stream, Infinity), implementation: 'native' };
  }
  return { bytes: gzipSync(bytes, { level: 6 }), implementation: 'fflate' };
}

/** Uncompressed size claimed by the gzip trailer (mod 2^32). */
export function gzipClaimedSize(bytes) {
  if (bytes.length < 18) return 0;
  const n = bytes.length;
  return (bytes[n - 4] | (bytes[n - 3] << 8) | (bytes[n - 2] << 16) | (bytes[n - 1] << 24)) >>> 0;
}

export async function gunzip(bytes, { maxBytes = DEFAULT_MAX_DECOMPRESSED, implementation = 'auto' } = {}) {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new CompressionError('Not gzip data', 'corrupt');
  if (gzipClaimedSize(bytes) > maxBytes) throw new CompressionError('Payload claims to be larger than the safety limit', 'too-large');
  if ((implementation === 'auto' && nativeCompressionAvailable()) || implementation === 'native') {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      return await readAll(stream, maxBytes);
    } catch (err) {
      if (err instanceof CompressionError) throw err;
      throw new CompressionError('Compressed data is damaged', 'corrupt');
    }
  }
  const chunks = [];
  let total = 0;
  const inflater = new Gunzip((chunk) => {
    total += chunk.length;
    if (total > maxBytes) throw new CompressionError('Decompressed data exceeds the safety limit', 'too-large');
    chunks.push(chunk);
  });
  try {
    const step = 64 * 1024;
    for (let i = 0; i < bytes.length; i += step) inflater.push(bytes.subarray(i, i + step), i + step >= bytes.length);
  } catch (err) {
    if (err instanceof CompressionError) throw err;
    throw new CompressionError('Compressed data is damaged', 'corrupt');
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
