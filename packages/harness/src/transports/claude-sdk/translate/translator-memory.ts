import type { ClaudeRequestUsage } from "./adapter-state"

export type ClaudeContextWindow = { model: string; size: number }

export type ClaudeTranslatorMemory = {
  readonly noted: Set<string>
  readonly owners: Map<string, string>
  readonly requests: Map<string, Record<string, ClaudeRequestUsage>>
  readonly responseByFrame: Map<string, string>
  readonly refusedResponses: Set<string>
  readonly foregroundTasks: Set<string>
  window?: ClaudeContextWindow
}

export function createClaudeTranslatorMemory(): ClaudeTranslatorMemory {
  return { noted: new Set(), owners: new Map(), requests: new Map(), responseByFrame: new Map(), refusedResponses: new Set(), foregroundTasks: new Set() }
}
