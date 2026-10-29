import { consola } from 'consola';
import { and, eq } from 'drizzle-orm';

import { PROPOSAL_STATUS } from '#shared/enums';
import { parseRunEnvelope, RunVerdictSchema } from '#shared/run-verdict';
import { renderOutputContract } from '#shared/structured-output';
import { nonNull } from '#shared/utils/non-null';

// Per-task brief: identity + org chains + task context + mention chains + output contract.
// Pure functions — no I/O; loadBriefData gathers rows.
import { db } from '../../db/index';
import { taskProposals } from '../../db/schema';
import { stripAttachments } from './attachments.util';
import { dropEchoNotes } from './echo-notes';

/** jsonb payloads arrive as raw strings through RQB relation selects — normalize to the
 * kind; one corrupt payload must never brick dispatch, so unparseable reads as '' (note) */
export function activityKindOf(payload: unknown): string {
  try {
    const obj = (typeof payload === 'string' ? JSON.parse(payload) : payload) as { kind?: unknown } | null;
    return typeof obj?.kind === 'string' ? obj.kind.toLowerCase() : '';
  } catch {
    /* v8 ignore next */
    return '';
  }
}

export type BriefPerson = { id: string; name: string; title: string | null; kind: string };

/** exact-name mention matcher: metachars escaped ($& would be a no-op — it reinserts
 * the match), boundary rejects letters/digits so @Zed never matches @Zed2.
 * Null when the pattern cannot compile — the caller skips that name. */
export function mentionMatcher(name: string): RegExp | null {
  try {
    return new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u');
  } catch {
    /* v8 ignore next 2 -- correct escaping compiles every name; skip is engine-limit defense */
    return null;
  }
}

/** mentions in the description: @[Label](id) tiptap links, HTML spans, or plain @Label tokens.
 * Labels resolve against known employee names (mention menu only offers employees), so
 * plain @Name matching is exact-by-construction, never fuzzy. */
export function extractMentionedEmployeeIds(description: string, nameToId: Map<string, string>) {
  const ids = new Set<string>();
  for (const m of description.matchAll(/@\[[^\]]*\]\(mention-([^)]+)\)/g)) ids.add(nonNull(m[1]));
  for (const m of description.matchAll(/\[@ label="([^"]+)"\]/g)) {
    const id = nameToId.get(nonNull(m[1]));
    if (id) ids.add(id);
  }
  let uncompiled = 0;
  for (const [name, id] of nameToId) {
    const re = mentionMatcher(name);
    /* v8 ignore next 3 -- correct escaping compiles every name; skip is engine-limit defense */
    if (!re) {
      uncompiled++;
      continue;
    }
    if (re.test(description)) ids.add(id);
  }
  // one warn for the whole batch, never per name
  /* v8 ignore next -- same defensive arm as above */
  if (uncompiled) consola.warn(`[brief] skipped ${uncompiled} employee name(s) that failed mention-pattern compile`);
  return [...ids];
}

/** one level per management layer; a level lists every supervisor of the level
 * below (a person can report to several), deduped and cycle-safe */
export function chainToRoot(startId: string, edges: Array<{ employeeId: string; supervisorId: string }>) {
  const supersOf = new Map<string, string[]>();
  for (const e of edges) {
    const list = supersOf.get(e.employeeId) ?? [];
    if (!list.includes(e.supervisorId)) list.push(e.supervisorId);
    supersOf.set(e.employeeId, list);
  }
  const levels: string[][] = [];
  const seen = new Set([startId]);
  let cur = supersOf.get(startId) ?? [];
  while (cur.length) {
    levels.push(cur);
    for (const id of cur) seen.add(id);
    const next = [...new Set(cur.flatMap((id) => supersOf.get(id) ?? []))].filter((id) => !seen.has(id));
    cur = next;
  }
  return levels;
}

type BriefInput = {
  companyPrompt?: string;
  projectPrompt?: string;
  agent: BriefPerson;
  agentInstructions: string;
  upChain: BriefPerson[][];
  directReports: BriefPerson[];
  extraChains: Array<{ person: BriefPerson; chain: BriefPerson[][] }>;
  task: {
    title: string;
    description: string;
    ownerName: string | null;
    ownerId?: string | null;
    reviewerNames: string[];
    projectName: string | null;
    parentTitle?: string | null;
  };
  /** exact deliverable out-dir for this run's task — agents must not guess it */
  outDir: string;
  recentActivity: Array<{ kind: string; authorName: string | null; body: string | null }>;
  /** reader already ran this task: the ticket lives in their session, prompt is a relay */
  relay: boolean;
  attachments?: Array<{ id: string; filename: string; mime: string; size: number; remotePath: string }>;
};

