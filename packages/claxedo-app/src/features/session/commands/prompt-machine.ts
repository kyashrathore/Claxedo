import {
  canStartSubmit,
  harnessBridge,
  type ComposerMode,
} from "@/features/session/composer/mode"

export type PromptSnapshot = {
  readonly bodyMd: string
  readonly comments: readonly string[]
  readonly images: readonly string[]
  readonly mode: "normal" | "shell" | "slash"
  readonly messageID: string
}

export type PromptMachineState =
  | { readonly s: "draft" }
  | {
    readonly s: "preparing"
    readonly job: "resolve-target" | "provision-cloud" | "provision-worktree" | "resolve-config"
    readonly snapshot: PromptSnapshot
    readonly mode: ComposerMode
  }
  | {
    readonly s: "creating"
    readonly via: "opencode" | "harness-claim"
    readonly snapshot: PromptSnapshot
    readonly mode: ComposerMode
  }
  | {
    readonly s: "inflight"
    readonly sessionId: string
    readonly messageID: string
    readonly snapshot: PromptSnapshot
    readonly mode?: ComposerMode
  }
  | { readonly s: "reconciled"; readonly sessionId: string }
  | {
    readonly s: "rolledBack"
    readonly reason: "create-failed" | "send-failed" | "aborted" | "config-missing"
    readonly snapshot: PromptSnapshot
    readonly mode?: ComposerMode
    readonly restored: true
  }

export type PromptMachineEvent =
  | {
    readonly t: "SUBMIT"
    readonly mode: ComposerMode
    readonly snapshot: PromptSnapshot
    readonly working?: boolean
  }
  | { readonly t: "TARGET_RESOLVED" }
  | { readonly t: "PROVISIONED" }
  | { readonly t: "PROVISION_FAILED"; readonly err?: unknown }
  | { readonly t: "SESSION_CREATED"; readonly sessionId: string }
  | { readonly t: "CREATE_FAILED"; readonly err?: unknown }
  | { readonly t: "DISPATCHED" }
  | { readonly t: "SEND_FAILED"; readonly err?: unknown }
  | { readonly t: "RECONCILED" }
  | { readonly t: "ABORT" }
  | { readonly t: "RETRY" }

export type PromptEffectName =
  | "abortActivePrompt"
  | "resolveDraftTarget"
  | "createOpencodeSession"
  | "claimHarnessSession"
  | "recordPromptSubmission"
  | "applyOptimisticPromptHandoff"
  | "preparePromptRequest"
  | "sendPromptRequest"
  | "rollbackPromptDispatch"
  | "restoreSnapshot"

export type PromptEffect = { readonly name: PromptEffectName }

export type PromptMachineTransition = {
  readonly next: PromptMachineState
  readonly effects: readonly PromptEffect[]
}

export type PromptAdmission = "admit" | "abort-active" | "ignore"

export function admitPromptSubmission(input: {
  readonly mode: ComposerMode
  readonly bodyMd: string
  readonly imageCount?: number
  readonly commentCount?: number
  readonly working?: boolean
}): PromptAdmission {
  // The composer has no queue contract. While a turn is active the primary
  // control is Stop, regardless of whether the user has already drafted the
  // next message; admitting that draft creates a competing durable turn.
  if (input.working) return "abort-active"
  if (canStartSubmit(input.mode, input)) return "admit"
  return "ignore"
}

export function initialPromptMachineState(): PromptMachineState {
  return { s: "draft" }
}

