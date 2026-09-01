import type { LocalWorkspaceDescription } from "./local-workspace-description"
import {
  parseHostConnectorChildMessage,
  type HostConnectorBootstrapIdentity,
  type HostConnectorChildMessage,
  type HostConnectorChildState,
  type HostConnectorParentMessage,
  type HostConnectorSharedWorkspace,
} from "./child-protocol"

export type AccountOperationRunner = (name: string, input?: Record<string, unknown>) => Promise<unknown>

export type HostConnectorChildProcess = {
  postMessage(message: HostConnectorParentMessage): void
  kill(): boolean
  on(event: "message", listener: (message: unknown) => void): void
  once(event: "exit", listener: (code: number) => void): void
}

export type HostConnectorStatus =
  | { status: "not-started" }
  | { status: "unavailable"; reason: "no-secure-storage"; detail: string }
  | HostConnectorChildState

export type HostConnectorSetup = {
  status(): HostConnectorStatus
  start(): Promise<HostConnectorStatus>
  /**
   * Publish one workspace from this machine. The child signs the control
   * plane's challenge with the machine key; success is remembered so the
   * share is re-established after a restart.
   */
  shareWorkspace(input: { workspaceId: string; displayName?: string }): Promise<HostConnectorStatus>
  unshareWorkspace(workspaceId: string): Promise<HostConnectorStatus>
  /** The user's pause. Keeps the identity; cancels any pending auto-resume. */
  stop(): void
  /**
   * Stop because the ACCOUNT lapsed, not because anyone chose to.
   *
   * Separate from `stop()` because the two look identical from the outside and
   * must not behave identically afterwards. Failing closed on auth loss is
   * right — a credential the deployment may have revoked must not keep
   * beating — but a two-second control-plane blip then un-published the machine
   * for good, because nothing remembered that the stop was not a decision.
   *
   * Returns whether there was anything to suspend, so the caller can say so in
   * the log without guessing.
   */
  suspendForAuthLapse(): boolean
  /**
   * Undo exactly one `suspendForAuthLapse()`, and nothing else.
   *
   * Answers `undefined` when the last stop was NOT an auth lapse — including
   * when the connector was never started, which is why an account merely
   * becoming signed can never publish a machine that was not already published.
   */
  resumeAfterAuthLapse(): Promise<HostConnectorStatus | undefined>
  revoke(): void
  dispose(): void
}

/**
 * The stopped-state detail an auth lapse leaves behind.
 *
 * Distinct from the user's pause on purpose: this string is what the panel and
 * `main.log` show for a machine that went off the air without anyone asking.
 */
export const HOST_CONNECTOR_AUTH_LAPSE_DETAIL =
  "the account session lapsed; remote access is suspended until it returns"

type PendingRequest = {
  resolve(status: HostConnectorChildState): void
  reject(error: Error): void
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}

