// Const-object "enums" law (AGENTS.md): frozen const objects, SCREAMING_SNAKE_CASE
// properties AND values, ValueOf-derived types, satisfies-validated grouping.
// Single source of truth for provider API endpoints — app, server, and tests all
// import from here.
//
// BASE URL LAW: a provider's baseUrl is the host root BEFORE /v1 (e.g.
// https://api.openai.com). Endpoint adapters append the full /v1/... path.
export type ValueOf<T> = T[keyof T]

export const PROVIDER_KIND = { LLM: 'LLM', DECISION: 'DECISION', MODELS: 'MODELS' } as const
export type ProviderKind = ValueOf<typeof PROVIDER_KIND>

export const PROVIDER_ENDPOINT = {
  [PROVIDER_KIND.LLM]: {
    'OPENAI-COMPLETIONS': 'OPENAI-COMPLETIONS',
    'OPENAI-RESPONSES': 'OPENAI-RESPONSES',
    'ANTHROPIC-MESSAGES': 'ANTHROPIC-MESSAGES',
  },
  [PROVIDER_KIND.DECISION]: {
    'TYPESAFE-SYSTEMONE': 'TYPESAFE-SYSTEMONE',
    'OPENAI-DECISIONS': 'OPENAI-DECISIONS',
  },
  [PROVIDER_KIND.MODELS]: {
    'OPENAI-MODELS': 'OPENAI-MODELS',
    'ANTHROPIC-MODELS': 'ANTHROPIC-MODELS',
    'TYPESAFE-MODELS': 'TYPESAFE-MODELS',
  },
} as const satisfies Record<ProviderKind, Record<string, string>>

export type LlmEndpoint = ValueOf<typeof PROVIDER_ENDPOINT['LLM']>
export type DecisionEndpoint = ValueOf<typeof PROVIDER_ENDPOINT['DECISION']>
export type ModelsEndpoint = ValueOf<typeof PROVIDER_ENDPOINT['MODELS']>
export type ProviderEndpoint = LlmEndpoint | DecisionEndpoint | ModelsEndpoint

/** Leaf path each endpoint appends to the host-root baseUrl (BASE URL LAW). */
export const ENDPOINT_PATH: { readonly [K in ProviderEndpoint]: string } = {
  [PROVIDER_ENDPOINT.LLM['OPENAI-COMPLETIONS']]: '/v1/chat/completions',
  [PROVIDER_ENDPOINT.LLM['OPENAI-RESPONSES']]: '/v1/responses',
  [PROVIDER_ENDPOINT.LLM['ANTHROPIC-MESSAGES']]: '/v1/messages',
  [PROVIDER_ENDPOINT.DECISION['TYPESAFE-SYSTEMONE']]: '/v1/systemone',
  [PROVIDER_ENDPOINT.DECISION['OPENAI-DECISIONS']]: '/v1/decisions',
  [PROVIDER_ENDPOINT.MODELS['OPENAI-MODELS']]: '/v1/models',
  [PROVIDER_ENDPOINT.MODELS['ANTHROPIC-MODELS']]: '/v1/models',
  [PROVIDER_ENDPOINT.MODELS['TYPESAFE-MODELS']]: '/v1/models',
}

// Human labels — mapped types keyed by the enum values, so adding an endpoint
// without a label is a compile error (exhaustiveness enforced).
export const PROVIDER_KIND_LABEL: { readonly [K in ProviderKind]: string } = {
  [PROVIDER_KIND.LLM]: 'LLM (agent models)',
  [PROVIDER_KIND.DECISION]: 'Decision (typed choices)',
  [PROVIDER_KIND.MODELS]: 'Models (/v1/models catalog)',
}

export const PROVIDER_ENDPOINT_LABEL: { readonly [K in ProviderEndpoint]: string } = {
  [PROVIDER_ENDPOINT.LLM['OPENAI-COMPLETIONS']]: 'OpenAI completions (/v1/chat/completions)',
  [PROVIDER_ENDPOINT.LLM['OPENAI-RESPONSES']]: 'OpenAI responses (/v1/responses)',
  [PROVIDER_ENDPOINT.LLM['ANTHROPIC-MESSAGES']]: 'Anthropic messages (/v1/messages)',
  [PROVIDER_ENDPOINT.DECISION['TYPESAFE-SYSTEMONE']]: 'TypeSafe System One (/v1/systemone)',
  [PROVIDER_ENDPOINT.DECISION['OPENAI-DECISIONS']]: 'OpenAI decisions (/v1/decisions)',
  [PROVIDER_ENDPOINT.MODELS['OPENAI-MODELS']]: 'OpenAI models (/v1/models)',
  [PROVIDER_ENDPOINT.MODELS['ANTHROPIC-MODELS']]: 'Anthropic models (/v1/models)',
  [PROVIDER_ENDPOINT.MODELS['TYPESAFE-MODELS']]: 'TypeSafe models (/v1/models)',
}

