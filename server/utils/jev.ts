// Jev (TypeSafe AI System One) integration for task assignment.
// Sends task state + employee candidates, gets a typed Choice back.
// Never a hard dependency: unavailable/low-confidence -> caller keeps task unassigned.
import { db } from '../db'
import { vaultSecrets, modelProviders } from '../db/schema'
import { eq } from 'drizzle-orm'
import { decryptSecret } from './vault-crypto'

export interface JevAssignCandidate {
  id: string
  name: string
  kind: 'human' | 'ai'
  title: string | null
  /** rough load: open tasks currently assigned */
  openTasks: number
}

export interface JevAssignResult {
  employeeId: string | null
  confidence: number
  probabilities: Record<string, number>
  model: string
  fallbackReason: string | null
}

/** The configured decision provider (first kind='decision' row, e.g. seed-jev). */
export async function getDecisionProvider(): Promise<{ id: string, label: string, baseUrl: string, keySecretId: string | null } | null> {
  const rows = await db.select().from(modelProviders).where(eq(modelProviders.kind, 'decision'))
  const p = rows[0]
  if (!p) return null
  return { id: p.id, label: p.label, baseUrl: p.baseUrl, keySecretId: p.keySecretId }
}

/** Ask Jev which employee should take the task. Returns null employeeId on any failure/low confidence. */
export async function jevPickAssignee(params: {
  taskTitle: string
  taskDescription: string
  projectName: string | null
  candidates: JevAssignCandidate[]
}): Promise<JevAssignResult> {
  if (params.candidates.length === 0) {
    return { employeeId: null, confidence: 0, probabilities: {}, model: 'none', fallbackReason: 'no assignee candidates' }
  }
  const provider = await getDecisionProvider()
  if (!provider) {
    return { employeeId: null, confidence: 0, probabilities: {}, model: 'none', fallbackReason: 'no decision provider configured' }
  }
  let key: string | null = null
  if (provider.keySecretId) {
    const secRows = await db.select().from(vaultSecrets).where(eq(vaultSecrets.id, provider.keySecretId))
    const secret = secRows[0]
    if (secret) key = decryptSecret(secret.ciphertext)
  }
  if (!key) {
    return { employeeId: null, confidence: 0, probabilities: {}, model: 'none', fallbackReason: 'decision provider has no api key' }
  }

  const state = [
    `Task: ${params.taskTitle}`,
    params.taskDescription ? `Description: ${params.taskDescription}` : '',
    params.projectName ? `Project: ${params.projectName}` : '',
    'Candidates (id | kind | title | open task load):',
    ...params.candidates.map(c => `- ${c.id} | ${c.kind} | ${c.title ?? 'no title'} | ${c.openTasks} open tasks`),
  ].filter(Boolean).join('\n')

  const criteria: Record<string, string> = {
    unassigned: 'No candidate fits; leave the task unassigned for a human decision',
  }
  for (const c of params.candidates) {
    criteria[c.id] = `${c.kind === 'ai' ? 'AI agent' : 'Human'} — ${c.name}${c.title ? `, ${c.title}` : ''}${c.openTasks > 0 ? `, currently ${c.openTasks} open task(s)` : ', no open tasks'}`
  }

  try {
    const res = await fetch(provider.baseUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state,
        model: 'jev-latest',
        questions: {
          assignee: {
            type: 'choice',
            instructions: 'Which employee should be assigned this task? Consider skills implied by the title, current workload, and whether an AI agent or human fits better. AI agents suit autonomous digital work; humans suit judgment, external communication, or physical tasks.',
            criteria,
          },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      return { employeeId: null, confidence: 0, probabilities: {}, model: 'none', fallbackReason: `jev endpoint returned ${res.status}` }
    }
    const body = (await res.json()) as {
      model: string
      answers?: { assignee?: { choice?: string, confidence?: number, probabilities?: Record<string, number> } }
    }
    const answers = body.answers
    const answer = answers && answers.assignee
    const choice = answer ? answer.choice : undefined
    if (!choice) {
      const model = body.model
      return { employeeId: null, confidence: 0, probabilities: {}, model: model || 'unknown', fallbackReason: 'jev returned no choice' }
    }
    const confidence = answer && typeof answer.confidence === 'number' ? answer.confidence : 0
    const probabilities = answer && answer.probabilities ? answer.probabilities : {}
    if (choice === 'unassigned' || confidence < 0.5) {
      const reason = choice === 'unassigned' ? 'jev chose unassigned' : `low confidence ${confidence.toFixed(2)}`
      return { employeeId: null, confidence, probabilities, model: body.model, fallbackReason: reason }
    }
    const valid = params.candidates.some(c => c.id === choice)
    if (!valid) {
      return { employeeId: null, confidence, probabilities, model: body.model, fallbackReason: `jev returned unknown employee id` }
    }
    return { employeeId: choice, confidence, probabilities, model: body.model, fallbackReason: null }
  }
  catch {
    return { employeeId: null, confidence: 0, probabilities: {}, model: 'none', fallbackReason: 'could not reach jev endpoint' }
  }
}
