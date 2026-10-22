// UUIDv7 ids (RFC 9562): 48-bit millisecond timestamp + random — time-sortable,
// index-friendly. Tandem's own tables mint every id through here, backed by the
// `uuid` package (v7). Single mint point: swapping implementations never
// touches call sites.
import { v7 as uuidV7 } from 'uuid'

/** mint a UUIDv7 (time-ordered) */
export function uuidv7() {
  return uuidV7()
}
