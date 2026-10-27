// echo-note dedupe shared by the thread read and the brief relay
export type EchoRow = {
  authorId: string | null;
  body: string;
  createdAt: Date | string;
  run: { employeeId: string | null } | null;
};

/** agent-side runners echo the settled result as a plain note seconds after the run
 * message carries the same body — the run turn already carries it, so drop the echo
 * (keeps prompts clean too: an echo is the author's own turn, never relay signal) */
export function dropEchoNotes<T extends EchoRow>(rows: T[]): T[] {
  const runBodyByAuthor = new Map<string, { body: string; at: number }>();
  for (const m of rows) {
    if (m.run && m.body && m.authorId)
      runBodyByAuthor.set(m.authorId, { body: m.body, at: new Date(m.createdAt).getTime() });
  }
  return rows.filter((m) => {
    if (m.run || !m.body || !m.authorId) return true;
    const run = runBodyByAuthor.get(m.authorId);
    if (!run || run.body !== m.body) return true;
    const at = new Date(m.createdAt).getTime();
    return !(at > run.at && at - run.at <= 120_000);
  });
}
