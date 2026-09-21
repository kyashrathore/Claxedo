import type { HarnessReadiness } from "@/features/session/harness/selection"

/** Which authority refuses the send: the workspace's role, or the session's share. */
export type SubmitAuthorityBlock = "workspace-role" | "session-share"

/**
 * The single, priority-ordered vocabulary for "why is Send blocked?".
 *
 * `submitDisabled`, the composer placeholder and the explain-on-intent copy all
 * derive from `submitBlockReason`, so they cannot name different reasons for one
 * refusal.
 */
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
  /** User-facing sentence. Actionable reasons are imperatives with a purpose clause. */
  readonly copy: string
  /**
   * Actionable reasons stay clickable (dimmed) and explain their refusal on intent;
   * inert reasons keep the button hard-disabled.
   */
  readonly actionable: boolean
}

export type SubmitBlockInput = {
  readonly draftConnectionAllowsNoModel?: boolean
  readonly sessionStatusReady?: boolean
  /** Which authority refuses the send, from `submitAuthorityBlock`. Always hard-blocks the handler. */
  readonly authorityBlock: SubmitAuthorityBlock | undefined
  /** Whether harness-readiness gating applies to the selected runtime. */
  readonly harnessMode: boolean
  readonly harnessReadiness: HarnessReadiness
  readonly harnessConfigError: boolean
  /** Harness options (model list) still loading. */
  readonly harnessOptionsLoading: boolean
  /** False when the harness has no submittable model key (or is not ready). */
  readonly harnessReadyForSubmit: boolean
  /** A saved draft default needs an explicit model choice. */
  readonly needsModelSelection: boolean
  /** Canonical model gate (`toolbarState.modelSubmitBlocked()`). */
  readonly modelBlocked: boolean
  /** Model label that distinguishes the block cause. */
  readonly modelBlockLabel: string | undefined
  readonly providerLoading: boolean
  readonly booting: boolean
  readonly stoppable: boolean
  readonly blank: boolean
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

// Actionable reasons have a real fix the user can reach; inert ones resolve on their
// own (loading/booting) or by typing. Actionable → dim + clickable + explain-on-intent;
// inert → hard-disabled. Neither authority refusal is actionable: unlike the other
// entries here, a workspace role and a follow share have no in-composer remedy the
// user can reach (no "request access" action exists), so they hard-disable the Send
// control exactly like "empty"/"booting" rather than staying dimmed-but-clickable.
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

/**
 * Priority-ordered (most specific first). Returns `null` when Send is free to fire.
 */
export function submitBlockReason(input: SubmitBlockInput): SubmitBlock | null {
  if (input.authorityBlock) return block(input.authorityBlock)
  // An empty running composer means Stop. Cancelling the existing turn does
  // not depend on the harness/model readiness required to send another prompt.
  if (input.stoppable && input.blank) return null
  if (input.sessionStatusReady === false && !input.stoppable) return block("session-loading")

  if (input.harnessMode && !input.draftConnectionAllowsNoModel) {
    if (input.harnessReadiness === "degraded") return block("harness-degraded")
    if (input.harnessReadiness === "error" || input.harnessConfigError) return block("harness-error")
    if (input.harnessReadiness === "polling") return block("harness-polling")
    // readiness === "ready": still loading options, or ready but no model chosen.
    if (input.harnessOptionsLoading) return block("models-loading")
    if (!input.harnessReadyForSubmit) return block("no-model")
  } else if (input.needsModelSelection && input.modelBlocked) {
    // Draft-default "choose model" only blocks until the toolbar resolves a
    // submittable model. An explicit picker choice must not lose to stale
    // harness-store draftDefaultState (choose-model / saved-model-unavailable).
    return block("no-model")
  }

  if (input.modelBlocked) {
    // A model is unusable: distinguish loading from missing-model so the copy
    // is honest. Provider connection is owned by the model picker's canonical
    // Manage models flow; the composer never opens a second connection flow.
    // Providers refreshing in the background with a valid model still selected
    // never reaches here.
    if (input.providerLoading || input.modelBlockLabel === "Loading models") return block("models-loading")
    return block("no-model")
  }

  if (input.booting) return block("booting")
  if (!input.stoppable && input.blank) return block("empty")

  return null
}

// Clickability must never become submittability. Every standing block reason
// stops Enter/form submit before the handler; actionable reasons still explain
// on click (and Enter opens the model picker for `no-model`) via
// PromptSubmitControl / createPromptInputSubmitRetry.
export function submitHardBlocked(input: {
  stoppable: boolean
  block: SubmitBlock | null
}): boolean {
  if (input.stoppable) return false
  return input.block !== null
}
