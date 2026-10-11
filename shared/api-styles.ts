// Const-object "enums" law (AGENTS.md): frozen const objects, ValueOf-derived
// types, satisfies-validated grouping. Single source of truth for provider API
// styles — app, server, and tests all import from here.
export type ValueOf<T> = T[keyof T]

export const providerKind = { LLM: 'LLM', DECISION: 'DECISION' } as const
export type ProviderKind = ValueOf<typeof providerKind>

export const apiStyles = {
  [providerKind.LLM]: {
    'OPENAI-COMPLETIONS': 'OPENAI-COMPLETIONS',
    'OPENAI-RESPONSES': 'OPENAI-RESPONSES',
    'OPENAI-AGENTS': 'OPENAI-AGENTS',
    'OPENAI-MODELS': 'OPENAI-MODELS',
    'ANTHROPIC-MESSAGES': 'ANTHROPIC-MESSAGES',
    'ANTHROPIC-SKILLS': 'ANTHROPIC-SKILLS',
  },
  [providerKind.DECISION]: {
    'TYPESAFE-SYSTEMONE': 'TYPESAFE-SYSTEMONE',
    'OPENAI-DECISIONS': 'OPENAI-DECISIONS',
  },
} as const satisfies Record<ProviderKind, Record<string, string>>

export type ApiStyle = ValueOf<ValueOf<typeof apiStyles>>

const LLM_STYLES = Object.keys(apiStyles.LLM)
const DECISION_STYLES = Object.keys(apiStyles.DECISION)

/** Which kind does a style belong to? null when unknown. */
export function styleKind(style: string): ProviderKind | null {
  if (LLM_STYLES.includes(style)) return providerKind.LLM
  if (DECISION_STYLES.includes(style)) return providerKind.DECISION
  return null
}

export const allApiStyles: [string, ...string[]] = [...LLM_STYLES, ...DECISION_STYLES] as [string, ...string[]]

/** True when the style speaks an Anthropic wire (affects /models probe headers/path). */
export function isAnthropicWire(styles: string[]): boolean {
  return styles.includes('ANTHROPIC-MESSAGES') || styles.includes('ANTHROPIC-SKILLS')
}

/** Flat items for USelect/USelectMenu with group separator rows (LLM first). */
export const apiStyleOptions: Array<{ label: string, value?: string, type?: 'label' }> = [
  { label: 'LLM (agent models)', type: 'label' },
  ...LLM_STYLES.map(s => ({ label: s, value: s })),
  { label: 'Decision (typed choices)', type: 'label' },
  ...DECISION_STYLES.map(s => ({ label: s, value: s })),
]
