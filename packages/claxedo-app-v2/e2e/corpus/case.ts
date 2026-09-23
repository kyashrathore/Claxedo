import type { AgentContentPart, AgentPresentationMessage } from "@claxedo/agent-runtime-contract"

export type CaseSource =
  | { readonly kind: "seed"; readonly fixture: string; readonly session: string }
  | { readonly kind: "commit"; readonly sha: string; readonly subject: string }
  | { readonly kind: "comment"; readonly file: string; readonly line: number }
  | { readonly kind: "test"; readonly file: string; readonly name: string }

export type CaseTranscript = {
  readonly messages: readonly AgentPresentationMessage[]
  readonly parts: Readonly<Record<string, readonly AgentContentPart[]>>
}

export type CaseSeedSlice = {
  readonly fixture: string
  readonly session: string
  readonly turns?: { readonly from: number; readonly to: number }
}

export type CaseReplay =
  | { readonly agent: "acp" }
  | { readonly agent: "claude" | "codex" }
  | { readonly agent: "unsupported"; readonly reason: string }

export type CaseInteraction =
  | { readonly kind: "scroll"; readonly to: "top" | "bottom" | { readonly turn: number } }
  | { readonly kind: "prepend" }
  | { readonly kind: "find"; readonly text: string }
  | { readonly kind: "reload" }
  | { readonly kind: "toggleFold"; readonly turn: number }
  | { readonly kind: "openTool"; readonly partId: string }
  | { readonly kind: "resize"; readonly width: number }

export type CorpusCase = {
  readonly id: string
  readonly title: string
  readonly source: CaseSource
  readonly partKinds: readonly string[]
  readonly transcript?: CaseTranscript
  readonly seed?: CaseSeedSlice
  readonly status?: "idle" | "working" | "retrying" | "recovering"
  readonly replay: CaseReplay
  readonly interactions: readonly CaseInteraction[]
  readonly invariant: string
}
