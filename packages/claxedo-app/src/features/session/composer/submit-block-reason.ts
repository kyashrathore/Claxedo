import type { HarnessReadiness } from "@/features/session/harness/selection"

/**
 * The single, priority-ordered vocabulary for "why is Send blocked?".
 *
 * T5 (CLAXEDO_ERROR_PROPOSAL §B2/§T5): the composer used to derive `submitDisabled`
 * from six independent booleans, none of which could name the reason. This is the one
 * ordered source of truth. `submitDisabled` and the explain-on-intent copy both derive
 * from `submitBlockReason` — they never diverge.
 */
export type SubmitBlockReason =
  | "viewer-role"
  | "harness-degraded"
  | "harness-error"
  | "harness-polling"
  | "no-model"
  | "no-credential"
  | "models-loading"
  | "booting"
  | "empty"

export type SubmitBlock = {
  readonly reason: SubmitBlockReason
  /** User-facing sentence. Actionable reasons are imperatives with a purpose clause. */
  readonly copy: string
  /**
   * Actionable reasons stay clickable (dimmed) and explain their refusal on intent;
   * inert reasons keep the button hard-disabled.
   */
  readonly actionable: boolean
}

export type SubmitBlockInput = {
  /** Read-only workspace / insufficient role. Always hard-blocks the handler. */
  readonly roleBlocked: boolean
  /** Whether harness-readiness gating applies (non-opencode harness selected). */
  readonly harnessMode: boolean
  readonly harnessReadiness: HarnessReadiness
  readonly harnessConfigError: boolean
  /** Harness options (model list) still loading. */
  readonly harnessOptionsLoading: boolean
  /** False when the harness has no submittable model key (or is not ready). */
  readonly harnessReadyForSubmit: boolean
  /** A saved harness/opencode draft default needs an explicit model choice. */
  readonly needsModelSelection: boolean
  /** opencode-mode model gate (`toolbarState.modelSubmitBlocked()`). */
  readonly modelBlocked: boolean
  /** opencode-mode model label that distinguishes the block cause. */
  readonly modelBlockLabel: string | undefined
  readonly providerLoading: boolean
  readonly booting: boolean
  readonly stoppable: boolean
  readonly blank: boolean
}

const COPY = {
  "viewer-role": "Read-only workspace (viewer)",
  "harness-degraded": "The agent stopped responding",
  "harness-error": "The agent isn't running",
  "harness-polling": "Checking the agent…",
  "no-model": "Choose a model to continue",
  "no-credential": "Connect an AI provider to continue",
  "models-loading": "Loading models…",
  booting: "Starting up…",
  empty: "Type a message to get started",
} as const satisfies Record<SubmitBlockReason, string>

// Actionable reasons have a real fix the user can reach; inert ones resolve on their
// own (loading/booting) or by typing. Actionable → dim + clickable + explain-on-intent;
// inert → hard-disabled.
const ACTIONABLE: ReadonlySet<SubmitBlockReason> = new Set<SubmitBlockReason>([
  "viewer-role",
  "harness-degraded",
  "harness-error",
  "no-model",
  "no-credential",
])

function block(reason: SubmitBlockReason): SubmitBlock {
  return { reason, copy: COPY[reason], actionable: ACTIONABLE.has(reason) }
}

/**
 * Priority-ordered (most specific first). Returns `null` when Send is free to fire.
 */
export function submitBlockReason(input: SubmitBlockInput): SubmitBlock | null {
  if (input.roleBlocked) return block("viewer-role")

  if (input.harnessMode) {
    if (input.harnessReadiness === "degraded") return block("harness-degraded")
    if (input.harnessReadiness === "error" || input.harnessConfigError) return block("harness-error")
    if (input.harnessReadiness === "polling") return block("harness-polling")
    // readiness === "ready": still loading options, or ready but no model chosen.
    if (input.harnessOptionsLoading) return block("models-loading")
    if (input.needsModelSelection || !input.harnessReadyForSubmit) return block("no-model")
  } else if (input.needsModelSelection) {
    // An opencode draft default that needs an explicit choice blocks in any mode.
    return block("no-model")
  }

  if (input.modelBlocked) {
    // A model is unusable: distinguish loading from missing-provider from
    // missing-model so the copy is honest. Providers refreshing in the
    // background with a valid model still selected never reaches here.
    if (input.providerLoading || input.modelBlockLabel === "Loading models") return block("models-loading")
    if (input.modelBlockLabel === "Connect AI") return block("no-credential")
    return block("no-model")
  }

  if (input.booting) return block("booting")
  if (!input.stoppable && input.blank) return block("empty")

  return null
}