function bounded<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(new Error(`${description} timed out after ${String(timeoutMs)}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (handle) clearTimeout(handle)
  })
}

/**
 * Electron-main ownership of one optional Host Connector child.
 *
 * Constructing the supervisor performs no artifact resolution and no spawn.
 * `start()` is the only launch edge, and the executable path lives in the
 * injected fixed factory rather than in renderer input.
 */
export function setupHostConnectorChild(input: {
  runAccountOperation: AccountOperationRunner
  spawn: () => HostConnectorChildProcess
  loadIdentity: () => Promise<
    | { ok: true; identity?: HostConnectorBootstrapIdentity }
    | { ok: false; reason: "no-secure-storage"; detail: string }
  >
  storeIdentity: (identity: HostConnectorBootstrapIdentity) => Promise<{ ok: true } | { ok: false; detail: string }>
  clearIdentity: () => void
  /**
   * Shares to survive a restart. Not secrets — workspace ids and labels; the
   * proof is re-signed by the child at every registration and heartbeat.
   */
  loadSharedWorkspaces?: () => readonly HostConnectorSharedWorkspace[]
  storeSharedWorkspaces?: (shares: readonly HostConnectorSharedWorkspace[]) => void
  /**
   * This machine's own description of a workspace it is about to share —
   * directory, repository, branch, name — recorded on the control plane's
   * host assignment so every client addresses the workspace by what it is.
   */
  describeWorkspace?: (workspaceId: string) => Promise<LocalWorkspaceDescription | undefined>
  /** The serving credential from the latest heartbeat ack, for the tunnel owner. */
  onServing?: (tunnel: Record<string, unknown> | null) => void
  displayName?: string
  heartbeatIntervalMs?: number
  /**
   * Budget for the child to exist and answer with its identity: spawn, `ready`,
   * and the bootstrap reply. No control-plane traffic happens inside it.
   */
  startupTimeoutMs?: number
  /**
   * Budget for the enrollment that follows the bootstrap reply — the
   * createRequest/enroll/heartbeat round trips the child now runs after
   * answering. Wider than the startup budget on purpose: this deployment's
   * edge can withhold a POST response on a warm connection for around twelve
   * seconds, so the budget has to cover one such stall plus a retry.
   */
  enrollmentTimeoutMs?: number
  onError?: (stage: string, error: unknown) => void
  onStatusChange?: (status: HostConnectorStatus) => void
}): HostConnectorSetup {
  let status: HostConnectorStatus = { status: "not-started" }
  let identityHostId: string | undefined
  let sharedWorkspaces: HostConnectorSharedWorkspace[] = [...(input.loadSharedWorkspaces?.() ?? [])]
  let child: HostConnectorChildProcess | undefined
  let starting: Promise<HostConnectorStatus> | undefined
  let cancelStarting: ((error: Error) => void) | undefined
  let era = 0
  let intentionalExit = false
  /**
   * Set only when THIS process stopped a RUNNING connector because the account
   * left "signed" — never by a user pause, a revoke, or a child crash.
   *
   * Deliberately in memory. It answers one question — "was remote access taken
   * away from this machine, or turned off on it?" — and that question only has
   * meaning for the lifetime of the stop it describes. A relaunch already has
   * its own resume path through the persisted identity and share list, so a
   * flag on disk could only outlive its own truth.
   */
  let authLapseSuspended = false
  const pending = new Map<string, PendingRequest>()
  /**
   * The one launch waiting for its child to finish enrolling.
   *
   * The bootstrap reply now means "alive, with an identity", so the enrollment
   * outcome arrives later on the push channel. This is where `launch` parks
   * until the child's first non-idle status — enrolled, or stopped with the
   * connector's own detail — so `start()` still resolves on a decided machine
   * rather than on a spawned process.
   */
  let enrolling: { target: HostConnectorChildProcess; waiting: PendingRequest } | undefined

  const settle = (next: HostConnectorStatus) => {
    status = next
    input.onStatusChange?.(next)
    return next
  }

  const rejectPending = (error: Error) => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    const waiting = enrolling
    enrolling = undefined
    waiting?.waiting.reject(error)
  }

  const send = (target: HostConnectorChildProcess, message: HostConnectorParentMessage) => {
    if (child !== target) throw new Error("Host Connector child is no longer active")
    target.postMessage(message)
  }

  const request = (
    target: HostConnectorChildProcess,
    message: Extract<HostConnectorParentMessage, { requestId: string }>,
  ) => {
    const waiting = deferred<HostConnectorChildState>()
    pending.set(message.requestId, waiting)
    send(target, message)
    return waiting.promise.finally(() => pending.delete(message.requestId))
  }

  const onChildMessage = async (target: HostConnectorChildProcess, value: unknown) => {
    if (target !== child) return
    const message = parseHostConnectorChildMessage(value)
    if (!message) return

    if (message.type === "response") {
      const waiting = pending.get(message.requestId)
      if (!waiting) return
      if (message.ok) waiting.resolve(message.status)
      else waiting.reject(new Error(message.error))
      return
    }
    if (message.type === "status") {
      settle(message.status)
      // `idle` is the pre-enrollment state the bootstrap reply already carried;
      // only a decided one ends the wait.
      if (message.status.status !== "idle" && enrolling?.target === target) {
        const waiting = enrolling
        enrolling = undefined
        waiting.waiting.resolve(message.status)
      }
      return
    }
    if (message.type === "serving") {
      input.onServing?.(message.tunnel)
      return
    }
    if (message.type === "account-operation") {
      try {
        const value = await input.runAccountOperation(message.name, message.input)
        if (child !== target) return
        send(target, { type: "account-result", requestId: message.requestId, ok: true, value })
      } catch (error) {
        if (child !== target) return
        send(target, { type: "account-result", requestId: message.requestId, ok: false, error: String(error) })
      }
      return
    }
    if (message.type === "identity-created") {
      identityHostId = message.identity.hostId
      try {
        const stored = await input.storeIdentity(message.identity)
        if (!stored.ok) throw new Error(stored.detail)
        if (child !== target) return
        send(target, { type: "identity-stored", requestId: message.requestId })
      } catch (error) {
        input.onError?.("identity-store", error)
        intentionalExit = true
        target.kill()
      }
    }
  }

  const launch = async (cancelled: Promise<never>): Promise<HostConnectorStatus> => {
    const startedIn = era
    const restored = await Promise.race([input.loadIdentity(), cancelled])
    if (startedIn !== era) return status
    if (!restored.ok) return settle({ status: "unavailable", reason: restored.reason, detail: restored.detail })
    identityHostId = restored.identity?.hostId

    const target = input.spawn()
    child = target
    intentionalExit = false
    const ready = deferred<void>()
    target.on("message", (message) => {
      const parsed = parseHostConnectorChildMessage(message)
      if (parsed?.type === "ready") ready.resolve()
      void onChildMessage(target, message).catch((error) => input.onError?.("child-message", error))
    })
    target.once("exit", (code) => {
      if (child !== target) return
      child = undefined
      const exitError = new Error(`Host Connector child exited with code ${String(code)}`)
      ready.reject(exitError)
      rejectPending(exitError)
      if (!intentionalExit) {
        const detail = `Host Connector child exited unexpectedly with code ${String(code)}`
        input.onError?.("child-exit", detail)
        settle({ status: "stopped", reason: "error", detail })
      }
    })

    const startupTimeoutMs = input.startupTimeoutMs ?? 10_000
    await bounded(Promise.race([ready.promise, cancelled]), startupTimeoutMs, "Host Connector child ready")
    if (startedIn !== era || child !== target) return status

    // Armed BEFORE the bootstrap is sent: a child that enrolls quickly can push
    // its status before this side resumes, and a wait registered afterwards
    // would miss the only announcement it is waiting for.
    const enrolled = deferred<HostConnectorChildState>()
    // The wait can be rejected by an exit or a terminate before `launch` has
    // reached the race below; keeping a handler attached from the start is what
    // stops that from surfacing as an unhandled rejection in main.
    enrolled.promise.catch(() => {})
    enrolling = { target, waiting: enrolled }

    try {
      const requestId = crypto.randomUUID()
      const booted = await bounded(
        Promise.race([
          request(target, {
            type: "bootstrap",
            requestId,
            heartbeatIntervalMs: input.heartbeatIntervalMs ?? 20_000,
            ...(restored.identity ? { identity: restored.identity } : {}),
            ...(input.displayName ? { displayName: input.displayName } : {}),
            ...(sharedWorkspaces.length ? { sharedWorkspaces } : {}),
          }),
          cancelled,
        ]),
        startupTimeoutMs,
        "Host Connector child bootstrap",
      )
      if (startedIn !== era) return status
      // The child is alive and holds its machine identity. Publish that, so a
      // panel opened during a slow enrollment shows a starting machine rather
      // than the state from before the click.
      settle(booted)

      // Then the part that talks to the control plane. Its outcome arrives on
      // the push channel, which is also how every later transition — an
      // expiry, a rejected beat, a revocation — reaches this process.
      const decided = await bounded(
        Promise.race([enrolled.promise, cancelled]),
        input.enrollmentTimeoutMs ?? 45_000,
        "Host Connector child enrollment",
      )
      if (startedIn !== era) return status
      // Already announced by the status handler that resolved this wait; the
      // child's push is the authority, so this reads it back rather than
      // settling the same transition twice.
      return decided
    } finally {
      if (enrolling?.target === target) enrolling = undefined
    }
  }

  const terminate = (reason: "closed" | "revoked" | "error", detail: string) => {
    era++
    intentionalExit = true
    cancelStarting?.(new Error(detail))
    const target = child
    if (target) {
      try {
        target.postMessage({ type: "stop", requestId: crypto.randomUUID() })
      } finally {
        target.kill()
      }
      if (child === target) child = undefined
    }
    rejectPending(new Error(detail))
    settle({ status: "stopped", reason, detail })
  }

  const startConnector = async (): Promise<HostConnectorStatus> => {
    // Whoever reaches this has decided the machine should be on the air, so
    // there is no longer an involuntary stop for a later sign-in to undo.
    // That covers the user pressing Enable while a lapse-suspension is armed.
    authLapseSuspended = false
    if (starting) return starting
    if (child && status.status === "enrolled") return status
    if (child) {
      const stale = child
      intentionalExit = true
      try {
        stale.postMessage({ type: "stop", requestId: crypto.randomUUID() })
      } finally {
        stale.kill()
      }
      if (child === stale) child = undefined
      rejectPending(new Error("restarting stopped Host Connector child"))
    }
    // `terminate` is the only thing that moves the era, so a change across this
    // launch means a pause or revoke landed mid-flight — and the error below is
    // then that cancellation, which must not overwrite the deliberate stop.
    const startedIn = era
    const cancellation = deferred<never>()
    cancelStarting = cancellation.reject
    starting = launch(cancellation.promise)
      .catch((error) => {
        if (child) {
          intentionalExit = true
          child.kill()
          child = undefined
        }
        input.onError?.("child-start", error)
        if (era !== startedIn && status.status === "stopped" && (status.reason === "revoked" || status.reason === "closed")) {
          return status
        }
        // Nothing interrupted this launch; it failed on its own. Reporting the
        // stopped state it started from would leave the panel and `main.log`
        // blaming whatever stopped the machine last — after an auth lapse, an
        // account that has already come back — for a failure that is entirely
        // this attempt's.
        return settle({ status: "stopped", reason: "error", detail: String(error) })
      })
      .finally(() => {
        starting = undefined
        if (cancelStarting === cancellation.reject) cancelStarting = undefined
      })
    return starting
  }

  return {
    status: () => status,
    start: startConnector,
    async shareWorkspace(share: { workspaceId: string; displayName?: string }) {
      const target = child
      if (!target || status.status !== "enrolled" || !identityHostId) {
        throw new Error("Remote access is not running on this machine — enable it in Settings first")
      }
      // Owner intent first: the account credential (main's) assigns the
      // workspace to this host at the control plane. Machine consent second:
      // the child adds the id to its served set and forces one signed beat,
      // and only a beat that comes back with the assignment counts as shared.
      const description = await input.describeWorkspace?.(share.workspaceId)
      const displayName = share.displayName ?? description?.displayName
      await input.runAccountOperation("workspace.assignHost", {
        id: share.workspaceId,
        hostId: identityHostId,
        ...(displayName ? { displayName } : {}),
        ...(description
          ? {
              remoteDirectory: description.directory,
              ...(description.repoName ? { repoName: description.repoName } : {}),
              ...(description.gitBranch ? { gitBranch: description.gitBranch } : {}),
              ...(description.repoUrl ? { repoUrl: description.repoUrl } : {}),
            }
          : {}),
      })
      const settled = await bounded(
        request(target, {
          type: "share-workspace",
          requestId: crypto.randomUUID(),
          workspaceId: share.workspaceId,
          ...(share.displayName ? { displayName: share.displayName } : {}),
        }),
        input.startupTimeoutMs ?? 10_000,
        "Host Connector workspace share",
      )
      sharedWorkspaces = [
        ...sharedWorkspaces.filter((existing) => existing.workspaceId !== share.workspaceId),
        { workspaceId: share.workspaceId, ...(share.displayName ? { displayName: share.displayName } : {}) },
      ]
      try {
        input.storeSharedWorkspaces?.(sharedWorkspaces)
      } catch (error) {
        input.onError?.("share-store", error)
      }
      return settle(settled)
    },

    async unshareWorkspace(workspaceId: string) {
      const target = child
      if (!target || status.status !== "enrolled") {
        throw new Error("Remote access is not running on this machine — enable it in Settings first")
      }
      await input.runAccountOperation("workspace.unassignHost", { id: workspaceId })
      const settled = await bounded(
        request(target, { type: "unshare-workspace", requestId: crypto.randomUUID(), workspaceId }),
        input.startupTimeoutMs ?? 10_000,
        "Host Connector workspace unshare",
      )
      sharedWorkspaces = sharedWorkspaces.filter((existing) => existing.workspaceId !== workspaceId)
      try {
        input.storeSharedWorkspaces?.(sharedWorkspaces)
      } catch (error) {
        input.onError?.("share-store", error)
      }
      return settle(settled)
    },

    stop() {
      // The user's pause is a decision, and a decision outranks whatever this
      // process was holding open to restore. Clearing here is what stops "I
      // turned remote access off" from being quietly undone by the next
      // sign-in.
      authLapseSuspended = false
      terminate("closed", "connector closed")
    },

    suspendForAuthLapse() {
      // Nothing to take away: never started, already stopped, or already
      // suspended. Arming on those would let an auth flap while the connector
      // is off turn the NEXT sign-in into an enable nobody asked for.
      if (!child && !starting) return false
      authLapseSuspended = true
      terminate("closed", HOST_CONNECTOR_AUTH_LAPSE_DETAIL)
      return true
    },

    async resumeAfterAuthLapse() {
      if (!authLapseSuspended) return undefined
      // Consumed before the attempt, not after it: one restart per suspension
      // is the entire budget. A restart that fails leaves the machine stopped
      // with its reason on the panel, rather than re-arming a retry that would
      // run again on every account transition for the rest of the session.
      authLapseSuspended = false
      // `start()` re-reads the share list this suspension left untouched, so
      // the machine comes back publishing what it was publishing. There is no
      // second store for that, and there must not be one.
      return await startConnector()
    },

    revoke() {
      // Same reason as `stop()`, and more so: the user destroyed this
      // machine's identity. Nothing about a later sign-in may bring it back.
      authLapseSuspended = false
      // A destroyed identity can never heartbeat these links again; keeping
      // them stored would only re-register them under a DIFFERENT machine on
      // the next enable, which is not what "revoke" promised.
      sharedWorkspaces = []
      try {
        input.storeSharedWorkspaces?.(sharedWorkspaces)
      } catch (error) {
        input.onError?.("share-store", error)
      }
      try {
        input.clearIdentity()
        terminate("revoked", "remote access revoked on this machine")
      } catch (error) {
        input.onError?.("identity-clear", error)
        terminate("error", `failed to remove the remote access identity: ${String(error)}`)
      }
    },
    dispose() {
      terminate("closed", "desktop is shutting down")
    },
  }
}
