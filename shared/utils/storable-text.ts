// TEXT-STORABILITY LAW (SPEC "API law", #377): Postgres text columns cannot
// store a NUL byte or an unpaired surrogate — the driver throws (invalid byte
// sequence / unsupported unicode escape) and oRPC surfaces that as an opaque
// 500 on input the schema had already accepted. Callers refuse such text at
// their schema edge; this predicate is the ONE implementation of "unstorable".

/** true when `value` carries text a Postgres text column cannot store: NUL or an unpaired surrogate */
export function hasUnstorableText(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1; // a valid surrogate pair (astral character) is storable
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true; // low surrogate with no high before it
    }
  }
  return false;
}
