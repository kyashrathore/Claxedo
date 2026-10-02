import type { AgentContentPart, AgentPresentationMessage } from "@claxedo/agent-runtime-contract"
import type { AcpStep } from "../harness"

export type CaseSource =
  | { readonly kind: "seed"; readonly fixture: string; readonly session: string }
  | { readonly kind: "commit"; readonly sha: string; readonly subject: string }
  | { readonly kind: "comment"; readonly file: string; readonly line: number }
  | { readonly kind: "test"; readonly file: string; readonly name: string }
  | { readonly kind: "inventory"; readonly ids: readonly string[] }

export type CaseTranscript = {
  readonly messages: readonly AgentPresentationMessage[]
  readonly parts: Readonly<Record<string, readonly AgentContentPart[]>>
}

export type CaseSeedSlice = {
  readonly fixture: string
  readonly session: string
  readonly turns?: { readonly from: number; readonly to: number }
}

export type CaseTurn = { readonly prompt: string; readonly steps: readonly AcpStep[]; readonly abort?: boolean; readonly live?: boolean }

export type CaseReplay =
  | { readonly agent: "acp"; readonly turns: readonly CaseTurn[] }
  | { readonly agent: "claude"; readonly scenario: "child-message-event" | "agent-authored-message" }
  | { readonly agent: "codex" }
  | { readonly agent: "unsupported"; readonly reason: string }

export type CaseInteraction =
  | { readonly kind: "scroll"; readonly to: "top" | "bottom" | { readonly turn: number } }
  | { readonly kind: "prepend" }
  | { readonly kind: "find"; readonly text: string }
  | { readonly kind: "reload" }
  | { readonly kind: "toggleFold"; readonly turn: number }
  | { readonly kind: "toggleUserMessage"; readonly message: string }
  | { readonly kind: "toggleAgentMessage" }
  | { readonly kind: "openTool"; readonly partId: string }
  | { readonly kind: "resize"; readonly width: number }
  | { readonly kind: "release"; readonly hold: string; readonly ready: string; readonly settles?: boolean }
  | { readonly kind: "markRows" }
  | { readonly kind: "rowsKept" }
  | { readonly kind: "markDetached" }
  | { readonly kind: "detachedGrowth"; readonly max: number }
  | { readonly kind: "heapGrowth"; readonly maxKb: number }
  | { readonly kind: "switchSessions"; readonly times: number }
  | { readonly kind: "watchWrites"; readonly scope: "thumb" | "timeline" }
  | { readonly kind: "writesAtMost"; readonly max: number }

export type CorpusCase = {
  readonly id: string
  readonly title: string
  readonly source: CaseSource
  readonly partKinds: readonly string[]
  readonly transcript?: CaseTranscript
  readonly seed?: CaseSeedSlice
  readonly status?: "idle" | "working" | "retrying" | "interrupted"
  readonly replay: CaseReplay
  readonly ready: string
  readonly interactions: readonly CaseInteraction[]
  readonly invariant: string
}
