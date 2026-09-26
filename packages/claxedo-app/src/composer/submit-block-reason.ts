import type { HarnessReadiness } from "./harness/selection"

export type SubmitAuthorityBlock = "workspace-role" | "session-share"

export type SubmitBlockReason =
  | SubmitAuthorityBlock
  | "session-loading"
  | "harness-degraded"
  | "harness-error"
  | "harness-polling"
  | "no-model"
  | "models-loading"
  | "booting"
  | "empty"

export type SubmitBlock = {
  readonly reason: SubmitBlockReason
  readonly copy: string
  readonly actionable: boolean
}

export type SubmitBlockInput = {
  readonly draftConnectionAllowsNoModel?: boolean
  readonly sessionStatusReady?: boolean
  readonly authorityBlock: SubmitAuthorityBlock | undefined
  readonly harnessMode: boolean
  readonly harnessReadiness: HarnessReadiness
  readonly harnessConfigError: boolean
  readonly harnessOptionsLoading: boolean
  readonly harnessReadyForSubmit: boolean
  readonly needsModelSelection: boolean
  readonly modelBlocked: boolean
  readonly modelBlockLabel: string | undefined
  readonly providerLoading: boolean
  readonly booting: boolean
  readonly stoppable: boolean
  readonly blank: boolean
  readonly workspaceAsleep?: boolean
}

const COPY = {
  "session-loading": "Checking session…",
  "workspace-role": "Read-only workspace (viewer)",
  "session-share": "You can follow this session, not send to it",
  "harness-degraded": "The selected agent is unavailable",
  "harness-error": "The agent isn't running",
  "harness-polling": "Checking the agent…",
  "no-model": "Choose a model to continue",
  "models-loading": "Loading models…",
  booting: "Starting up…",
  empty: "Type a message to get started",
} as const satisfies Record<SubmitBlockReason, string>

const ACTIONABLE: ReadonlySet<SubmitBlockReason> = new Set<SubmitBlockReason>([
  "harness-degraded",
  "harness-error",
  "no-model",
])

export function submitBlockCopy(reason: SubmitBlockReason) {
  return COPY[reason]
}

function block(reason: SubmitBlockReason): SubmitBlock {
  return { reason, copy: COPY[reason], actionable: ACTIONABLE.has(reason) }
}

export function submitBlockReason(input: SubmitBlockInput): SubmitBlock | null {
  if (input.authorityBlock) return block(input.authorityBlock)
  if (input.stoppable && input.blank) return null
  if (input.workspaceAsleep) return input.blank ? block("empty") : null
  if (input.sessionStatusReady === false && !input.stoppable) return block("session-loading")

  if (input.harnessMode && !input.draftConnectionAllowsNoModel) {
    if (input.harnessReadiness === "degraded") return block("harness-degraded")
    if (input.harnessReadiness === "error" || input.harnessConfigError) return block("harness-error")
    if (input.harnessReadiness === "polling") return block("harness-polling")
    if (input.harnessOptionsLoading) return block("models-loading")
    if (input.harnessReadiness === "unresolved") return block("harness-polling")
    if (!input.harnessReadyForSubmit) return block("no-model")
  } else if (input.needsModelSelection && input.modelBlocked) {
    return block("no-model")
  }

  if (input.modelBlocked) {
    if (input.providerLoading || input.modelBlockLabel === "Loading models") return block("models-loading")
    return block("no-model")
  }

  if (input.booting) return block("booting")
  if (!input.stoppable && input.blank) return block("empty")

  return null
}

