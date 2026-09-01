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

import { enrollmentPayload, heartbeatPayloadV2, type HostKeyPair } from "./host-identity"

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
  /**
   * One signed beat carries everything: the lease renewal AND the served
   * workspace set (heartbeat payload v2). The response returns the owner's
   * assignment view for reconciliation, and one Host Tunnel credential per
   * workspace that is both assigned and just acked — the serving side opens
   * its relay tunnels from the same answer that renewed the lease.
   */
  heartbeat: (input: {
    hostId: string
    signature: string
    ttlMs?: number
    workspaceIds: readonly string[]
  }) => Promise<{
    expires_at: number
    assigned_workspace_ids?: readonly string[]
    /** ONE credential covering the whole assigned∩acked set, or absent. */
    hostTunnel?: Record<string, unknown>
  }>
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
  onError?: (stage: "enroll" | "heartbeat" | "share", error: unknown) => void
  /**
   * The serving credential from the latest ack — one token whose claim is
   * exactly the workspaces this machine is currently routable for, or
   * undefined when nothing is. The consumer (the daemon's tunnel runner, via
   * the parent process) owns opening and closing the relay connection.
   */
  onServing?: (tunnel: Record<string, unknown> | undefined) => void
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
   * Workspaces this machine currently publishes, by id.
   *
   * Links are heartbeat-scoped: they exist only while `beat()` keeps renewing
   * them, so this map IS the share state — losing the enrollment (stop,
   * revoke, rejected beat) implicitly lets every link lapse at the control
   * plane, and the map is cleared with it.
   */
  const links = new Map<string, { displayName?: string }>()
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
    links.clear()
    state = { status: "stopped", reason, detail }
  }

  return {
    state: () => state,

    /** Workspaces this machine currently publishes, sorted for stable display. */
    sharedWorkspaceIds: () => [...links.keys()].sort(),

    /**
     * Serve one more workspace from this machine.
     *
     * The OWNER'S assignment happens elsewhere (an authenticated control-plane
     * call by the process that holds the account credential); the connector's
     * half is machine CONSENT: add the id to the served set and force one
     * beat so the acked set — and therefore routability — updates within a
     * round trip. Success requires the beat to come back with the workspace
     * in the owner's assignment view: consent without intent is not a share.
     */
    async shareWorkspace(input: { workspaceId: string; displayName?: string }): Promise<void> {
      if (state.status !== "enrolled") {
        throw new Error("remote access is not active on this machine — enable it first")
      }
      links.set(input.workspaceId, input.displayName ? { displayName: input.displayName } : {})
      const startedIn = era
      try {
        const result = await this.beat()
        if (startedIn !== era || result.status !== "enrolled") {
          throw new Error("remote access stopped while the share was registering")
        }
        if (!links.has(input.workspaceId)) {
          throw new Error("the control plane has no assignment for this workspace on this machine")
        }
      } catch (error) {
        links.delete(input.workspaceId)
        options.onError?.("share", error)
        throw error
      }
    },

    /** Stop serving one workspace: drop consent, ack the smaller set now. */
    async unshareWorkspace(workspaceId: string): Promise<void> {
      if (!links.delete(workspaceId)) return
      if (state.status !== "enrolled") return
      await this.beat()
    },

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
        // One signature covers the lease AND the served set (payload v2).
        // The signature is fresh per call — never reuse one, every signature
        // hash is single-use at the authority.
        const workspaceIds = [...links.keys()].sort()
        const result = await options.transport.heartbeat({
          hostId: options.hostId,
          signature: await options.keys.sign(heartbeatPayloadV2({ hostId: options.hostId, workspaceIds })),
          workspaceIds,
        })
        // The enrollment this beat was proving ended while it was in flight.
        // Its answer describes a machine the control plane has already stopped
        // recognising, so it is dropped rather than adopted.
        if (startedIn !== era) return state
        state = { status: "enrolled", enrollment: { ...enrollment, expires_at: result.expires_at } }
        // Reconcile consent against intent: an id the owner has unassigned
        // (from another device, or by revoking the share) leaves the served
        // set here, so the next beat's signed set is truthful and the panel
        // shows what actually routes.
        if (result.assigned_workspace_ids) {
          const assigned = new Set(result.assigned_workspace_ids)
          for (const workspaceId of [...links.keys()]) {
            if (!assigned.has(workspaceId)) links.delete(workspaceId)
          }
        }
        // The serving credential for everything assigned∩acked, straight
        // from the ack that renewed the lease.
        options.onServing?.(result.hostTunnel)
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