export function buildBrief(input: BriefInput) {
  if (input.relay) {
    // continuation: the ticket already lives in this agent's session
    return [
      ...orgSection(input),
      '',
      'CONTINUATION — you worked on this task before; the messages below are everything new since your last turn. If you are missing earlier context (fresh session), ask for the full ticket via a blocked envelope.',
      ...activitySection(input),
      ...attachmentsSection(input),
      ...contractSection(input),
    ].join('\n');
  }
  return [
    ...orgSection(input),
    ...contextSection(input),
    ...taskSection(input),
    ...activitySection(input),
    ...attachmentsSection(input),
    ...contractSection(input),
  ].join('\n');
}

/** who the agent is and where it sits in the org */
function orgSection(input: BriefInput) {
  const lines = [`You are ${input.agent.name}${input.agent.title ? `, ${input.agent.title}` : ''}.`];
  if (input.upChain.length)
    lines.push(`You report to: ${input.upChain.map((lvl) => lvl.map(personLine).join(' & ')).join(' -> ')}.`);
  else lines.push('You report to: (nobody — top of organization).');
  if (input.directReports.length) lines.push(`Reports to you: ${input.directReports.map(personLine).join(', ')}.`);
  if (input.agentInstructions.trim()) lines.push(`Standing instructions: ${input.agentInstructions.trim()}`);
  for (const c of input.extraChains) {
    if (c.chain.length)
      lines.push(
        `${c.person.name}: ${personLine(c.person)}; their chain: ${c.chain.map((lvl) => lvl.map(personLine).join(' & ')).join(' -> ')}.`,
      );
    else lines.push(`${c.person.name}: ${personLine(c.person)}; their chain: (unknown).`);
  }
  return lines;
}

/** layered standing context: company-wide, then project-specific prompts */
function contextSection(input: BriefInput) {
  const lines: string[] = [];
  if (input.companyPrompt?.trim()) {
    lines.push('');
    lines.push('COMPANY (applies to all your work)');
    lines.push(input.companyPrompt.trim());
  }
  if (input.projectPrompt?.trim()) {
    lines.push('');
    lines.push(`PROJECT ${input.task.projectName ? `— ${input.task.projectName}` : ''}`.trim());
    lines.push(input.projectPrompt.trim());
  }
  return lines;
}

/** the TASK block: identity, description, people, project */
function taskSection(input: BriefInput) {
  const lines = ['', 'TASK'];
  if (input.task.parentTitle) lines.push(`This is a subtask of: ${input.task.parentTitle}`);
  lines.push(`Title: ${input.task.title}`);
  if (input.task.description.trim())
    lines.push(`Description: ${stripAttachments(stripMentions(input.task.description))}`);
  lines.push(
    `Owner: ${input.task.ownerName ?? 'unassigned'}${input.task.ownerId ? ` (id: ${input.task.ownerId})` : ''}`,
  );
  if (input.task.reviewerNames.length)
    lines.push(`Reviewers (all must approve): ${input.task.reviewerNames.join(', ')}`);
  if (input.task.projectName) lines.push(`Project: ${input.task.projectName}`);
  return lines;
}

/** what already happened on this task (loader keeps the newest 20) */
function activitySection(input: BriefInput) {
  if (!input.recentActivity.length) return [];
  const lines = ['', 'Recent activity on this task (oldest first):'];
  for (const a of input.recentActivity)
    // owner law 2026-10-26: prompt message lines ship whole — never truncated
    lines.push(`- ${a.kind.toLowerCase()} by ${a.authorName ?? 'system'}: ${a.body ?? ''}`);
  return lines;
}

/** files already staged on this machine for the run */
function attachmentsSection(input: BriefInput) {
  if (!input.attachments?.length) return [];
  const lines = ['', 'ATTACHMENTS (already on this machine — do not re-download):'];
  for (const a of input.attachments) {
    const kind = a.mime.startsWith('image/') ? 'image — view with your image tool' : 'document — read with file tools';
    lines.push(`- ${a.remotePath} (${a.filename}, ${kind}, ${Math.max(1, Math.round(a.size / 1024))}KB)`);
  }
  return lines;
}