export function transitionPromptMachine(
  state: PromptMachineState,
  event: PromptMachineEvent,
): PromptMachineTransition {
  if (event.t === "RETRY") return retryPromptSubmission(state)
  if (event.t === "ABORT") return abortPromptMachine(state)

  if (state.s === "draft") {
    if (event.t !== "SUBMIT") return unchanged(state)
    const admission = admitPromptSubmission({
      mode: event.mode,
      bodyMd: event.snapshot.bodyMd,
      imageCount: event.snapshot.images.length,
      commentCount: event.snapshot.comments.length,
      working: event.working,
    })
    if (admission === "abort-active") return { next: state, effects: effects("abortActivePrompt") }
    if (admission === "ignore") return unchanged(state)
    return startPromptSubmission(event.mode, event.snapshot)
  }

  if (state.s === "preparing") {
    if (event.t === "TARGET_RESOLVED" || event.t === "PROVISIONED") {
      return {
        next: { s: "creating", via: "opencode", snapshot: state.snapshot, mode: state.mode },
        effects: effects("createOpencodeSession"),
      }
    }
    if (event.t === "PROVISION_FAILED") {
      return rolledBack(state, "config-missing", effects("restoreSnapshot"))
    }
    return unchanged(state)
  }

  if (state.s === "creating") {
    if (event.t === "SESSION_CREATED") {
      return {
        next: {
          s: "inflight",
          sessionId: event.sessionId,
          messageID: state.snapshot.messageID,
          snapshot: state.snapshot,
          mode: state.mode,
        },
        effects: dispatchPromptEffects(),
      }
    }
    if (event.t === "CREATE_FAILED") {
      return rolledBack(state, "create-failed", effects("restoreSnapshot"))
    }
    return unchanged(state)
  }

  if (state.s === "inflight") {
    if (event.t === "SEND_FAILED") {
      return rolledBack(state, "send-failed", effects("rollbackPromptDispatch", "restoreSnapshot"))
    }
    if (event.t === "RECONCILED") return { next: { s: "reconciled", sessionId: state.sessionId }, effects: [] }
    return unchanged(state)
  }

  return unchanged(state)
}

export function retryPromptSubmission(state: PromptMachineState): PromptMachineTransition {
  if (state.s !== "rolledBack" || !state.mode) return unchanged(state)
  return startPromptSubmission(state.mode, state.snapshot)
}

function startPromptSubmission(mode: ComposerMode, snapshot: PromptSnapshot): PromptMachineTransition {
  if (mode.kind === "session") {
    return {
      next: {
        s: "inflight",
        sessionId: mode.ref.sessionId,
        messageID: snapshot.messageID,
        snapshot,
      },
      effects: dispatchPromptEffects(),
    }
  }

  if (harnessBridge(mode)) {
    return {
      next: { s: "creating", via: "harness-claim", snapshot, mode },
      effects: effects("claimHarnessSession"),
    }
  }

  return {
    next: { s: "preparing", job: "resolve-target", snapshot, mode },
    effects: effects("resolveDraftTarget"),
  }
}

function abortPromptMachine(state: PromptMachineState): PromptMachineTransition {
  if (state.s === "preparing" || state.s === "creating" || state.s === "inflight") {
    return rolledBack(state, "aborted", effects("abortActivePrompt", "restoreSnapshot"))
  }
  return unchanged(state)
}

function rolledBack(
  state: Extract<PromptMachineState, { readonly snapshot: PromptSnapshot }>,
  reason: Extract<PromptMachineState, { readonly s: "rolledBack" }>["reason"],
  nextEffects: readonly PromptEffect[],
): PromptMachineTransition {
  return {
    next: {
      s: "rolledBack",
      reason,
      snapshot: state.snapshot,
      ...(state.mode ? { mode: state.mode } : {}),
      restored: true,
    },
    effects: nextEffects,
  }
}

function dispatchPromptEffects() {
  return effects(
    "recordPromptSubmission",
    "preparePromptRequest",
    "applyOptimisticPromptHandoff",
    "sendPromptRequest",
  )
}

function effects(...names: PromptEffectName[]): readonly PromptEffect[] {
  return names.map((name) => ({ name }))
}

function unchanged(state: PromptMachineState): PromptMachineTransition {
  return { next: state, effects: [] }
}
