// providerId(:secretId) -> model names; 5-minute TTL sweeper (armed lazily
// so tests with fake timers can observe it)
export const modelCache = new Map<string, string[]>();
export const MODEL_CACHE_TTL_MS = 5 * 60_000;
export const sweepModelCache = () => modelCache.clear();
let cacheSweeperArmed = false;
export function armCacheSweeper() {
  if (cacheSweeperArmed) return;
  cacheSweeperArmed = true;
  setInterval(sweepModelCache, MODEL_CACHE_TTL_MS).unref?.();
}
