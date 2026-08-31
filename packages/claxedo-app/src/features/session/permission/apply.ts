import type { PermissionModeDelivery } from "@/features/session/permission/modes"

/**
 * The one call needed to deliver a session permission mode, narrowed to a port so
 * this module is testable without constructing an SDK client.
 *
 * The Claxedo client contract takes flat arguments and maps `permission` into
 * the session update request body.
 */
export type SessionPermissionWriter = {
  /**
   * Optional because the runtime session transport is not always in play — a
   * selected runtime may not expose this operation. Absent means the harness
   * delivery reports `not-wired` rather than
   * throwing, which is the honest outcome: there is genuinely no route to it.
   */
  setPermissionMode?: (input: {
    sessionID: string
    modeId: string
  }) => Promise<{ currentModeId?: string }>
}

/**
 * What happened, as data rather than a thrown error, so the caller can tell "the
 * harness has no way to receive this" apart from "the write failed".
 */
export type PermissionModeApplied =
  | {
      kind: "applied"
      appliesFrom: "next-turn" | "next-session"
      /**
       * What the harness reports as current AFTER the write, when it says. Absent
       * for deliveries with no read-back.
       */
      kept?: string
    }
  /**
   * Claxedo answers prompts itself for this delivery; there is nothing to send. Not
   * a failure — it is how ACP and pi work.
   */
  | { kind: "answered-locally" }
  /**
   * A real delivery that this module does not implement yet. Deliberately explicit:
   * silently returning success here is how a picker ends up claiming a mode is
   * active when nothing was ever sent.
   */
  | { kind: "not-wired"; delivery: PermissionModeDelivery["kind"] }

/**
 * Whether selecting a mode with this delivery would actually reach the harness.
 *
 * The picker needs this, and it MUST come from the same module as
 * `applyPermissionMode` or the two drift: a mode offered as selectable whose
 * delivery is unimplemented reads as applied while nothing was ever sent. That is
 * the precise failure `not-wired` exists to make visible, and it would be
 * reintroduced by a picker that lists everything.
 *
 * `claxedo-auto-answer` counts as deliverable: nothing is sent, but the mode IS in
 * effect — Claxedo answers the prompts itself.
 *
 * Pinned against `applyPermissionMode` by a test that walks every delivery kind, so
 * implementing one without flipping this here fails.
 */
export function permissionModeDeliverable(kind: PermissionModeDelivery["kind"]) {
  switch (kind) {
    case "claxedo-auto-answer":
      return true
    case "harness-permission-mode":
      // Deliverable: the runtime owns the translation, so the app only has to
      // hand back an id the harness gave it. This returned false while the app
      // held per-harness delivery shapes it had no implementation for.
      return true
  }
}

/**
 * Deliver a permission mode to the harness.
 *
 * The harness path forwards an id the harness itself
 * supplied, so this module holds no per-harness knowledge at all — the runtime
 * translates.
 */
export async function applyPermissionMode(input: {
  delivery: PermissionModeDelivery
  sessionID: string
  client: SessionPermissionWriter
}): Promise<PermissionModeApplied> {
  const { delivery } = input

  switch (delivery.kind) {
    case "claxedo-auto-answer":
      return { kind: "answered-locally" }

    case "harness-permission-mode": {
      if (!input.client.setPermissionMode) return { kind: "not-wired", delivery: delivery.kind }
      const state = await input.client.setPermissionMode({
        sessionID: input.sessionID,
        modeId: delivery.modeId,
      })
      // The harness's read-back, not the request. `kept` differing from
      // `delivery.modeId` is a real outcome — an ACP agent can clamp the mode —
      // and the caller has to be able to see it rather than being told the
      // requested mode is active.
      return { kind: "applied", appliesFrom: delivery.appliesFrom, kept: state.currentModeId }
    }
  }
}
