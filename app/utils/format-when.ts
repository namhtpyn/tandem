// timestamps render user-local; server/client disagree pre-hydration — spans opt out (data-allow-mismatch)
export function formatWhen(value: string | Date | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  // seconds add noise everywhere this renders — date + HH:MM only
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// compact variant for dense lists: times read as HH:MM today, 'Oct 27, 14:03'
// within this year, 'Oct 27, 2025, 14:03' once the year differs (a bare month/day
// on an old row reads as this year)
export function formatWhenShort(value: string | Date | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  const day =
    d.getFullYear() === today.getFullYear()
      ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  return `${day}, ${time}`;
}

// wall-clock duration label for a settled span: '<1s', '42s', '4m 05s', '1h 23m'
// (minutes carry padded seconds, hours carry padded minutes — fixed width reads
// as a duration, not a time). Callers pass ms >= 0; negatives read as '<1s'.
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return '<1s';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// duration label for a run turn, or null when NOTHING should render: an
// unfinished turn (no finish time), an unparsable timestamp, or a non-positive
// delta (clock skew) never renders a duration — the flag alone never forces one
export function turnDurationLabel(
  startedAt: string | Date | null | undefined,
  finishedAt: string | Date | null | undefined,
): string | null {
  if (!startedAt || !finishedAt) return null;
  const start = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const end = finishedAt instanceof Date ? finishedAt : new Date(finishedAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const delta = end.getTime() - start.getTime();
  if (delta <= 0) return null;
  return formatDurationMs(delta);
}
