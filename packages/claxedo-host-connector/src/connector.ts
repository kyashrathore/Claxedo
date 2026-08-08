/**
 * The laptop side of machine-wide remote access.
 *
 * Enroll once, then heartbeat until told to stop. That is the whole protocol,
 * and keeping it that small is the point: everything the old per-workspace
 * design put here — which projects are shared, what a workspace id is, when to
 * register a new one — is now decided by the control plane at request time.
 *
 * What this deliberately does NOT do:
 *
 *   - **Serve anything.** The connector is a client. A laptop that listens is a
 *     laptop with an attack surface, and the Relay already provides the inbound
 *     path.
 *   - **Hold an account credential.** It signs with the machine key. The
 *     account token lives in Electron main, and a headless connector on a
 *     server has no account at all.
 *   - **Retry forever without saying so.** A connector that silently reconnects
 *     through a revocation looks identical to one that is working.
 *
 * Transport is injected, so the protocol is testable without a control plane.
 */

import { enrollmentPayload, heartbeatPayload, type HostKeyPair } from "./host-identity"

export type EnrollmentRequest = { request_id: string; nonce: string; expires_at: number }
export type Enrollment = { enrollment_id: string; host_id: string; expires_at: number }

export type ConnectorTransport = {
  createRequest: (input: { hostId: string }) => Promise<EnrollmentRequest>
  enroll: (input: {
    hostId: string
    publicKey: string
    requestId: string
    signature: string
    displayName?: string
  }) => Promise<Enrollment>
  heartbeat: (input: { hostId: string; signature: string; ttlMs?: number }) => Promise<{ expires_at: number }>
}

export type ConnectorOptions = {
  hostId: string
  displayName?: string
  keys: HostKeyPair
  transport: ConnectorTransport
  /** How often to prove the machine is still here. */
  heartbeatIntervalMs: number
  /** Injected so a test does not wait, and so Electron can use its own timer. */
  setInterval: (fn: () => void, ms: number) => { cancel: () => void }
  onError?: (stage: "enroll" | "heartbeat", error: unknown) => void
}

export type ConnectorState =
  | { status: "idle" }
  | { status: "enrolled"; enrollment: Enrollment }
  /**
   * Stopped, with the reason.
   *
   * A connector that keeps beating after the control plane has said no is
   * indistinguishable from a working one, which is how a revoked machine stays
   * green on a status screen. Losing the enrollment stops the loop and says so.
   */
  | { status: "stopped"; reason: "revoked" | "error" | "closed"; detail: string }

export function createHostConnector(options: ConnectorOptions) {
  let state: ConnectorState = { status: "idle" }
  let timer: { cancel: () => void } | undefined
  /**
   * Which enrollment the connector is living in, counted.
   *
   * Heartbeats are not serialized — a beat slower than the interval overlaps
   * the next one, and `beat()` exists to be called by hand after a wake from
   * sleep while the pre-sleep request is still open — so a response can arrive
   * after the enrollment it belonged to is over. Without this, the older of two
   * overlapping beats wrote its answer unconditionally: a success landing after
   * a revocation put the connector back into `enrolled`, which is the state
   * machine being talked out of a terminal decision by a message that predates
   * it.
   *
   * Every departure from an enrolled session goes through `stop`, so bumping it
   * there is enough: a beat's answer is current if, and only if, this number
   * has not moved since the beat was issued.
   */
  let era = 0

  const stop = (reason: Extract<ConnectorState, { status: "stopped" }>["reason"], detail: string) => {
    era++
    timer?.cancel()
    timer = undefined
    state = { status: "stopped", reason, detail }
  }

  return {
    state: () => state,

    async start(): Promise<ConnectorState> {
      try {
        // Inside the try, not before it. Asking for the nonce is a call to the
        // control plane and fails for all the usual reasons — offline, 503, a
        // rejected bearer. Outside, that escaped as a rejection while every
        // other enrollment failure produced a stopped state, so a caller had to
        // handle two shapes for one outcome. On Electron startup the escaping
        // one is an unhandled rejection.
        const request = await options.transport.createRequest({ hostId: options.hostId })
        const enrollment = await options.transport.enroll({
          hostId: options.hostId,
          publicKey: options.keys.publicKey,
          requestId: request.request_id,
          signature: await options.keys.sign(
            enrollmentPayload({ hostId: options.hostId, requestId: request.request_id, nonce: request.nonce }),
          ),
          ...(options.displayName ? { displayName: options.displayName } : {}),
        })
        // A new enrollment is a new era, so a beat still in flight from the
        // previous one cannot write its expiry onto this one. `stop` bumping is
        // enough for the pause-and-resume path — this covers a `start` that did
        // not pass through one.
        era++
        state = { status: "enrolled", enrollment }
      } catch (error) {
        options.onError?.("enroll", error)
        stop("error", String(error))
        return state
      }

      // The previous loop, if any, before installing this one: an overwritten
      // handle is a timer nothing holds and `close()` can no longer cancel.
      timer?.cancel()
      timer = options.setInterval(() => {
        void this.beat()
      }, options.heartbeatIntervalMs)
      return state
    },

    /** One heartbeat. Exposed so a caller can force one after a wake from sleep. */
    async beat() {
      if (state.status !== "enrolled") return state
      // `era` is what makes the answer's currency checkable below, and it is
      // the guard that actually decides the outcome.
      //
      // `enrollment` is captured for a narrower reason and changes no behaviour
      // while that guard stands: the narrowing on line above does NOT survive
      // the await at runtime, only in the compiler. Reading `state.enrollment`
      // after the await type-checked, and when the response landed on a
      // `stopped` state — which carries no enrollment — it spread `undefined`,
      // which is how the reversal produced a machine enrolled with an expiry,
      // no id and no host id. Reading it while the narrowing is still true
      // means no future edit can reintroduce that shape by weakening a guard.
      const startedIn = era
      const enrollment = state.enrollment
      try {
        const result = await options.transport.heartbeat({
          hostId: options.hostId,
          signature: await options.keys.sign(heartbeatPayload({ hostId: options.hostId })),
        })
        // The enrollment this beat was proving ended while it was in flight.
        // Its answer describes a machine the control plane has already stopped
        // recognising, so it is dropped rather than adopted.
        if (startedIn !== era) return state
        state = { status: "enrolled", enrollment: { ...enrollment, expires_at: result.expires_at } }
      } catch (error) {
        // Same test on the failing path, for the opposite mistake. A beat that
        // was already open when the user paused comes back rejected — the
        // enrollment is being allowed to lapse, so of course it does — and
        // reporting that as `revoked` tells the user their access was taken
        // away when they turned it off themselves.
        if (startedIn !== era) return state
        options.onError?.("heartbeat", error)
        // A rejected heartbeat means the control plane no longer recognises
        // this machine — revoked, paused past expiry, or enrolled elsewhere.
        // Re-enrolling on its own would be the connector overruling that
        // decision, so it stops and waits for the user.
        stop("revoked", String(error))
      }
      return state
    },

    close() {
      if (state.status === "stopped") return
      stop("closed", "connector closed")
    },
  }
}
