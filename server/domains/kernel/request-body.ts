// REQUEST-LENGTH LAW (audit #241, SPEC §Auth + §Routes): request-body caps are
// only enforceable BEFORE a byte is read. h3's readRawBody buffers the WHOLE
// body before any size check fires, and on the bun nitro preset
// event.node.req has NO asyncIterator — a hand-rolled mid-stream capped reader
// hangs (ship-chain law). So the undeclared-length shape — a chunked body with
// no usable content-length — has no knowable size until fully received and is
// refused `411 length required` by both body-carrying public routes
// (better-auth /auth/**, attachment upload) before any read. Every byte the
// server buffers was declared up-front and carries its own pre-read cap
// (auth 1MB → 413, attachments 21MB → 413). The predicate mirrors h3's own
// readRawBody read-decision (content-length parses truthy OR chunked → read),
// so a body h3 would stream unbounded is exactly the body we refuse.
export function hasUndeclaredBodySize(headers: Record<string, string | string[] | undefined>): boolean {
  const len = headers['content-length'];
  const declared = Number.parseInt(Array.isArray(len) ? (len[0] ?? '') : (len ?? ''), 10);
  const te = headers['transfer-encoding'];
  const chunked = /\bchunked\b/i.test(Array.isArray(te) ? te.join(',') : String(te ?? ''));
  return chunked && !declared;
}
