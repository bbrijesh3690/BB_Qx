// Byte helpers shared by the page tap, the service worker and the analysis script.
// Only web-platform globals (atob, btoa, TextDecoder) so the same code runs in Node and Chrome.

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Returns null for malformed base64 instead of throwing. */
export function base64ToBytes(b64: string): Uint8Array | null {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const utf8 = new TextDecoder('utf-8', { fatal: false });
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

export function utf8Decode(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}

/** UTF-8 text of the bytes, or null when they are not valid UTF-8. */
export function utf8DecodeStrict(bytes: Uint8Array): string | null {
  try {
    return utf8Strict.decode(bytes);
  } catch {
    return null;
  }
}

export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
