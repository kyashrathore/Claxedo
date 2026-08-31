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
  stop(): void
  revoke(): void
  dispose(): void
}

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
  displayName?: string
  heartbeatIntervalMs?: number
  startupTimeoutMs?: number
  onError?: (stage: string, error: unknown) => void
  onStatusChange?: (status: HostConnectorStatus) => void
}): HostConnectorSetup {
  let status: HostConnectorStatus = { status: "not-started" }
  let sharedWorkspaces: HostConnectorSharedWorkspace[] = [...(input.loadSharedWorkspaces?.() ?? [])]
  let child: HostConnectorChildProcess | undefined
  let starting: Promise<HostConnectorStatus> | undefined
  let cancelStarting: ((error: Error) => void) | undefined
  let era = 0
  let intentionalExit = false
  const pending = new Map<string, PendingRequest>()

  const settle = (next: HostConnectorStatus) => {
    status = next
    input.onStatusChange?.(next)
    return next
  }

  const rejectPending = (error: Error) => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
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
    const requestId = crypto.randomUUID()
    const started = await bounded(
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
    return settle(started)
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

  return {
    status: () => status,
    async start() {
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
          if (status.status === "stopped" && (status.reason === "revoked" || status.reason === "closed")) return status
          return settle({ status: "stopped", reason: "error", detail: String(error) })
        })
        .finally(() => {
          starting = undefined
          if (cancelStarting === cancellation.reject) cancelStarting = undefined
        })
      return starting
    },
    async shareWorkspace(share: { workspaceId: string; displayName?: string }) {
      const target = child
      if (!target || status.status !== "enrolled") {
        throw new Error("Remote access is not running on this machine — enable it in Settings first")
      }
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

    stop() {
      terminate("closed", "connector closed")
    },
    revoke() {
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