const LLM_ENDPOINTS: readonly LlmEndpoint[] = Object.values(PROVIDER_ENDPOINT[PROVIDER_KIND.LLM])
const DECISION_ENDPOINTS: readonly DecisionEndpoint[] = Object.values(PROVIDER_ENDPOINT[PROVIDER_KIND.DECISION])
const MODELS_ENDPOINTS: readonly ModelsEndpoint[] = Object.values(PROVIDER_ENDPOINT[PROVIDER_KIND.MODELS])

/** Reverse map derived from the same source — endpoint value -> kind. */
const ENDPOINT_KIND_LOOKUP: { readonly [K in ProviderEndpoint]: ProviderKind } = {
  ...Object.fromEntries(LLM_ENDPOINTS.map(s => [s, PROVIDER_KIND.LLM])),
  ...Object.fromEntries(DECISION_ENDPOINTS.map(s => [s, PROVIDER_KIND.DECISION])),
  ...Object.fromEntries(MODELS_ENDPOINTS.map(s => [s, PROVIDER_KIND.MODELS])),
} as { readonly [K in ProviderEndpoint]: ProviderKind }

/**
 * Which kind does an endpoint belong to? null when unknown.
 * Typed for unknown runtime input (DB rows, API payloads) — inside the app,
 * prefer `ENDPOINT_KIND_LOOKUP[endpoint]` on a ProviderEndpoint so the compiler
 * catches bad values.
 */
export function endpointKind(endpoint: string): ProviderKind | null {
  return (ENDPOINT_KIND_LOOKUP as Record<string, ProviderKind>)[endpoint] ?? null
}

/** Legacy alias for transitional callers. */
export const styleKind = endpointKind

export const ALL_ENDPOINTS = [...LLM_ENDPOINTS, ...DECISION_ENDPOINTS, ...MODELS_ENDPOINTS] as const
/** Legacy alias. */
export const ALL_API_STYLES = ALL_ENDPOINTS

/** True when the set speaks an Anthropic wire (auth headers for /models probes). */
export function isAnthropicWire(endpoints: string[]): boolean {
  return endpoints.includes(PROVIDER_ENDPOINT.LLM['ANTHROPIC-MESSAGES'])
    || endpoints.includes(PROVIDER_ENDPOINT.MODELS['ANTHROPIC-MODELS'])
}

/** All catalog endpoints (/v1/models variants). */
const MODELS_ENDPOINT_SET: ReadonlySet<string> = new Set(MODELS_ENDPOINTS)

export function isModelsEndpoint(endpoint: string): boolean {
  return MODELS_ENDPOINT_SET.has(endpoint)
}

/** At most one /v1/models endpoint per provider (server-enforced in providers.save too). */
export function atMostOneModelsEndpoint(endpoints: string[]): boolean {
  return endpoints.filter(isModelsEndpoint).length <= 1
}

/** Flat items for USelect/USelectMenu with group separator rows (LLM, Decision, Models). */
export const ENDPOINT_OPTIONS: Array<{ label: string, value?: string, type?: 'label' }> = [
  { label: PROVIDER_KIND_LABEL[PROVIDER_KIND.LLM], type: 'label' },
  ...LLM_ENDPOINTS.map(s => ({ label: PROVIDER_ENDPOINT_LABEL[s], value: s })),
  { label: PROVIDER_KIND_LABEL[PROVIDER_KIND.DECISION], type: 'label' },
  ...DECISION_ENDPOINTS.map(s => ({ label: PROVIDER_ENDPOINT_LABEL[s], value: s })),
  { label: PROVIDER_KIND_LABEL[PROVIDER_KIND.MODELS], type: 'label' },
  ...MODELS_ENDPOINTS.map(s => ({ label: PROVIDER_ENDPOINT_LABEL[s], value: s })),
]
