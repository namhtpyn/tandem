// Per-task brief: identity + org chains + task context + mention chains + output contract.
// Pure functions — no I/O; loadBriefData gathers rows.
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { tasks, user as userTable, aiEmployees, employeeSupervisors, taskActivity } from '../../db/schema'

export interface BriefPerson { id: string, name: string, title: string | null, kind: string }

/** mentions in the description: @[Label](id) tiptap links, HTML spans, or plain @Label tokens.
 * Labels resolve against known employee names (mention menu only offers employees), so
 * plain @Name matching is exact-by-construction, never fuzzy. */
export function extractMentionedEmployeeIds(description: string, nameToId: Map<string, string>): string[] {
  const ids = new Set<string>()
  for (const m of description.matchAll(/@\[[^\]]*\]\(mention-([^)]+)\)/g)) ids.add(m[1]!)
  for (const m of description.matchAll(/\[@ label="([^"]+)"\]/g)) {
    const id = nameToId.get(m[1]!)
    if (id) ids.add(id)
  }
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\$&')
  for (const [name, id] of nameToId) {
    const re = new RegExp(`@${esc(name)}(?![\p{L}\p{N}])`, 'u')
    if (re.test(description)) ids.add(id)
  }
  return [...ids]
}

export function chainToRoot(startId: string, edges: Array<{ employeeId: string, supervisorId: string }>): string[] {
  const byEmployee = new Map(edges.map(e => [e.employeeId, e.supervisorId]))
  const chain: string[] = []
  let cur: string | undefined = byEmployee.get(startId)
  const seen = new Set([startId])
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    chain.push(cur)
    cur = byEmployee.get(cur)
  }
  return chain
}

export function buildBrief(input: {
  agent: BriefPerson
  agentInstructions: string
  upChain: BriefPerson[]
  directReports: BriefPerson[]
  extraChains: Array<{ person: BriefPerson, chain: BriefPerson[] }>
  task: { title: string, description: string, ownerName: string | null, reviewerNames: string[], projectName: string | null, url: string }
  recentActivity: Array<{ kind: string, authorName: string | null, body: string | null }>
}): string {
  const lines: string[] = []
  lines.push(`You are ${input.agent.name}${input.agent.title ? `, ${input.agent.title}` : ''}.`)
  if (input.upChain.length) lines.push(`You report to: ${input.upChain.map(p => personLine(p)).join(' -> ')}.`)
  else lines.push('You report to: (nobody — top of organization).')
  if (input.directReports.length) lines.push(`Reports to you: ${input.directReports.map(personLine).join(', ')}.`)
  if (input.agentInstructions.trim()) lines.push(`Standing instructions: ${input.agentInstructions.trim()}`)
  for (const c of input.extraChains) {
    if (c.chain.length) lines.push(`${c.person.name}: ${personLine(c.person)}; their chain: ${c.chain.map(personLine).join(' -> ')}.`)
    else lines.push(`${c.person.name}: ${personLine(c.person)}; their chain: (unknown).`)
  }
  lines.push('')
  lines.push('TASK (via Tandem)')
  lines.push(`Title: ${input.task.title}`)
  if (input.task.description.trim()) lines.push(`Description: ${stripMentions(input.task.description)}`)
  lines.push(`Owner: ${input.task.ownerName ?? 'unassigned'}`)
  if (input.task.reviewerNames.length) lines.push(`Reviewers (all must approve): ${input.task.reviewerNames.join(', ')}`)
  if (input.task.projectName) lines.push(`Project: ${input.task.projectName}`)
  lines.push(`Workspace: ${input.task.url}`)
  if (input.recentActivity.length) {
    lines.push('')
    lines.push('Recent activity on this task (oldest first):')
    for (const a of input.recentActivity) lines.push(`- ${a.kind} by ${a.authorName ?? 'system'}: ${trunc(a.body ?? '', 200)}`)
  }
  lines.push('')
  lines.push('OUTPUT CONTRACT — end your response with exactly one of these lines:')
  lines.push('[RESULT] <final answer or summary of work done>')
  lines.push('[QUESTION] <blocking question for the owner>')
  lines.push('[BLOCKED] <what you need and from whom>')
  return lines.join('\n')
}

function personLine(p: BriefPerson): string {
  return p.title ? `${p.name} (${p.title})` : p.name
}

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/** mentions -> plain Name refs for the prompt (agent sees names, not markdown ids) */
function stripMentions(desc: string): string {
  return desc.replace(/@\[([^\]]*)\]\(mention-[^)]+\)/g, (_m, label) => `${label}`).trim()
}

/** gather everything the brief needs from the DB (single dispatch-time read) */
export async function loadBriefData(taskId: string, tandemUrl: string) {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
  if (!task) throw new Error('task not found')
  const assigneeId = task.assigneeId!
  const edges = await db.select().from(employeeSupervisors)
  const users = await db.select({ id: userTable.id, name: userTable.name, title: userTable.title }).from(userTable)
  const aiRows = await db.select().from(aiEmployees)
  const aiById = new Map(aiRows.map(r => [r.userId, r]))
  const person = (id: string): BriefPerson => {
    const u = users.find(x => x.id === id)!
    return { id, name: u!.name, title: u!.title || null, kind: aiById.has(id) ? 'ai' : 'human' }
  }
  const upIds = chainToRoot(assigneeId, edges)
  const downIds = edges.filter(e => e.supervisorId === assigneeId).map(e => e.employeeId)
  const nameToId = new Map(users.map(u => [u.name, u.id] as const))
  const mentionIds = extractMentionedEmployeeIds(task.description, nameToId)
  const extra: Array<{ person: BriefPerson, chain: BriefPerson[] }> = []
  for (const mid of mentionIds) {
    if (mid === assigneeId || upIds.includes(mid) || downIds.includes(mid)) continue
    if (!users.some(u => u.id === mid)) continue
    extra.push({ person: person(mid), chain: chainToRoot(mid, edges).map(person) })
  }
  const activity = await db.select().from(taskActivity).where(eq(taskActivity.taskId, taskId))
  activity.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  const nameById = new Map(users.map(u => [u.id, u.name]))
  const recent = activity.slice(-20).map(a => ({ kind: a.kind, authorName: a.authorId ? nameById.get(a.authorId)! : null, body: a.body! }))
  const ai = aiById.get(assigneeId)
  return {
    agent: person(assigneeId),
    agentInstructions: ai?.instructions ?? '',
    upChain: upIds.map(person),
    directReports: downIds.map(person),
    extraChains: extra,
    task: {
      title: task.title,
      description: task.description,
      ownerName: task.ownerId ? nameById.get(task.ownerId)! : null,
      reviewerNames: task.reviewers.map(id => nameById.get(id)).filter((n): n is string => Boolean(n)),
      projectName: null,
      url: `${tandemUrl}/tasks/${task.id}`,
    },
    recentActivity: recent,
  }
}
