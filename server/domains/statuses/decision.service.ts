import {
  PROVIDER_ENDPOINT,
  PROVIDER_KIND,
  endpointKind,
  ENDPOINT_PATH,
  type DecisionEndpoint,
} from '#shared/api-styles';

// Jev (TypeSafe AI System One) integration for task assignment.
// Sends task state + employee candidates, gets a typed Choice back.
// Never a hard dependency: unavailable/low-confidence -> caller keeps task unassigned.
import { db } from '../../db/index';
import { decryptSecret } from '../vault/secret/secret-crypto.service';

export type JevAssignCandidate = {
  id: string;
  name: string;
  kind: 'human' | 'ai';
  title: string | null;
  /** rough load: open tasks currently assigned */
  openTasks: number;
};

export type JevAssignResult = {
  employeeId: string | null;
  confidence: number;
  probabilities: Record<string, number>;
  model: string;
  fallbackReason: string | null;
};

/** Normalized pick returned by every decision adapter. */
export type DecisionPick = {
  employeeId: string | null;
  confidence: number;
  probabilities: Record<string, number>;
  model: string;
  fallbackReason: string | null;
};

/** The configured decision provider: first row carrying a DECISION api style. */
export async function getDecisionProvider(): Promise<{
  id: string;
  label: string;
  baseUrl: string;
  endpoints: string[];
} | null> {
  const rows = await db.query.modelProviders.findMany({
    columns: { id: true, label: true, baseUrl: true, endpoints: true },
    orderBy: { id: 'asc' },
  });
  const p = rows.find((r) => (r.endpoints as string[]).some((st) => endpointKind(st) === PROVIDER_KIND.DECISION));
  if (!p) return null;
  return { id: p.id, label: p.label, baseUrl: p.baseUrl, endpoints: p.endpoints as string[] };
}

/** the uniform "don't assign" result every failure path returns */
function noPick(fallbackReason: string) {
  return {
    employeeId: null,
    confidence: 0,
    probabilities: {},
    model: 'none',
    fallbackReason,
  };
}

/** serialize task + candidates into the model's state text */
function decisionState(params: {
  taskTitle: string;
  taskDescription: string;
  projectName: string | null;
  candidates: JevAssignCandidate[];
}) {
  return [
    `Task: ${params.taskTitle}`,
    params.taskDescription ? `Description: ${params.taskDescription}` : '',
    params.projectName ? `Project: ${params.projectName}` : '',
    'Candidates (id | kind | title | open task load):',
    ...params.candidates.map((c) => `- ${c.id} | ${c.kind} | ${c.title ?? 'no title'} | ${c.openTasks} open tasks`),
  ]
    .filter(Boolean)
    .join('\n');
}

/** one human-readable criterion per candidate, keyed by employee id */
function candidateCriteria(candidates: JevAssignCandidate[]) {
  const criteria: Record<string, string> = {
    unassigned: 'No candidate fits; leave the task unassigned for a human decision',
  };
  for (const c of candidates) {
    criteria[c.id] =
      `${c.kind === 'ai' ? 'AI agent' : 'Human'} — ${c.name}${c.title ? `, ${c.title}` : ''}${c.openTasks > 0 ? `, currently ${c.openTasks} open task(s)` : ', no open tasks'}`;
  }
  return criteria;
}

/** Ask Jev which employee should take the task. Returns null employeeId on any failure/low confidence. */
export async function pickAssignee(params: {
  taskTitle: string;
  taskDescription: string;
  projectName: string | null;
  candidates: JevAssignCandidate[];
  /** vault secret id with the decision endpoint's api key (per call, never stored on the provider) */
  keySecretId: string | null;
  /** model pin from the Workspace AI assignment (null = the endpoint default) */
  model: string | null;
}) {
  if (params.candidates.length === 0) {
    return noPick('no assignee candidates');
  }
  const provider = await getDecisionProvider();
  if (!provider) {
    return noPick('no decision provider configured');
  }
  let key: string | null = null;
  if (params.keySecretId) {
    const secRows = await db.query.vaultSecrets.findMany({
      columns: { ciphertext: true },
      where: { id: { eq: params.keySecretId } },
      orderBy: { id: 'asc' },
    });
    const secret = secRows[0];
    if (secret) {
      key = decryptSecret(secret.ciphertext);
    }
  }
  if (!key) {
    return noPick('no api key secret provided');
  }

  const state = decisionState(params);

  const instructions = INSTRUCTIONS;
  const criteria = candidateCriteria(params.candidates);

  try {
    let raw: DecisionPick;
    const preferred: DecisionEndpoint = provider.endpoints.includes(PROVIDER_ENDPOINT.DECISION['OPENAI-DECISIONS'])
      ? PROVIDER_ENDPOINT.DECISION['OPENAI-DECISIONS']
      : PROVIDER_ENDPOINT.DECISION['TYPESAFE-SYSTEMONE'];
    switch (preferred) {
      case PROVIDER_ENDPOINT.DECISION['OPENAI-DECISIONS']:
        raw = await askOpenAIDecisions(provider.baseUrl, key, state, instructions, criteria, params.model);
        break;
      // TYPESAFE-SYSTEMONE is the fallback endpoint
      default:
        raw = await askTypesafeSystemOne(provider.baseUrl, key, state, instructions, criteria, params.model);
    }
    // compile-time exhaustiveness: adding a DecisionApiStyle without a case
    // above fails this assignment (raw stays undefined -> typed never match)
    raw satisfies DecisionPick | undefined;

    // confidence must be a finite number in [0,1]: NaN would sail past the
    // `confidence < 0.5` comparison (all NaN comparisons are false) and assign
    const confOk =
      typeof raw.confidence === 'number' &&
      Number.isFinite(raw.confidence) &&
      raw.confidence >= 0 &&
      raw.confidence <= 1;

    // shared validation on the normalized pick
    if (!raw.employeeId) return raw;
    if (raw.employeeId === 'unassigned' || !confOk || raw.confidence < 0.5) {
      const reason =
        raw.employeeId === 'unassigned'
          ? 'decision model chose unassigned'
          : `low confidence ${Number(raw.confidence).toFixed(2)}`;
      return { ...raw, employeeId: null, fallbackReason: reason };
    }
    const valid = params.candidates.some((c) => c.id === raw.employeeId);
    if (!valid) {
      return { ...raw, employeeId: null, fallbackReason: 'decision model returned unknown employee id' };
    }
    return raw;
  } catch {
    return noPick('could not reach decision endpoint');
  }
}