/** deliverable location + machine-readable output contract + routing syntax */
function contractSection(input: BriefInput) {
  return [
    '',
    renderOutputContract(RunVerdictSchema, {
      intro:
        'OUTPUT CONTRACT — end your response with exactly one JSON line (no code fence). ROUTING rides the same line: propose subtasks when a meaningful part belongs to someone else; reassign only when the WHOLE task belongs elsewhere; routing inside your own supervision chain executes immediately, anything outside goes to a human. This JSON line is MANDATORY on every turn:',
      examples: [
        '{"kind": "result", "body": "<final answer or summary of work done>"}',
        '{"kind": "question", "body": "<blocking question for the owner>"}',
        '{"kind": "blocked", "body": "<what you need and from whom>"}',
        '{"kind": "result", "body": "<…>", "subtasks": [{"title": "<…>", "description": "<…>", "assigneeName": "<name>"}]}',
        '{"kind": "result", "body": "<…>", "reassign": {"assigneeName": "<name>", "reason": "<why>"}}',
      ],
    }),
    '',
    `DELIVERABLES (artifacts only) — real output files (screenshots, exports, generated docs) go to ${input.outDir} (create it if needed; that EXACT path, not the environment name) and are collected automatically. NEVER write your result, summary or verdict as a file there — no RESULT.md: the JSON line above is the only result; files never substitute for it.`,
  ];
}

function personLine(p: BriefPerson) {
  return p.title ? `${p.name} (${p.title})` : p.name;
}

/** mentions -> plain Name refs for the prompt (agent sees names, not markdown ids) */
function stripMentions(desc: string) {
  return desc.replace(/@\[([^\]]*)\]\(mention-[^)]+\)/g, (_m, label) => `${label}`).trim();
}

