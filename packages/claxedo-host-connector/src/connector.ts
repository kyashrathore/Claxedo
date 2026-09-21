/**
 * The machine side of machine-wide remote access.
 *
 * The host is already enrolled — by an invitation a `claxedo connect` box
 * redeemed (`./bootstrap`), or by the owner's account on the desktop, whose
 * child is handed the resulting `enrollment_id`. From there the protocol is
 * small on purpose: acquire a serving generation, then heartbeat until told to
 * stop. Every request is signed with the machine key, and what to serve is
 * learned from the control plane's assignment descriptions carried on each
 * beat's answer, never decided here.
 *
 * What this deliberately does not do:
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

import { pathWithinRoots, type HostScope } from "./host-state"

/**
 * How a runtime composed its session access, mirroring
 * `SessionAccessPolicy.sessionAuthority` in `@claxedo/workspace-runtime` and
 * `HostSessionAuthority` at the control plane. Restated here rather than
 * imported because this package depends on neither: it is a laptop-side
 * client that holds a machine key and speaks one protocol.
 */
export type HostSessionAuthority = "local" | "managed-private"

export type Enrollment = { enrollment_id: string; host_id: string; expires_at: number }

/** The owner's statement of what this machine should serve, versioned per workspace. */
export type AssignmentDescription = {
  workspaceId: string
  remoteDirectory: string
  displayName?: string
  /** Strictly increasing; bumped with every change to the directory. */
  revision: number
}

export type AssignmentAck = { workspaceId: string; revision: number }

export type HostEndpoints = {
  relay?: { url: string; jwksUrl: string }
  authority?: { sessionAuthorityUrl: string }
}

/**
 * The owner's provider configuration for this machine, versioned like an
 * assignment and carried the same way.
 *
 * `sealed` is opaque here: it is a `mseal1` blob for this machine's sealing
 * key (`./machine-seal`) and only the process holding that key opens it. The
 * connector never reads it, so a change to what the owner pushes is not a
 * change to this package. `null` is the withdrawal — a revision that says
 * "this machine holds nothing" — and it is a revision like any other so a host
 * that was offline when the owner revoked learns of it on its next beat.
 */
export type ProviderConfigRevision = { revision: number; sealed: string | null }

export type HeartbeatResponse = {
  expires_at: number
  assigned_workspace_ids?: readonly string[]
  /** ONE credential covering the whole assigned∩ready set, or absent. */
  hostTunnel?: Record<string, unknown>
  assignments?: readonly AssignmentDescription[]
  scope?: HostScope
  /** Present only when the control plane holds a revision this machine has not acked. */
  providerConfig?: ProviderConfigRevision
} & HostEndpoints

/** The request signature covers the whole body, so it carries no payload signature of its own. */
export type MachineHeartbeatInput = {
  generation: number
  acks: readonly AssignmentAck[]
  ttlMs?: number
  sessionAuthority?: HostSessionAuthority
  /**
   * The public half of this machine's sealing key (`./machine-seal`), declared
   * on every beat so the control plane can seal a secret for it.
   *
   * Sent every time rather than once at enrollment: the enrollment handshake
   * predates it, a re-enrolled machine mints a new pair, and one column in an
   * UPDATE the beat already runs costs nothing. A machine that declares none
   * can be pushed nothing, which is what a machine with no opener should get.
   */
  sealingPublicKey?: string
  /** The provider-config revision this machine has STORED; the answer restates it only when it differs. */
  providerConfigRevision?: number
}

export type MachineTransport = {
  /**
   * Claim the next serving generation; every earlier instance's beats are
   * refused from then on. `timeoutMs` bounds this one request below the
   * transport's own bound, for a caller spending a retry budget.
   */
  acquire: (input?: { timeoutMs?: number }) => Promise<{ generation: number }>
  /**
   * One signed beat carries the lease renewal AND the acked set. The answer
   * carries the owner's current descriptions, the scope, the endpoints, and
   * one Host Tunnel credential covering every workspace that is both assigned
   * and acked — the serving side opens its relay tunnels from the same answer
   * that renewed the lease.
   */
  heartbeat: (input: MachineHeartbeatInput) => Promise<HeartbeatResponse>
}

export type ConnectorErrorStage = "heartbeat" | "acquire" | "reconcile" | "provider-config"

