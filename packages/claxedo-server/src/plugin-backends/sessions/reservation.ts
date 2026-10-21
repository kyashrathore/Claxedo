/**
 * The managed reservation a control plane requires before an origin may
 * create or remove a session. The session records a creator actor, and a
 * session reserved for anyone but the person who started it is one they
 * cannot open.
 */
import type { PrivateSessionAuthority, PrivateSessionRuntimePrincipal } from "@claxedo/server-core/platform/auth/private-session-authority"
import { CONTROL_PLANE_RUNTIME_ACTOR } from "@claxedo/server-core/platform/auth/runtime-actor"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import type { SessionHost, SessionReservation } from "@claxedo/server-core/plugin-platform/sessions/session-bridge-core"
import { sessionBridgeRefusal, type SessionBridgeRefusal } from "@claxedo/server-core/plugin-platform/sessions/session-start"

/** The parts of the host's private session authority origin sessions are reserved and undone through. */
export type SessionRegistrations = Readonly<{
  /** Absent on a host with no managed reservation, which then cannot start a session. */
  reservation?: Pick<PrivateSessionAuthority, "reserveRuntimeSession">
  /** Absent, a released session's reservation is left as it was. */
  compensation?: Pick<PrivateSessionAuthority, "beginSessionCompensation" | "completeSessionCompensation">
}>

export type SessionReserveInput<Actor> = {
  registrations: SessionRegistrations
  /**
   * The canonical actor a session is reserved for. An unowned service actor
   * cannot reserve a session on a human's workspace, and an origin's actor
   * names a user while a reservation requires their actor; the composition
   * resolves one from the other.
   */
  principal?: (actor: Actor) => Promise<PrivateSessionRuntimePrincipal | undefined>
}

/**
 * The reservation's own undo for an origin whose session was removed again:
 * the registration state machine reaches `compensated` only through
 * `compensation_pending`, and a compensated origin can never register a
 * session, which is what keeps the deleted id from coming back as one.
 *
 * A session its runtime already registered rolls forward instead: the
 * authority refuses to compensate it (`registration_transition_denied`), and
 * the runtime's own delete is what removes it from the registry, so that
 * refusal leaves nothing to undo here.
 */
export function createSessionRelease<Actor>(input: SessionReserveInput<Actor>): NonNullable<SessionHost<Actor>["release"]> {
  return async (released): Promise<void> => {
    const authority = input.registrations.compensation
    if (!authority) return
    const principal = input.principal ? await input.principal(released.actor) : CONTROL_PLANE_RUNTIME_ACTOR
    if (!principal) return
    const transition = {
      ...principal,
      operationId: released.operationId,
      sessionId: released.sessionId,
      workspaceId: released.workspaceId,
      reason: released.reason,
    }
    try {
      await authority.beginSessionCompensation(transition)
    } catch (error) {
      if (error instanceof ClaxedoError && error.code === "registration_transition_denied") return
      throw error
    }
    await authority.completeSessionCompensation(transition)
  }
}

export function createSessionReserve<Actor>(input: SessionReserveInput<Actor>): NonNullable<SessionHost<Actor>["reserve"]> {
  return async (intent): Promise<SessionReservation> => {
    const authority = input.registrations.reservation
    if (!authority) return sessionBridgeRefusal("unsupported", "Session registration is unavailable on this host")
    // The service actor is the fallback for a composition that named no
    // resolver at all. A composition that named one and cannot answer stops
    // here instead: the service actor can write workspaces the caller cannot,
    // so substituting it would take the reservation's own workspace gate off
    // the caller and leave them a session they cannot read.
    const principal = input.principal ? await input.principal(intent.actor) : CONTROL_PLANE_RUNTIME_ACTOR
    if (!principal) {
      return sessionBridgeRefusal("forbidden", "This host reserves a session for the person starting it, and this caller has no canonical actor")
    }
    let reservation
    try {
      reservation = await authority.reserveRuntimeSession(principal, {
        operationId: intent.operationId,
        sessionId: intent.sessionId,
        workspaceId: intent.workspaceId,
        kind: "create",
        title: intent.title,
      })
    } catch (error) {
      const refused = reservationRefusal(error)
      if (!refused) throw error
      return refused
    }
    if (reservation.sessionId !== intent.sessionId || reservation.operationId !== intent.operationId) {
      return sessionBridgeRefusal("conflict", `Origin ${intent.operationId} is reserved for another session`)
    }
    if (reservation.state === "compensation_pending") {
      return sessionBridgeRefusal("conflict", `Origin ${intent.operationId} is being compensated and cannot register a session yet`)
    }
    return { ok: true, headers: { "x-claxedo-session-registration-operation": reservation.operationId } }
  }
}

/**
 * A reservation refusal the authority owns, as a start failure rather than an
 * escaping exception: the workspace gate runs there, as the caller, and it
 * answers by throwing. Anything that is not one of its refusals is a fault and
 * keeps travelling.
 */
function reservationRefusal(error: unknown): SessionBridgeRefusal | null {
  const status = error instanceof ControlPlaneAuthError || error instanceof ClaxedoError ? error.status : undefined
  const message = error instanceof Error ? error.message : "The session reservation was refused"
  if (status === 401 || status === 403) return sessionBridgeRefusal("forbidden", message)
  if (status === 409) return sessionBridgeRefusal("conflict", message)
  if (status === 400) return sessionBridgeRefusal("invalid_input", message)
  return null
}
