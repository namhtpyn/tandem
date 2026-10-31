/**
 * Peak cadence — the time-aware per-agent dispatch cap (#70).
 *
 * Contract (SPEC.md, dispatcher): agents take it easy during the owner's peak
 * window and run full cadence off-peak. The window lives in ICT (UTC+07:00)
 * wall-clock time regardless of the server's timezone, applies MONDAY–FRIDAY
 * ONLY (Saturday + Sunday run full cadence 24/7), and the multiplier scales the
 * tasks-per-agent cap down inside the window. Pure module: no db, no clock —
 * callers pass the instant so the window math stays testable.
 */

/** ICT fixed offset (Indochina Time, UTC+07:00) in minutes. */
export const PEAK_TZ_OFFSET_MIN = 7 * 60;

/** Default peak window: 08:00–17:00 ICT (start-hour inclusive, end-hour exclusive). */
export const DEFAULT_PEAK_START_HOUR = 8;
export const DEFAULT_PEAK_END_HOUR = 17;

/** Peak multiplier bounds: 0 pauses new in-window dispatches, 1 = no throttling. */
export const PEAK_MULTIPLIER_MIN = 0;
export const PEAK_MULTIPLIER_MAX = 1;
export const DEFAULT_PEAK_MULTIPLIER = 1;

/** ISO weekday in ICT: 1 = Monday … 5 = Friday (6/7 = the exempt weekend). */
export type IctParts = { weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7; hour: number };

/** ICT wall-clock parts (weekday + hour) for an instant — TZ-independent. */
export function ictParts(at: Date): IctParts {
  const shifted = new Date(at.getTime() + PEAK_TZ_OFFSET_MIN * 60_000);
  // getUTCDay: 0 = Sunday … 6 = Saturday → ISO 1 = Monday … 7 = Sunday
  const weekday = (((shifted.getUTCDay() + 6) % 7) + 1) as IctParts['weekday'];
  return { weekday, hour: shifted.getUTCHours() };
}

/** Is this instant inside the peak window? Weekdays Mon–Fri only, start-hour
 * inclusive, end-hour exclusive — the weekend exemption is part of the contract,
 * never configurable. */
export function isPeak(at: Date, startHour = DEFAULT_PEAK_START_HOUR, endHour = DEFAULT_PEAK_END_HOUR): boolean {
  const { weekday, hour } = ictParts(at);
  if (weekday > 5) return false; // Sat/Sun: full cadence 24/7
  return hour >= startHour && hour < endHour;
}

/** The effective per-agent cap: `floor(base × multiplier)` inside the peak
 * window, the full base outside it. multiplier 0 legally pauses NEW in-window
 * dispatches (live runs are never killed — the cap only gates claiming). */
export function effectiveCap(base: number, multiplier: number, peak: boolean): number {
  if (!peak) return base;
  return Math.floor(base * multiplier);
}

/** Tolerant settings reader for a peak hour key: integers in range pass, all
 * garbage (NaN, strings, out-of-range, non-integer) falls back. */
export function parsePeakHour(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Tolerant settings reader for the multiplier: finite numbers in [0,1] pass. */
export function parsePeakMultiplier(raw: string | null): number {
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= PEAK_MULTIPLIER_MIN && n <= PEAK_MULTIPLIER_MAX ? n : DEFAULT_PEAK_MULTIPLIER;
}