/**
 * Where a host stands on the directory a description names.
 *
 * A host that OPENS that directory — `claxedo connect`, which mounts a runtime
 * on it — supplies both halves. `roots` are the effective roots as the caller
 * currently holds them, already resolved (`resolveRoots` in `./host-state`
 * with the same `resolvePath`); they are read at every `ack`, after `onScope`
 * has delivered any newer scope, so a description is validated against the
 * roots in force when it is accepted, in the same coordinate space the
 * directory resolves into. `resolvePath` is `realpath`, so a symlink out of a
 * root is refused on the resolved path rather than the lexical one.
 *
 * A host that serves workspace ids out of a store it already owns supplies
 * neither. The desktop daemon keys its runtimes by workspace id and never
 * opens the directory a description carries, so there is no path to confine
 * and a root check would only refuse ids over a label; its consent is the
 * workspace id alone.
 */
export type MachineDirectoryScope =
  | {
    roots: () => readonly string[] | Promise<readonly string[]>
    resolvePath: (path: string) => Promise<string>
  }
  | { roots?: undefined; resolvePath?: undefined }

export type ConnectorOptions = MachineDirectoryScope & {
  mode: "machine"
  hostId: string
  transport: MachineTransport
  /** The enrollment this key redeemed; the machine signs and presents this, not its host id. */
  enrollmentId: string
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
  /**
   * This machine's sealing public key (`./machine-seal`), declared on every
   * beat. A connector built without one is a machine the owner cannot push
   * provider configuration to.
   */
  sealingPublicKey?: string
  /** Injected so a test does not wait, and so Electron can use its own timer. */
  setInterval: (fn: () => void, ms: number) => { cancel: () => void }
  onError?: (stage: ConnectorErrorStage, error: unknown) => void
  /**
   * The serving credential from the latest beat — one token whose claim is
   * exactly the workspaces this machine is currently routable for, or
   * undefined when nothing is. The consumer (the daemon's tunnel runner, via
   * the parent process) owns opening and closing the relay connection.
   */
  onServing?: (tunnel: Record<string, unknown> | undefined) => void
  /**
   * Every time a heartbeat renews the lease — on the timer, or forced by
   * `ack`/`unack` — with the state that now holds it.
   *
   * `state()` always answers this immediately; a caller across a process
   * boundary (Electron main's Host Connector child) does not poll it and can
   * only know the lease was renewed if told, so this is the one place that
   * tells it. Firing on every successful beat, not just the ones a caller
   * happened to be waiting on, is what keeps the cross-process status current
   * between explicit requests.
   */
  onLeaseRenewed?: (state: Extract<ConnectorState, { status: "enrolled" }>) => void
  /**
   * The complete current description list, every time it changes and again
   * while any description is delivered but unacked (next beat for five
   * attempts, then every tenth beat). Anything whose revision is not the one
   * the caller already serves has ALREADY been unacked here: the caller
   * closes that workspace's tunnel and runtime, validates, prepares the new
   * directory, then `ack`s the new revision; a preparation that fails leaves
   * the description pending for the next delivery. A workspace the caller
   * serves that is absent from the list is retired, and one the caller
   * `unack`ed stays absent from the list while the control plane keeps
   * offering the same revision — an `unack` is an answer, not a gap to
   * re-ask into.
   */
  onAssignments?: (descriptions: AssignmentDescription[]) => void | Promise<void>
  /** A newer scope revision, delivered before the same beat's assignments are reconciled. */
  onScope?: (scope: HostScope) => void | Promise<void>
  /**
   * The scope revision the caller already holds, from its own store. Without
   * it a restarted connector accepts the first scope a beat carries —
   * including a replayed one older than what it last accepted, which would
   * put roots the owner has since removed back in force.
   */
  scopeRevision?: number
  onEndpoints?: (endpoints: HostEndpoints) => void | Promise<void>
  /**
   * A provider-config revision the control plane holds and this machine does
   * not. The revision is acked on the next beat ONLY if this resolves: a host
   * that could not write the blob must keep asking for it, because an ack is
   * the control plane's evidence that the machine is configured and it stops
   * re-sending at that point. A rejection is reported through `onError` and
   * the same revision arrives again on the next beat.
   */
  onProviderConfig?: (config: ProviderConfigRevision) => void | Promise<void>
  /**
   * The revision this machine already held when the connector was built, from
   * the caller's own store. Without it every restart re-downloads a blob it
   * has on disk, and a machine whose control plane is unreachable would have
   * no way to say it is already configured.
   */
  providerConfigRevision?: number
}

