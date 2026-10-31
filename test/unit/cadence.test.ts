// Peak cadence window math (#70): agents run a reduced cap during the owner's
// peak window (Mon–Fri 08:00–17:00 ICT) and full cadence off-peak. The weekend
// exemption is contract: Saturday + Sunday never throttle, any hour.
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PEAK_END_HOUR,
  DEFAULT_PEAK_MULTIPLIER,
  DEFAULT_PEAK_START_HOUR,
  effectiveCap,
  isPeak,
  parsePeakHour,
  parsePeakMultiplier,
} from '#shared/cadence';

/** instants constructed as UTC — the ICT wall-clock is derived by the module */
const at = (iso: string) => new Date(iso);
// fixed reference week (Oct/Nov 2026): Fri 2026-10-30, Sat 2026-10-31, Sun 2026-11-01, Mon 2026-11-02, Wed 2026-11-04
const FRI_0300Z = '2026-10-30T03:00:00Z'; // Fri 10:00 ICT — inside the default window
const FRI_0100Z = '2026-10-30T01:00:00Z'; // Fri 08:00 ICT — start-hour inclusive
const FRI_0959Z = '2026-10-30T09:59:00Z'; // Fri 16:59 ICT — still inside (hour < 17)
const FRI_1000Z = '2026-10-30T10:00:00Z'; // Fri 17:00 ICT — end-hour exclusive, PAST the window
const FRI_1100Z = '2026-10-30T11:00:00Z'; // Fri 18:00 ICT — the owner's acceptance instant (no throttle)
const SAT_0500Z = '2026-10-31T05:00:00Z'; // Sat 12:00 ICT — the owner's acceptance instant (weekend, no throttle)
const SAT_1600Z = '2026-10-31T16:00:00Z'; // Sat 23:00 ICT — weekend late evening, no throttle
const SUN_0300Z = '2026-11-01T03:00:00Z'; // Sun 10:00 ICT — weekend, no throttle
const MON_0059Z = '2026-11-02T00:59:00Z'; // Mon 07:59 ICT — one minute before the window
const WED_0500Z = '2026-11-04T05:00:00Z'; // Wed 12:00 ICT — mid-window midweek

describe('isPeak (peak window math, ICT wall-clock)', () => {
  it('marks a midweek mid-window instant as peak', () => {
    expect(isPeak(at(WED_0500Z))).toBe(true);
    expect(isPeak(at(FRI_0300Z))).toBe(true);
  });

  it('start hour is inclusive, end hour exclusive', () => {
    expect(isPeak(at(FRI_0100Z))).toBe(true); // 08:00 ICT exactly
    expect(isPeak(at(FRI_0959Z))).toBe(true); // 16:59 ICT
    expect(isPeak(at(FRI_1000Z))).toBe(false); // 17:00 ICT exactly
  });

  it('hours outside the default window are off-peak (owner acceptance: Friday 18:00 ICT)', () => {
    expect(isPeak(at(MON_0059Z))).toBe(false); // Mon 07:59 ICT
    expect(isPeak(at(FRI_1100Z))).toBe(false); // Fri 18:00 ICT — past the window
  });

  it('the weekend NEVER throttles — Saturday noon and any weekend hour are off-peak (owner acceptance)', () => {
    expect(isPeak(at(SAT_0500Z))).toBe(false); // Saturday 12:00 ICT
    expect(isPeak(at(SAT_1600Z))).toBe(false); // Saturday 23:00 ICT
    expect(isPeak(at(SUN_0300Z))).toBe(false); // Sunday 10:00 ICT
  });

  it('derives ICT (UTC+7) regardless of the server timezone — 03:00Z is 10:00 ICT', () => {
    // 03:00 UTC would be pre-window in UTC terms (3 < 8) but is 10:00 in ICT: peak
    expect(isPeak(at(FRI_0300Z))).toBe(true);
  });

  it('honors a configured window (same math, custom hours)', () => {
    expect(isPeak(at(SAT_0500Z), 0, 24)).toBe(false); // weekend exemption is not configurable
    expect(isPeak(at(MON_0059Z), 0, 24)).toBe(true); // Mon 07:59 ICT inside a 00–24 window
    expect(isPeak(at(FRI_1100Z), 18, 24)).toBe(true); // Fri 18:00 ICT inside an 18–24 window
  });

  it('default window is the owner ruling: 08–17', () => {
    expect(DEFAULT_PEAK_START_HOUR).toBe(8);
    expect(DEFAULT_PEAK_END_HOUR).toBe(17);
    expect(DEFAULT_PEAK_MULTIPLIER).toBe(1);
  });
});

describe('effectiveCap (peak multiplier on the per-agent cap)', () => {
  it('scales the cap down inside the window (floor)', () => {
    expect(effectiveCap(4, 0.5, true)).toBe(2);
    expect(effectiveCap(3, 0.5, true)).toBe(1);
  });

  it('multiplier 0 pauses new in-window dispatches', () => {
    expect(effectiveCap(2, 0, true)).toBe(0);
  });

  it('multiplier 1 and off-peak instants leave the full cap', () => {
    expect(effectiveCap(3, 1, true)).toBe(3);
    expect(effectiveCap(4, 0.5, false)).toBe(4);
    expect(effectiveCap(1, 1, false)).toBe(1);
  });
});

describe('peak settings parsers (tolerant: garbage falls back)', () => {
  it('parsePeakHour keeps valid integers in range and rejects everything else', () => {
    expect(parsePeakHour('9', 8, 0, 23)).toBe(9);
    expect(parsePeakHour('0', 8, 0, 23)).toBe(0);
    expect(parsePeakHour('23', 8, 0, 23)).toBe(23);
    expect(parsePeakHour(null, 8, 0, 23)).toBe(8);
    expect(parsePeakHour('abc', 8, 0, 23)).toBe(8);
    expect(parsePeakHour('7.5', 8, 0, 23)).toBe(8);
    expect(parsePeakHour('24', 8, 0, 23)).toBe(8);
    expect(parsePeakHour('-1', 8, 0, 23)).toBe(8);
  });

  it('parsePeakMultiplier keeps [0,1] numbers and falls back to 1', () => {
    expect(parsePeakMultiplier('0')).toBe(0);
    expect(parsePeakMultiplier('0.5')).toBe(0.5);
    expect(parsePeakMultiplier('1')).toBe(1);
    expect(parsePeakMultiplier(null)).toBe(1);
    expect(parsePeakMultiplier('1.5')).toBe(1);
    expect(parsePeakMultiplier('-0.1')).toBe(1);
    expect(parsePeakMultiplier('abc')).toBe(1);
  });
});
