// UUIDv7 ids (RFC 9562): 48-bit millisecond timestamp + random — time-sortable,
// index-friendly. Tandem's own tables mint every id through here.
// Bun ships a native UUIDv7 (Bun.randomUUIDv7); the hand-rolled fallback keeps
// the helper honest under Node/non-Bun tooling.

const FALLBACK_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function uuidv7Fallback(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const ts = Date.now()
  // unix_ms (48 bits) into bytes 0..5
  bytes[0] = Number((ts / 2 ** 40) & 0xff)
  bytes[1] = Number((ts / 2 ** 32) & 0xff)
  bytes[2] = Number((ts / 2 ** 24) & 0xff)
  bytes[3] = Number((ts / 2 ** 16) & 0xff)
  bytes[4] = Number((ts / 2 ** 8) & 0xff)
  bytes[5] = Number(ts & 0xff)
  const b6 = bytes[6] ?? 0
  const b8 = bytes[8] ?? 0
  bytes[6] = (b6 & 0x0f) | 0x70 // version 7
  bytes[8] = (b8 & 0x3f) | 0x80 // RFC variant
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}

/** mint a UUIDv7 (time-ordered). Falls back to a hand-rolled RFC 9562
 * implementation when Bun's native one is unavailable. */
export function uuidv7(): string {
  const b = globalThis as { Bun?: { randomUUIDv7?: () => string } }
  if (typeof b.Bun?.randomUUIDv7 === 'function') return b.Bun.randomUUIDv7()
  return uuidv7Fallback()
}

/** test-only: the fallback must produce a valid v7 string */
export const __uuidv7Fallback = uuidv7Fallback
export const __UUID7_RE = FALLBACK_RE
