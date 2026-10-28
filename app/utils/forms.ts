// Shared form helpers: the none-sentinel every picker uses, and one error
// ladder for oRPC/ofetch failures (the server's message rides err.data.json.message).

/** sentinel value for 'no selection' in pickers whose model can't hold null —
 * mapped back to null at the API boundary (never sent as a literal id) */
export const NONE_ID: string = '__none__';

/** server message first (oRPC nests it at data.json.message), then ofetch's,
 * then the generic fallback — never render '[POST] …: 400' verbatim */
export function errorMessage(e: unknown, fallback: string): string {
  const err = e as { data?: { json?: { message?: string }; message?: string }; message?: string };
  return err?.data?.json?.message ?? err?.data?.message ?? (err instanceof Error ? err.message : undefined) ?? fallback;
}
