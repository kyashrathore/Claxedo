import type { ClaudeRequestUsage } from "./adapter-state"

export type ClaudeContextWindow = { model: string; size: number }

export type ClaudeTranslatorMemory = {
  readonly noted: Set<string>
  readonly owners: Map<string, string>
  readonly requests: Map<string, Record<string, ClaudeRequestUsage>>
  window?: ClaudeContextWindow
}

export function createClaudeTranslatorMemory(): ClaudeTranslatorMemory {
  return { noted: new Set(), owners: new Map(), requests: new Map() }
}
