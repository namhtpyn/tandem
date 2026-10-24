import { and, eq } from 'drizzle-orm';

import { PROPOSAL_STATUS } from '#shared/enums';
import { RunVerdictSchema } from '#shared/run-verdict';
import { renderOutputContract } from '#shared/structured-output';
// Per-task brief: identity + org chains + task context + mention chains + output contract.
// Pure functions — no I/O; loadBriefData gathers rows.
import { nonNull } from '#shared/utils/non-null';

import { db } from '../../db/index';
import { taskProposals } from '../../db/schema';
import { stripAttachments } from './attachments.util';

export type BriefPerson = { id: string; name: string; title: string | null; kind: string };

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
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '$&');
  for (const [name, id] of nameToId) {
    const re = new RegExp(`@${esc(name)}(?![p{L}p{N}])`, 'u');
    if (re.test(description)) ids.add(id);
  }
  return [...ids];
}

export function chainToRoot(startId: string, edges: Array<{ employeeId: string; supervisorId: string }>) {
  const byEmployee = new Map(edges.map((e) => [e.employeeId, e.supervisorId]));
  const chain: string[] = [];
  let cur: string | undefined = byEmployee.get(startId);
  const seen = new Set([startId]);
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = byEmployee.get(cur);
  }
  return chain;
}

type BriefInput = {
  companyPrompt?: string;
  projectPrompt?: string;
  agent: BriefPerson;
  agentInstructions: string;
  upChain: BriefPerson[];
  directReports: BriefPerson[];
  extraChains: Array<{ person: BriefPerson; chain: BriefPerson[] }>;
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
  attachments?: Array<{ id: string; filename: string; mime: string; size: number; remotePath: string }>;
};

export function buildBrief(input: BriefInput) {
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
  if (input.upChain.length) lines.push(`You report to: ${input.upChain.map((p) => personLine(p)).join(' -> ')}.`);
  else lines.push('You report to: (nobody — top of organization).');
  if (input.directReports.length) lines.push(`Reports to you: ${input.directReports.map(personLine).join(', ')}.`);
  if (input.agentInstructions.trim()) lines.push(`Standing instructions: ${input.agentInstructions.trim()}`);
  for (const c of input.extraChains) {
    if (c.chain.length)
      lines.push(`${c.person.name}: ${personLine(c.person)}; their chain: ${c.chain.map(personLine).join(' -> ')}.`);
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
    lines.push(`- ${a.kind.toLowerCase()} by ${a.authorName ?? 'system'}: ${trunc(a.body ?? '', 200)}`);
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
    `DELIVERABLES — write any output files to ${input.outDir} (create it if needed; that EXACT path, not the environment name); everything left there when you exit is collected and attached to your result.`,
    '',
    renderOutputContract(RunVerdictSchema, {
      intro: 'OUTPUT CONTRACT — end your response with exactly one JSON line (no code fence):',
      examples: [
        '{"kind": "result", "body": "<final answer or summary of work done>"}',
        '{"kind": "question", "body": "<blocking question for the owner>"}',
        '{"kind": "blocked", "body": "<what you need and from whom>"}',
      ],
    }),
    '',
    'ROUTING — if part of this task belongs to someone else, also add a routing line (routing to people inside your own supervision chain executes immediately; anything outside your chain goes to a human for confirmation):',
    '[SUBTASKS] <title> :: <description> :: <suggested assignee name> | <another subtask> (propose subtasks; suggest assignees from people you know above — outside your chain gets escalated to your supervisor)',
    '[REASSIGN] <employee name> — <reason> (only when the WHOLE task belongs to someone else)',
  ];
}

function personLine(p: BriefPerson) {
  return p.title ? `${p.name} (${p.title})` : p.name;
}

function trunc(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** mentions -> plain Name refs for the prompt (agent sees names, not markdown ids) */
function stripMentions(desc: string) {
  return desc.replace(/@\[([^\]]*)\]\(mention-[^)]+\)/g, (_m, label) => `${label}`).trim();
}

/** gather everything the brief needs from the DB (single dispatch-time read) */
export async function loadBriefData(taskId: string) {
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
  const rejectedNotes = (
    await db
      .select()
      .from(taskProposals)
      .where(and(eq(taskProposals.taskId, taskId), eq(taskProposals.status, PROPOSAL_STATUS.REJECTED)))
  )
    .filter((p) => p.decisionNote)
    .map((p) => `- proposal declined: ${p.kind} — ${trunc(p.decisionNote, 200)}`);
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
  const upIds = chainToRoot(assigneeId, edges);
  const downIds = edges.filter((e) => e.supervisorId === assigneeId).map((e) => e.employeeId);
  const nameToId = new Map(users.map((u) => [u.name, u.id] as const));
  const mentionIds = extractMentionedEmployeeIds(task.description, nameToId);
  const extra: Array<{ person: BriefPerson; chain: BriefPerson[] }> = [];
  for (const mid of mentionIds) {
    if (mid === assigneeId || upIds.includes(mid) || downIds.includes(mid)) continue;
    if (!users.some((u) => u.id === mid)) continue;
    extra.push({ person: person(mid), chain: chainToRoot(mid, edges).map(person) });
  }
  const activity = await db.query.taskActivity.findMany({
    columns: { kind: true, authorId: true, body: true, createdAt: true },
    where: { taskId: { eq: taskId } },
    orderBy: { createdAt: 'asc' },
  });
  activity.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  const recent = activity.slice(-20).map((a) => ({
    kind: a.kind,
    authorName: a.authorId ? nonNull(nameById.get(a.authorId)) : null,
    body: nonNull(a.body),
  }));
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
    upChain: upIds.map(person),
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
    attachments,
  };
}