/** gather everything the brief needs from the DB (single dispatch-time read) */
export async function loadBriefData(taskId: string, readerEmployeeId?: string) {
  const task = await db.query.tasks.findFirst({
    columns: {
      title: true,
      description: true,
      assigneeId: true,
      ownerId: true,
      reviewers: true,
      projectId: true,
      parentTaskId: true,
    },
    where: { id: { eq: taskId } },
  });
  if (!task) throw new Error('task not found');
  // FK invariant: parent_task_id set => the row exists (ON DELETE SET NULL keeps it true)
  const parentTitle = task.parentTaskId
    ? nonNull(await db.query.tasks.findFirst({ columns: { title: true }, where: { id: { eq: task.parentTaskId } } }))
        .title
    : null;
  const assigneeId = nonNull(task.assigneeId);
  const edges = await db.query.employeeSupervisors.findMany({
    columns: { employeeId: true, supervisorId: true },
    orderBy: { employeeId: 'asc' },
  });
  const users = await db.query.user.findMany({
    columns: { id: true, name: true, title: true },
    orderBy: { name: 'asc' },
  });
  const aiRows = await db.query.aiEmployees.findMany({
    columns: { userId: true, instructions: true },
    orderBy: { userId: 'asc' },
  });
  const aiById = new Map(aiRows.map((r) => [r.userId, r]));
  const person = (id: string): BriefPerson => {
    const u = nonNull(users.find((x) => x.id === id));
    return { id, name: nonNull(u).name, title: nonNull(u).title || null, kind: aiById.has(id) ? 'ai' : 'human' };
  };
  const upLevels = chainToRoot(assigneeId, edges);
  const upIds = upLevels.flat();
  const downIds = edges.filter((e) => e.supervisorId === assigneeId).map((e) => e.employeeId);
  const nameToId = new Map(users.map((u) => [u.name, u.id] as const));
  const mentionIds = extractMentionedEmployeeIds(task.description, nameToId);
  const extra: Array<{ person: BriefPerson; chain: BriefPerson[][] }> = [];
  for (const mid of mentionIds) {
    if (mid === assigneeId || upIds.includes(mid) || downIds.includes(mid)) continue;
    if (!users.some((u) => u.id === mid)) continue;
    extra.push({ person: person(mid), chain: chainToRoot(mid, edges).map((lvl) => lvl.map(person)) });
  }
  // prompt source = task_messages (owner ruling 2026-10-26); the relay filter
  // below decides what actually ships. Newest 200 only — the brief relays recent
  // context, never the full archive (desc + reverse keeps asc render order).
  const threadRows = (
    await db.query.taskMessages.findMany({
      columns: { id: true, body: true, authorId: true, createdAt: true },
      where: { taskId: { eq: taskId } },
      orderBy: { createdAt: 'desc', id: 'desc' },
      limit: 200,
      with: {
        author: { columns: { name: true } },
        run: { columns: { finishedAt: true, employeeId: true, output: true, sessionId: true } },
        activityExt: { columns: { payload: true } },
      },
    })
  ).reverse();
  // echo notes (agent-side runners re-posting their own settled result) read as fresh
  // author messages here — they are the author's own turn, never relay signal
  const relayRows = dropEchoNotes(threadRows);
  const finishedAts = threadRows
    .map((m) => m.run?.finishedAt)
    .filter((t): t is Date => t instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime());
  // relay law (owner ruling 2026-10-26): the prompt is a conversation relay, not a
  // re-brief. The TASK block ships only on the reader's first run of the task; later
  // prompts carry just the messages since the reader's own last finished turn —
  // other agents' results are the relay, own turns live in session memory, STATUS
  // bookkeeping never ships.
  const ownFinished = finishedAts.filter(
    (f) =>
      !readerEmployeeId ||
      threadRows.some((m) => m.run?.employeeId === readerEmployeeId && m.run.finishedAt?.getTime() === f.getTime()),
  );
  const hasPrior = ownFinished.length > 0;
  const lastFinished = hasPrior ? (ownFinished.at(-1) ?? null) : null;
  // relay keys on a RESUMABLE session (owner ruling 2026-10-29): the reader has a
  // run whose ACP turn actually opened (sessionId set). Failed pre-turn runs count
  // as finished but hold no session — treating them as prior shipped a
  // CONTINUATION with zero context (task 01a182f2's drift run); a session-less
  // reader gets the full ticket again instead.
  const resumable = readerEmployeeId
    ? threadRows.some((m) => m.run?.employeeId === readerEmployeeId && !!m.run.sessionId)
    : false;
  const isRelay = hasPrior && resumable;
  // declined proposals ride the same relay cutoff as thread rows — pre-cutoff
  // declines are old news to a reader who already saw them
  const rejectedNotes = (
    await db
      .select()
      .from(taskProposals)
      .where(and(eq(taskProposals.taskId, taskId), eq(taskProposals.status, PROPOSAL_STATUS.REJECTED)))
  )
    .filter((p) => p.decisionNote)
    .filter((p) => !lastFinished || p.createdAt > lastFinished)
    // no leading "- ": the activity renderer already dashes every line
    .map((p) => `proposal declined: ${p.kind} — ${p.decisionNote}`);
  const extKind = (m: (typeof threadRows)[number]) => activityKindOf(m.activityExt?.payload);
  const convo = relayRows.filter((m) => {
    // cutoff gates EVERY row first (relay law) — exclusions never un-filter stale rows
    if (lastFinished && m.createdAt <= lastFinished) return false;
    if (extKind(m) === 'status') return false;
    if (m.run) {
      // only SETTLED turns relay: an unfinished run's message is still an empty stub,
      // and the reader's own turns live in session memory
      return Boolean(m.run.finishedAt) && m.body.trim() !== '' && m.run.employeeId !== readerEmployeeId;
    }
    return true;
  });
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  const recent = convo.map((m) => {
    const envelope = m.run ? parseRunEnvelope(m.run.output) : null;
    return {
      // run turns render under their settled envelope kind (a question/blocked result
      // relays as such); 'result' stays the default when the output never parsed
      kind: m.run ? (envelope?.kind ?? 'result') : extKind(m) || 'note',
      // run turns carry no message author; the employee user row names them
      authorName: m.run ? (nameById.get(m.run.employeeId ?? '') ?? 'agent') : (m.author?.name ?? null),
      body: m.body,
    };
  });
  const ai = aiById.get(assigneeId);
  // company + project prompts ride every brief (user law 2026-10-16: layered context)
  const { getCompanyPrompt } = await import('../settings/settings.service');
  const companyPrompt = await getCompanyPrompt();
  const projectRow = task.projectId
    ? await db.query.projects.findFirst({
        columns: { name: true, prompt: true },
        where: { id: { eq: task.projectId } },
      })
    : undefined;
  const attachmentRows = await db.query.taskAttachments.findMany({
    columns: { id: true, kind: true, filename: true, mime: true, size: true },
    where: { taskId: { eq: taskId } },
    orderBy: { createdAt: 'asc' },
  });
  const attachments = attachmentRows
    .filter((a) => a.kind === 'input')
    .map((a) => ({
      id: a.id,
      filename: a.filename,
      mime: a.mime,
      size: a.size,
      remotePath: `~/.tandem/${taskId}/attachments/${a.filename}`,
    }));
  return {
    companyPrompt,
    projectPrompt: projectRow?.prompt ?? '',
    agent: person(assigneeId),
    agentInstructions: ai?.instructions ?? '',
    upChain: upLevels.map((lvl) => lvl.map(person)),
    directReports: downIds.map(person),
    extraChains: extra,
    task: {
      parentTitle,
      title: task.title,
      description: task.description,
      ownerName: task.ownerId ? nonNull(nameById.get(task.ownerId)) : null,
      ownerId: task.ownerId,
      reviewerNames: task.reviewers.map((id) => nameById.get(id)).filter((n): n is string => Boolean(n)),
      projectName: projectRow?.name ?? null,
    },
    recentActivity: [...recent, ...rejectedNotes.map((n) => ({ kind: 'note', authorName: 'system', body: n }))],
    relay: isRelay,
    attachments,
  };
}