const INSTRUCTIONS =
  'Which employee should be assigned this task? Consider skills implied by the title, current workload, and whether an AI agent or human fits better. AI agents suit autonomous digital work; humans suit judgment, external communication, or physical tasks.';

/** TypeSafe System One: state + questions map, answers map keyed by question id. */
async function askTypesafeSystemOne(
  baseUrl: string,
  key: string,
  state: string,
  instructions: string,
  criteria: Record<string, string>,
  model: string | null,
) {
  const url = buildEndpointUrl(baseUrl, PROVIDER_ENDPOINT.DECISION['TYPESAFE-SYSTEMONE']);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state,
      model,
      questions: {
        assignee: { type: 'choice', instructions, criteria },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    return {
      employeeId: null,
      confidence: 0,
      probabilities: {},
      model: 'none',
      fallbackReason: `decision endpoint returned ${res.status}`,
    };
  }
  const body = (await res.json()) as {
    model: string;
    answers?: { assignee?: { choice?: string; confidence?: number; probabilities?: Record<string, number> } };
  };
  const answer = body.answers && body.answers.assignee;
  const choice = answer ? answer.choice : undefined;
  if (!choice) {
    const model = body.model;
    return {
      employeeId: null,
      confidence: 0,
      probabilities: {},
      model: model || 'unknown',
      fallbackReason: 'no choice in answer',
    };
  }
  const confidence = answer && typeof answer.confidence === 'number' ? answer.confidence : 0;
  const probabilities = answer && answer.probabilities ? answer.probabilities : {};
  return { employeeId: choice, confidence, probabilities, model: body.model, fallbackReason: null };
}

/** OpenAI Decisions: input + questions array, answers array (name-keyed). */
async function askOpenAIDecisions(
  baseUrl: string,
  key: string,
  state: string,
  instructions: string,
  criteria: Record<string, string>,
  model: string | null,
) {
  const url = buildEndpointUrl(baseUrl, PROVIDER_ENDPOINT.DECISION['OPENAI-DECISIONS']);
  const choices = Object.entries(criteria).map(([value, description]) => ({ value, description }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: state,
      questions: [
        {
          type: 'choice',
          name: 'assignee',
          instructions,
          choices,
        },
      ],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    return {
      employeeId: null,
      confidence: 0,
      probabilities: {},
      model: 'none',
      fallbackReason: `decision endpoint returned ${res.status}`,
    };
  }
  const body = (await res.json()) as {
    model: string;
    answers?: Array<{
      name?: string | null;
      type?: string;
      choice?: string | boolean;
      confidence?: number;
      probabilities?: Array<{ value: string | boolean; probability: number }>;
    }>;
  };
  const answer = body.answers && body.answers.find((a) => a && a.name === 'assignee');
  if (!answer || typeof answer.choice !== 'string') {
    const model = body.model;
    return {
      employeeId: null,
      confidence: 0,
      probabilities: {},
      model: model || 'unknown',
      fallbackReason: 'no choice in answer',
    };
  }
  const confidence = typeof answer.confidence === 'number' ? answer.confidence : 0;
  const probabilities: Record<string, number> = {};
  if (answer.probabilities) {
    for (const p of answer.probabilities) {
      if (typeof p.value === 'string') probabilities[p.value] = p.probability;
    }
  }
  return { employeeId: answer.choice, confidence, probabilities, model: body.model, fallbackReason: null };
}

/**
 * Build the full URL for an endpoint: baseUrl is the host root BEFORE /v1
 * (BASE URL LAW); the endpoint's leaf path is appended. Tolerance: when the
 * baseUrl already ends with the leaf path, it is not doubled.
 */
export function buildEndpointUrl(
  baseUrl: string,
  endpoint: DecisionEndpoint | import('#shared/api-styles').ProviderEndpoint,
) {
  const root = baseUrl.replace(/\/$/, '');
  const leaf = ENDPOINT_PATH[endpoint as keyof typeof ENDPOINT_PATH];
  return root.endsWith(leaf) ? root : `${root}${leaf}`;
}
