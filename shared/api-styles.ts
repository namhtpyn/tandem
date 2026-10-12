// Const-object "enums" law (AGENTS.md): frozen const objects, SCREAMING_SNAKE_CASE
// properties AND values, ValueOf-derived types, satisfies-validated grouping.
// Single source of truth for provider API styles — app, server, and tests all
// import from here.
export type ValueOf<T> = T[keyof T]

export const PROVIDER_KIND = { LLM: 'LLM', DECISION: 'DECISION' } as const
export type ProviderKind = ValueOf<typeof PROVIDER_KIND>

export const PROVIDER_API_STYLE = {
  [PROVIDER_KIND.LLM]: {
    'OPENAI-COMPLETIONS': 'OPENAI-COMPLETIONS',
    'OPENAI-RESPONSES': 'OPENAI-RESPONSES',
    'OPENAI-AGENTS': 'OPENAI-AGENTS',
    'OPENAI-MODELS': 'OPENAI-MODELS',
    'ANTHROPIC-MESSAGES': 'ANTHROPIC-MESSAGES',
    'ANTHROPIC-SKILLS': 'ANTHROPIC-SKILLS',
  },
  [PROVIDER_KIND.DECISION]: {
    'TYPESAFE-SYSTEMONE': 'TYPESAFE-SYSTEMONE',
    'OPENAI-DECISIONS': 'OPENAI-DECISIONS',
  },
} as const satisfies Record<ProviderKind, Record<string, string>>

export type LlmApiStyle = ValueOf<typeof PROVIDER_API_STYLE['LLM']>
export type DecisionApiStyle = ValueOf<typeof PROVIDER_API_STYLE['DECISION']>
export type ProviderApiStyle = LlmApiStyle | DecisionApiStyle

// Human labels — Record<> keyed by the enum values, so adding a style without a
// label is a compile error (exhaustiveness enforced).
export const PROVIDER_KIND_LABEL: { readonly [K in ProviderKind]: string } = {
  [PROVIDER_KIND.LLM]: 'LLM (agent models)',
  [PROVIDER_KIND.DECISION]: 'Decision (typed choices)',
}

export const PROVIDER_API_STYLE_LABEL: { readonly [K in ProviderApiStyle]: string } = {
  [PROVIDER_API_STYLE.LLM['OPENAI-COMPLETIONS']]: 'OpenAI completions (/v1/chat/completions)',
  [PROVIDER_API_STYLE.LLM['OPENAI-RESPONSES']]: 'OpenAI responses (/v1/responses)',
  [PROVIDER_API_STYLE.LLM['OPENAI-AGENTS']]: 'OpenAI agents (Responses + tools)',
  [PROVIDER_API_STYLE.LLM['OPENAI-MODELS']]: 'OpenAI models (/v1/models)',
  [PROVIDER_API_STYLE.LLM['ANTHROPIC-MESSAGES']]: 'Anthropic messages (/v1/messages)',
  [PROVIDER_API_STYLE.LLM['ANTHROPIC-SKILLS']]: 'Anthropic skills (messages + skills)',
  [PROVIDER_API_STYLE.DECISION['TYPESAFE-SYSTEMONE']]: 'TypeSafe System One (/v1/systemone)',
  [PROVIDER_API_STYLE.DECISION['OPENAI-DECISIONS']]: 'OpenAI decisions (/v1/decisions)',
}

const LLM_STYLES: readonly LlmApiStyle[] = Object.values(PROVIDER_API_STYLE[PROVIDER_KIND.LLM])
const DECISION_STYLES: readonly DecisionApiStyle[] = Object.values(PROVIDER_API_STYLE[PROVIDER_KIND.DECISION])

/** Reverse map derived from the same source — style value -> kind. */
const STYLE_KIND_LOOKUP: { readonly [K in ProviderApiStyle]: ProviderKind } = {
  ...Object.fromEntries(LLM_STYLES.map(s => [s, PROVIDER_KIND.LLM])),
  ...Object.fromEntries(DECISION_STYLES.map(s => [s, PROVIDER_KIND.DECISION])),
} as { readonly [K in ProviderApiStyle]: ProviderKind }

/**
 * Which kind does a style belong to? null when unknown.
 * Typed for unknown runtime input (DB rows, API payloads) — inside the app,
 * prefer `STYLE_KIND_LOOKUP[style]` on a ProviderApiStyle so the compiler
 * catches bad values.
 */
export function styleKind(style: string): ProviderKind | null {
  return (STYLE_KIND_LOOKUP as Record<string, ProviderKind>)[style] ?? null
}

export const ALL_API_STYLES = [...LLM_STYLES, ...DECISION_STYLES] as const

/** True when the style set speaks an Anthropic wire (affects /models probe headers/path). */
export function isAnthropicWire(styles: string[]): boolean {
  return styles.includes(PROVIDER_API_STYLE.LLM['ANTHROPIC-MESSAGES'])
    || styles.includes(PROVIDER_API_STYLE.LLM['ANTHROPIC-SKILLS'])
}

/** Flat items for USelect/USelectMenu with group separator rows (LLM group first). */
export const API_STYLE_OPTIONS: Array<{ label: string, value?: string, type?: 'label' }> = [
  { label: PROVIDER_KIND_LABEL[PROVIDER_KIND.LLM], type: 'label' },
  ...LLM_STYLES.map(s => ({ label: PROVIDER_API_STYLE_LABEL[s], value: s })),
  { label: PROVIDER_KIND_LABEL[PROVIDER_KIND.DECISION], type: 'label' },
  ...DECISION_STYLES.map(s => ({ label: PROVIDER_API_STYLE_LABEL[s], value: s })),
]
