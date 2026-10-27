// escape LIKE wildcards so a q of '%' or '_' matches itself, not everything
export function escapeIlike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}
