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

/**
 * How a runtime composed its session access, mirroring
 * `SessionAccessPolicy.sessionAuthority` in `@claxedo/workspace-runtime` and
 * `HostSessionAuthority` at the control plane. Restated here rather than
 * imported because this package depends on neither: it is a laptop-side
 * client that holds a machine key and speaks one protocol.
 */
export type HostSessionAuthority = "local" | "managed-private"

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
    sessionAuthority?: HostSessionAuthority
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
  /**
   * How the runtime this machine serves composed its session access, as that
   * runtime reports it — `"local"` serves the workspace-wide event streams,
   * `"managed-private"` serves session-scoped ones only.
   *
   * Declared rather than derived: the control plane mints a client's event
   * stream scope from this and will not infer one, so a connector that leaves
   * it undefined leaves every client of this machine with no workspace stream.
   * The connector does not know the answer itself — the process that composed
   * the runtime does — so it is injected and carried on every beat.
   */
  sessionAuthority?: HostSessionAuthority
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
  /**
   * Every time a heartbeat renews the lease — on the timer, or forced by
   * `shareWorkspace`/`unshareWorkspace` — with the state that now holds it.
   *
   * `state()` always answers this immediately; a caller across a process
   * boundary (Electron main's Host Connector child) does not poll it and can
   * only know the lease was renewed if told, so this is the one place that
   * tells it. Firing on every successful beat, not just the ones a caller
   * happened to be waiting on, is what keeps the cross-process status current
   * between explicit requests.
   */
  onLeaseRenewed?: (state: Extract<ConnectorState, { status: "enrolled" }>) => void
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

/**
 * Whether a failed heartbeat says "you are not enrolled" or merely "not right
 * now".
 *
 * Only the control plane can revoke a machine, and it says so with a decisive
 * status: 401/403 (this machine may not ask), 404/410 (no such enrollment),
 * 409 (its state is not one that can beat). Anything else — a 5xx, a timeout,
 * a rate limit, a socket that never opened — describes the CONNECTION to the
 * control plane, not the enrollment, and must not be read as a decision the
 * control plane made.
 *
 * The transport reports HTTP failures as `HOSTED_HTTP <status> <json>`
 * (`claxedo-desktop/src/main/account/account-service.ts`), so the status is
 * recoverable from the message. An error with no status at all is a transport
 * failure and therefore transient; the enrollment lease at the control plane
 * is what bounds that, expiring on its own if the machine really has gone.
 */
export function transientHeartbeatFailure(error: unknown) {
  const status = /HOSTED_HTTP (\d{3})\b/.exec(error instanceof Error ? error.message : String(error))?.[1]
  if (!status) return true
  return !new Set(["400", "401", "403", "404", "409", "410"]).has(status)
}

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
          // Outside the signature on purpose: the signature proves machine
          // CONSENT to serve this set, while this describes the composition
          // that set is served by — a description that can neither grant nor
          // widen access, because the runtime itself admits or refuses every
          // stream.
          ...(options.sessionAuthority ? { sessionAuthority: options.sessionAuthority } : {}),
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
        // `state` down to `links` are now the coherent result of this beat —
        // renewed expiry, reconciled shares — so tell a listener now rather
        // than leaving it to notice on its own next read.
        options.onLeaseRenewed?.(state)
      } catch (error) {
        // Same test on the failing path, for the opposite mistake. A beat that
        // was already open when the user paused comes back rejected — the
        // enrollment is being allowed to lapse, so of course it does — and
        // reporting that as `revoked` tells the user their access was taken
        // away when they turned it off themselves.
        if (startedIn !== era) return state
        options.onError?.("heartbeat", error)
        // A beat can fail for two completely different reasons, and treating
        // them alike is what made remote access fragile.
        //
        // A DECISION — the control plane no longer recognises this machine
        // (revoked, paused past expiry, enrolled elsewhere) — must stop the
        // connector. Re-enrolling itself would be overruling the user.
        //
        // A DISRUPTION — the control plane was briefly unreachable or was mid
        // release — must not. Observed live and repeatedly: deploying the
        // control plane makes it answer
        // `503 deployment_candidate_unavailable` for the seconds between the
        // upload and the phase opening, and every beat in that window used to
        // stop the machine permanently, with `revoked` on the panel. The
        // laptop went on reporting `serving: true` with open relay sockets
        // (its credential lease had not expired yet) while the control plane
        // refused to route to it and the app said "Workspace host is
        // offline" — the same symptom as a genuine revocation, with none of
        // the same cause. Every deploy silently took remote access down.
        //
        // So a disruption keeps the enrollment and lets the next beat retry.
        // The lease is the backstop: if the control plane really is gone, the
        // enrollment expires there on its own and stops routing without this
        // side having to guess.
        if (transientHeartbeatFailure(error)) return state
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
