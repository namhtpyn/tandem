// Jev (TypeSafe AI System One) integration for task assignment.
// Sends task state + employee candidates, gets a typed Choice back.
// Never a hard dependency: unavailable/low-confidence -> caller keeps task unassigned.
import { getSetting } from './settings'
import { db } from '../db'
import { vaultSecrets } from '../db/schema'
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

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

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
  const secretId = await getSetting('jevApiKeySecretId')
  let key: string | null = null
  if (secretId) {
    const secRows = await db.select().from(vaultSecrets).where(eq(vaultSecrets.id, secretId))
    const secret = secRows[0]
    if (secret) key = decryptSecret(secret.ciphertext)
  }
  if (!key) {
    return { employeeId: null, confidence: 0, probabilities: {}, model: 'none', fallbackReason: 'jev api key not configured' }
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
    const res = await fetch(JEV_ENDPOINT, {
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
    const answer = body.answers?.assignee
    const choice = answer?.choice
    if (!choice) {
      return { employeeId: null, confidence: 0, probabilities: {}, model: body.model ?? 'unknown', fallbackReason: 'jev returned no choice' }
    }
    const confidence = answer?.confidence ?? 0
    if (choice === 'unassigned' || confidence < 0.5) {
      return { employeeId: null, confidence, probabilities: answer?.probabilities ?? {}, model: body.model, fallbackReason: choice === 'unassigned' ? 'jev chose unassigned' : `low confidence ${confidence.toFixed(2)}` }
    }
    const valid = params.candidates.some(c => c.id === choice)
    if (!valid) {
      return { employeeId: null, confidence, probabilities: answer?.probabilities ?? {}, model: body.model, fallbackReason: `jev returned unknown employee id` }
    }
    return { employeeId: choice, confidence, probabilities: answer?.probabilities ?? {}, model: body.model, fallbackReason: null }
  }
  catch {
    return { employeeId: null, confidence: 0, probabilities: {}, model: 'none', fallbackReason: 'could not reach jev endpoint' }
  }
}
