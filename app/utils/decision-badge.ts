/** The shell/mobile decision-badge query gate (DECISION-VISIBILITY LAW +
 *  ROTATION LOCK): the badge reads `tasks.inbox`, which is session-tier and
 *  therefore refused for a session that still owes the forced first-login
 *  password change — the query must stay DISABLED on the rotation screen
 *  (a locked session may reach exactly one procedure), and while signed out. */
export function decisionBadgeEnabled(user: { mustChangePassword?: boolean } | null | undefined): boolean {
  return !!user && !user.mustChangePassword;
}
