// narrows a nullable value or throws — the lint-clean stand-in for `!`
export function nonNull<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new TypeError(`unexpected null ${what}`);
  return value;
}
