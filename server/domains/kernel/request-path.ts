// WHATWG-normalized pathname of a raw request URL (audit #251).
// Nitro hands handlers the RAW url string, but the downstream router sees the
// pathname of `new Request(proto://host + rawUrl)` — WHATWG parsing collapses
// `/./`, `/../` and percent-encoded dot segments (`/%2e%2e/`) while PRESERVING
// empty (double-slash) segments and rejecting absolute-form targets. A policy
// gate that string-matches the raw url is bypassable while the endpoint still
// serves: `POST /auth/sign-up/./email` skipped the sign-up closure gate yet
// better-auth routed it to /auth/sign-up/email. This helper mirrors the
// router's URL view byte-for-byte, so a gate skip coincides exactly with a
// router 404 — never with a served endpoint. Gates must match THIS shape.
export function normalizedAuthPath(rawUrl: string): string {
  try {
    // origin concatenated raw (no separator), mirroring buildIncomingRequest's
    // `${proto}://${host}${full}` — NOT a base-URL join, which would swallow a
    // leading `//` into the host and diverge from what the router matches
    return new URL(`http://kernel.local${rawUrl}`).pathname;
  } catch {
    // unparseable url (absolute-form target etc.): fail closed — the request
    // builder throws on the same input, so no endpoint can serve it either
    return '/';
  }
}