/** The deadline for the acquire request, below the transport's own bound. */
export type StartInput = { acquireTimeoutMs?: number }

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
 * (`HostedHttpError` in `./machine-transport`), so the status is recoverable
 * from the message. An error with no status at all is a transport failure and
 * therefore transient; the enrollment lease at the control plane is what
 * bounds that, expiring on its own if the machine really has gone.
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
   * Which serving instance the connector is living in, counted.
   *
   * A beat can still be in flight when its instance ends: `close()` while
   * the control plane is slow to answer, or a restart whose `acquire` claims
   * the next generation (or is refused) before the older beat returns. That
   * answer describes an instance the control plane has already stopped
   * recognising, so adopting it would put the connector back into `enrolled`
   * — a terminal decision talked out of by a message that predates it.
   *
   * Every departure from an enrolled instance goes through `stop`, and every
   * arrival through `start`; both move this on, so a beat's answer is current
   * if, and only if, this number has not moved since the beat was issued.
   */
  let era = 0

  /**
   * The owner's intent and this host's consent.
   *
   * `descriptions` is the last delivered assignment list, `acked` the subset
   * this host has said it serves, by revision. The two disagree by design
   * between a change arriving and the caller re-acking it: that gap is the
   * withdrawal, and the control plane stops routing the workspace for exactly
   * as long as it lasts.
   *
   * `pending` is every description delivered but not yet acked at its
   * current revision, with how many deliveries it has had and how many beats
   * to sit out before the next one. A preparation that failed (directory not
   * there yet, endpoints not delivered yet) is re-delivered on the next beat
   * for the first five attempts and on every tenth beat after that, so a
   * folder created after the assignment is served without a restart while a
   * folder that never appears costs one attempt every ten beats.
   */
  const descriptions = new Map<string, AssignmentDescription>()
  const acked = new Map<string, number>()
  const pending = new Map<string, { attempts: number; skip: number }>()
  /**
   * Revisions the caller explicitly refused through `unack`, by workspace. A
   * redelivery at or below the refused revision is the same consent question
   * already answered — it is not re-presented to `onAssignments`, where a
   * caller that acks what it is shown would silently re-grant it. A newer
   * revision, or the assignment leaving the control plane's list entirely, is
   * a new question and the refusal ends.
   */
  const refused = new Map<string, number>()
  const PENDING_EVERY_BEAT_ATTEMPTS = 5
  const PENDING_RETRY_EVERY_BEATS = 10
  let generation: number | undefined
  let scopeRevision = options.scopeRevision
  let deliveredEndpoints: string | undefined
  /**
   * The revision the CALLER has stored, which is the only thing the control
   * plane is told. It moves after `onProviderConfig` resolves and never
   * before: a beat that claimed a revision the host had failed to write would
   * stop the control plane re-delivering it, leaving a machine that believes
   * it is configured and a control plane that agrees.
   */
  let providerConfigRevision = options.providerConfigRevision
  /**
   * Set by `drain()` and never cleared: from then on `ack` is refused, the
   * timer is gone, a beat still in flight delivers nothing when it lands,
   * and the only beat left to send is the drain's own. Consent given during
   * a drain would be published by that final beat and then abandoned by the
   * process closing behind it — readiness at the control plane for a host
   * that is gone.
   */
  let draining = false

  const stop = (reason: Extract<ConnectorState, { status: "stopped" }>["reason"], detail: string) => {
    era++
    timer?.cancel()
    timer = undefined
    descriptions.clear()
    acked.clear()
    pending.clear()
    refused.clear()
    state = { status: "stopped", reason, detail }
  }

  const installTimer = () => {
    // The previous loop, if any, before installing this one: an overwritten
    // handle is a timer nothing holds and `close()` can no longer cancel.
    timer?.cancel()
    timer = options.setInterval(() => {
      void requestBeat()
    }, options.heartbeatIntervalMs)
  }

  const settleFailedBeat = (startedIn: number, error: unknown) => {
    // A beat that was already open when the user paused comes back rejected —
    // the generation is being let go, so of course it does — and reporting
    // that as `revoked` tells the user their access was taken away when they
    // turned it off themselves. The era check is the same one the success
    // path applies to a late answer.
    if (startedIn !== era) return
    options.onError?.("heartbeat", error)
    // A decision (revoked, paused past expiry, enrolled elsewhere, a newer
    // instance holds the generation) stops the connector: acquiring again
    // would overrule the user. A disruption keeps the enrollment for the next
    // beat to retry: a control plane mid-deploy answers
    // `503 deployment_candidate_unavailable` for the seconds between the
    // upload and the phase opening, and stopping on that would leave a
    // machine with a live lease and open relay sockets permanently offline.
    // If the control plane really is gone, the lease expires there on its own.
    if (transientHeartbeatFailure(error)) return
    stop("revoked", String(error))
  }

  /**
   * Apply one response, in the order the control plane's own state changes:
   * scope, then the endpoints, then the provider configuration, then the
   * assignments — a tightened root retires an assignment in the same batch, so
   * the roots must be in force before any description is validated, and a
   * workspace that begins serving on this beat should already hold the
   * credentials its first turn resolves. The serving credential and the lease
   * listener follow in `runBeat`.
   *
   * A provider-config delivery that the caller refuses is reported and left
   * unacked, and the assignments still reconcile: a host that cannot write a
   * secret must not also stop serving the folders it already serves.
   */
  const reconcile = async (result: HeartbeatResponse) => {
    // The revision moves only once the caller has stored the scope: a
    // callback that fails must get the delivery again, because the fence that
    // keeps a replayed older scope out lives in the caller's file, not here.
    if (result.scope && (scopeRevision === undefined || result.scope.revision > scopeRevision)) {
      await options.onScope?.(result.scope)
      scopeRevision = result.scope.revision
    }
    if (result.relay || result.authority) {
      const endpoints: HostEndpoints = {
        ...(result.relay ? { relay: result.relay } : {}),
        ...(result.authority ? { authority: result.authority } : {}),
      }
      const serialized = JSON.stringify(endpoints)
      if (serialized !== deliveredEndpoints) {
        deliveredEndpoints = serialized
        await options.onEndpoints?.(endpoints)
      }
    }
    // Strictly newer, not merely different: a replayed older revision would
    // reinstate a credential the owner rotated away or withdrew, and the seal
    // cannot refuse it — that blob really was sealed at that revision, so its
    // tag verifies. This is the only check that stops the rollback.
    if (
      result.providerConfig &&
      (providerConfigRevision === undefined || result.providerConfig.revision > providerConfigRevision)
    ) {
      try {
        await options.onProviderConfig?.(result.providerConfig)
        providerConfigRevision = result.providerConfig.revision
      } catch (error) {
        options.onError?.("provider-config", error)
      }
    }
    if (!result.assignments) return
    let changed = false
    const present = new Set<string>()
    for (const description of result.assignments) {
      present.add(description.workspaceId)
      const refusedAt = refused.get(description.workspaceId)
      if (refusedAt !== undefined) {
        if (description.revision <= refusedAt) continue
        refused.delete(description.workspaceId)
      }
      const current = descriptions.get(description.workspaceId)
      // A description at or below the applied revision is old news — either
      // unchanged, or a stale snapshot overlapping a newer one — and cannot
      // reinstate a directory the owner has already moved on from.
      if (current && current.revision >= description.revision) continue
      descriptions.set(description.workspaceId, description)
      // The withdrawal: the ack was for the previous revision, so it is gone
      // before the caller hears about the change. The next beat sends the
      // smaller set and the control plane stops minting for this workspace
      // until the new revision is acked.
      acked.delete(description.workspaceId)
      pending.set(description.workspaceId, { attempts: 0, skip: 0 })
      changed = true
    }
    // Deleting during iteration is defined for Map: a removed key is skipped, nothing is revisited.
    for (const workspaceId of descriptions.keys()) {
      if (present.has(workspaceId)) continue
      descriptions.delete(workspaceId)
      acked.delete(workspaceId)
      pending.delete(workspaceId)
      changed = true
    }
    for (const workspaceId of refused.keys()) {
      // The owner withdrew the assignment outright, so the question it asked
      // no longer stands; if the workspace is ever assigned again it is a new
      // statement, not a replay of the refused one.
      if (!present.has(workspaceId)) refused.delete(workspaceId)
    }
    let due = changed
    for (const entry of pending.values()) {
      if (entry.skip === 0) due = true
      else entry.skip--
    }
    if (!due) return
    for (const entry of pending.values()) {
      entry.attempts++
      entry.skip = entry.attempts < PENDING_EVERY_BEAT_ATTEMPTS ? 0 : PENDING_RETRY_EVERY_BEATS - 1
    }
    await options.onAssignments?.(currentDescriptions())
  }

  const currentAcks = (): AssignmentAck[] =>
    [...acked]
      .map(([workspaceId, revision]) => ({ workspaceId, revision }))
      .sort((a, b) => (a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0))

  const currentDescriptions = () =>
    [...descriptions.values()].sort((a, b) => (a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0))

  /**
   * Beats are serialized: one in flight, at most one queued behind it, and a
   * queued beat sends the acks as they stand when it starts. Reconciliation
   * callbacks run inside the beat, so the caller's `ack` from `onAssignments`
   * queues the very beat that carries it.
   */
  let inFlight: Promise<ConnectorState> | undefined
  let queued: Promise<ConnectorState> | undefined

  const requestBeat = (): Promise<ConnectorState> => {
    if (draining) return Promise.resolve(state)
    if (inFlight) {
      queued ??= inFlight
        .catch(() => undefined)
        .then(() => {
          queued = undefined
          return requestBeat()
        })
      return queued
    }
    inFlight = runBeat("serving").finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  const runBeat = async (purpose: "serving" | "drain"): Promise<ConnectorState> => {
    if (state.status !== "enrolled" || generation === undefined) return state
    const startedIn = era
    const enrollment = state.enrollment
    try {
      const result = await options.transport.heartbeat({
        generation,
        acks: currentAcks(),
        ...(options.sessionAuthority ? { sessionAuthority: options.sessionAuthority } : {}),
        ...(options.sealingPublicKey ? { sealingPublicKey: options.sealingPublicKey } : {}),
        ...(providerConfigRevision === undefined ? {} : { providerConfigRevision }),
      })
      // The instance this beat was proving ended while it was in flight —
      // stopped, or superseded by a newer generation. Its answer describes a
      // machine the control plane has already stopped recognising.
      if (startedIn !== era) return state
      state = { status: "enrolled", enrollment: { ...enrollment, expires_at: result.expires_at } }
      if (purpose === "drain") {
        options.onServing?.(undefined)
        return state
      }
      // A serving beat that lands after `drain()` began describes a host
      // that is leaving: its descriptions would start preparations the
      // drain then refuses, and its credential would reopen tunnels.
      if (draining) return state
      try {
        await reconcile(result)
      } catch (error) {
        options.onError?.("reconcile", error)
      }
      if (startedIn !== era || draining) return state
      options.onServing?.(result.hostTunnel)
      options.onLeaseRenewed?.(state)
    } catch (error) {
      settleFailedBeat(startedIn, error)
    }
    return state
  }

  return {
    state: () => state,

    /** The serving generation this instance acquired, once started. */
    generation: () => generation,

    /** The current description list, as last applied. */
    assignments: currentDescriptions,

    /** What this host has consented to serve, by revision. */
    acked: currentAcks,

    /** The provider-config revision this host has stored, as the next beat will state it. */
    providerConfigRevision: () => providerConfigRevision,

    /**
     * Consent to serve one description at one revision, and request the beat
     * that carries it so the readiness row lands within a round trip. The beat
     * is requested, not awaited: `onAssignments` runs inside a beat, and an ack
     * issued there that waited for the next beat would wait for the one it is
     * inside — the queued beat runs the moment this one settles.
     *
     * Refused — and never sent — for a revision that is not the current one
     * (the owner moved on again), for a directory whose RESOLVED path is
     * outside the effective roots of a host that confines directories (a
     * symlink out of a root is the case the lexical check at the control plane
     * cannot see), and once `drain()` has begun, so a preparation that outlives
     * the stop signal retires its workspace instead of publishing it.
     */
    async ack(input: AssignmentAck): Promise<void> {
      if (draining) throw new Error(`assignment ${input.workspaceId}: this host is draining and serves nothing new`)
      if (state.status !== "enrolled") throw new Error("remote access is not active on this machine")
      const current = descriptions.get(input.workspaceId)
      if (!current) throw new Error(`no assignment for workspace ${input.workspaceId} on this machine`)
      if (current.revision !== input.revision) {
        throw new Error(
          `assignment ${input.workspaceId} moved to revision ${current.revision} while revision ${input.revision} was being prepared`,
        )
      }
      if (options.roots && options.resolvePath) {
        const roots = await options.roots()
        const resolved = await options.resolvePath(current.remoteDirectory).catch((error: unknown) => {
          throw new Error(`assignment ${input.workspaceId}: ${current.remoteDirectory} cannot be resolved: ${String(error)}`)
        })
        if (!pathWithinRoots(resolved, roots)) {
          throw new Error(`assignment ${input.workspaceId}: ${current.remoteDirectory} is outside this host's roots`)
        }
      }
      // A beat may have reconciled while the paths were resolving; consent is
      // for the description that was validated, not whatever arrived since.
      if (descriptions.get(input.workspaceId)?.revision !== input.revision || state.status !== "enrolled") {
        throw new Error(`assignment ${input.workspaceId} changed while revision ${input.revision} was being validated`)
      }
      if (draining) throw new Error(`assignment ${input.workspaceId}: this host is draining and serves nothing new`)
      acked.set(input.workspaceId, input.revision)
      pending.delete(input.workspaceId)
      void requestBeat()
    },

    /**
     * Withdraw consent for one workspace and beat so the control plane stops
     * routing it. The refusal is recorded at the description's current
     * revision, so the control plane re-listing that same assignment — a
     * stale response, or an unassign that has not propagated — does not put
     * the question back in front of the caller.
     *
     * Awaited, unlike `ack`: a withdrawal is issued by the caller
     * on its own initiative, never from inside a reconciliation.
     */
    async unack(workspaceId: string): Promise<void> {
      const description = descriptions.get(workspaceId)
      if (description) {
        refused.set(workspaceId, description.revision)
        descriptions.delete(workspaceId)
        pending.delete(workspaceId)
      }
      if (!acked.delete(workspaceId)) return
      if (state.status !== "enrolled" || draining) return
      await requestBeat()
    },

    /**
     * Withdraw every ack in one last beat before closing. Without it a
     * machine that exited cleanly stays routable at the control plane until
     * its lease expires, and every client sees an offline host answer as a
     * live one for that long.
     *
     * The beat is sent only after the beat in flight — and the preparation
     * its reconciliation may be awaiting — has settled, and the acks are
     * cleared at that moment rather than when the drain was requested: an
     * ack that landed in between would otherwise ride the final beat.
     */
    async drain(): Promise<void> {
      if (state.status !== "enrolled" || draining) return
      draining = true
      timer?.cancel()
      timer = undefined
      for (let beat = inFlight; beat; beat = inFlight) await beat.catch(() => undefined)
      acked.clear()
      pending.clear()
      await runBeat("drain")
    },

    async start(input: StartInput = {}): Promise<ConnectorState> {
      try {
        const acquired = await options.transport.acquire(input.acquireTimeoutMs === undefined ? undefined : { timeoutMs: input.acquireTimeoutMs })
        era++
        generation = acquired.generation
        state = {
          status: "enrolled",
          enrollment: { enrollment_id: options.enrollmentId, host_id: options.hostId, expires_at: 0 },
        }
      } catch (error) {
        options.onError?.("acquire", error)
        stop(transientHeartbeatFailure(error) ? "error" : "revoked", String(error))
        return state
      }
      installTimer()
      // The first beat is part of starting: it is what turns a claimed
      // generation into a live lease and delivers the assignments, and a
      // decision there (revoked between redeem and now) belongs to `start`.
      return await requestBeat()
    },

    /** One heartbeat. Exposed so a caller can force one after a wake from sleep. */
    async beat(): Promise<ConnectorState> {
      return await requestBeat()
    },

    close() {
      if (state.status === "stopped") return
      stop("closed", "connector closed")
    },
  }
}
