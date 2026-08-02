import type { PermissionModeDelivery } from "@/features/session/permission/modes"

/**
 * The one call needed to deliver an opencode permission mode, narrowed to a port so
 * this module is testable without constructing an SDK client.
 *
 * Mirrors `client.session.update` from `@opencode-ai/sdk/v2/client`, which takes flat
 * arguments and maps `permission` into the request body (see the generated
 * `PATCH /session/{sessionID}` method).
 */
export type SessionPermissionWriter = {
  /**
   * Optional because the runtime session transport is not always in play — a
   * cloud opencode session talks to the opencode client, which has no such
   * method. Absent means the harness delivery reports `not-wired` rather than
   * throwing, which is the honest outcome: there is genuinely no route to it.
   */
  setPermissionMode?: (input: {
    sessionID: string
    modeId: string
  }) => Promise<{ currentModeId?: string }>
  session: {
    update: (input: {
      sessionID: string
      /**
       * MUTABLE on purpose: the SDK's generated `PermissionRuleset` is
       * `PermissionRule[]`, so a `readonly` array is not assignable to it. The
       * delivery's ruleset is readonly, and `applyPermissionMode` copies it at this
       * boundary — which also means the SDK cannot mutate the shared constant the
       * mode table hands out.
       */
      permission?: { permission: string; pattern: string; action: "ask" | "allow" | "deny" }[]
    }) => Promise<unknown>
  }
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
       * for deliveries with no read-back (the opencode ruleset write returns no
       * mode, because opencode has rules rather than modes).
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
    case "opencode-session-ruleset":
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
 * Two real paths now. The harness path forwards an id the harness itself
 * supplied, so this module holds no per-harness knowledge at all — the runtime
 * translates. The opencode path stays separate because opencode has no modes to
 * forward: it writes a SESSION-scoped ruleset via
 * `PATCH /session/:sessionID` — deliberately NOT `PATCH /config`, whose handler
 * disposes the engine instance on every request and so hard-interrupts every running
 * turn in the directory (and wipes standing "allow always" grants, which live only in
 * memory). See the `opencode-session-ruleset` doc on `PermissionMechanism` for the
 * full reasoning.
 *
 * The ruleset is sent COMPLETE every time. The engine's handler merges rather than
 * replaces (`Permission.merge(current, incoming)`), so anything omitted keeps
 * whatever a previous mode left behind.
 */
export async function applyPermissionMode(input: {
  delivery: PermissionModeDelivery
  sessionID: string
  client: SessionPermissionWriter
}): Promise<PermissionModeApplied> {
  const { delivery } = input

  switch (delivery.kind) {
    case "opencode-session-ruleset":
      // No `directory`: the client is already scoped to one (the existing
      // `session.update({ sessionID, title })` call site passes none either), so
      // threading a directory string here would add routing debt for nothing.
      await input.client.session.update({
        sessionID: input.sessionID,
        permission: [...delivery.ruleset],
      })
      // Not "active": `runLoop` snapshots the session row once at turn entry, so a
      // turn already in flight keeps the rules it started with. The caller must say
      // so rather than implying the change is live.
      return { kind: "applied", appliesFrom: delivery.appliesFrom }

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
