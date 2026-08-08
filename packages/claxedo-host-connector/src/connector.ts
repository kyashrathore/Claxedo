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

  const stop = (reason: Extract<ConnectorState, { status: "stopped" }>["reason"], detail: string) => {
    timer?.cancel()
    timer = undefined
    state = { status: "stopped", reason, detail }
  }

  return {
    state: () => state,

    async start(): Promise<ConnectorState> {
      const request = await options.transport.createRequest({ hostId: options.hostId })
      try {
        const enrollment = await options.transport.enroll({
          hostId: options.hostId,
          publicKey: options.keys.publicKey,
          requestId: request.request_id,
          signature: await options.keys.sign(
            enrollmentPayload({ hostId: options.hostId, requestId: request.request_id, nonce: request.nonce }),
          ),
          ...(options.displayName ? { displayName: options.displayName } : {}),
        })
        state = { status: "enrolled", enrollment }
      } catch (error) {
        options.onError?.("enroll", error)
        stop("error", String(error))
        return state
      }

      timer = options.setInterval(() => {
        void this.beat()
      }, options.heartbeatIntervalMs)
      return state
    },

    /** One heartbeat. Exposed so a caller can force one after a wake from sleep. */
    async beat() {
      if (state.status !== "enrolled") return state
      try {
        const result = await options.transport.heartbeat({
          hostId: options.hostId,
          signature: await options.keys.sign(heartbeatPayload({ hostId: options.hostId })),
        })
        state = { status: "enrolled", enrollment: { ...state.enrollment, expires_at: result.expires_at } }
      } catch (error) {
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
