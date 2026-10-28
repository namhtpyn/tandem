/**
 * Agent run timeout bounds, in minutes — one range for the settings form and
 * the settings.update schema (the server caps a run at 6 hours).
 */
export const RUN_TIMEOUT_MINUTES = { min: 1, max: 360 } as const;

/** the cap in human words — the settings hint and the validation copy share it */
export const RUN_TIMEOUT_MAX_COPY = 'Up to 6 hours';
