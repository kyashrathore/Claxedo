import {
  parseHostConnectorChildMessage,
  type HostConnectorBootstrapIdentity,
  type HostConnectorChildMessage,
  type HostConnectorChildState,
  type HostConnectorParentMessage,
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
    handle.unref?.()
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
  displayName?: string
  heartbeatIntervalMs?: number
  startupTimeoutMs?: number
  onError?: (stage: string, error: unknown) => void
  onStatusChange?: (status: HostConnectorStatus) => void
}): HostConnectorSetup {
  let status: HostConnectorStatus = { status: "not-started" }
  let child: HostConnectorChildProcess | undefined
  let starting: Promise<HostConnectorStatus> | undefined
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
        send(target, { type: "account-result", requestId: message.requestId, ok: true, value })
      } catch (error) {
        send(target, { type: "account-result", requestId: message.requestId, ok: false, error: String(error) })
      }
      return
    }
    if (message.type === "identity-created") {
      try {
        const stored = await input.storeIdentity(message.identity)
        if (!stored.ok) throw new Error(stored.detail)
        send(target, { type: "identity-stored", requestId: message.requestId })
      } catch (error) {
        input.onError?.("identity-store", error)
        intentionalExit = true
        target.kill()
      }
    }
  }

  const launch = async (): Promise<HostConnectorStatus> => {
    const startedIn = era
    const restored = await input.loadIdentity()
    if (startedIn !== era) return status
    if (!restored.ok) return settle({ status: "unavailable", reason: restored.reason, detail: restored.detail })

    const target = input.spawn()
    child = target
    intentionalExit = false
    const ready = deferred<void>()
    target.on("message", (message) => {
      const parsed = parseHostConnectorChildMessage(message)
      if (parsed?.type === "ready") ready.resolve()
      void onChildMessage(target, message)
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
    await bounded(ready.promise, startupTimeoutMs, "Host Connector child ready")
    if (startedIn !== era || child !== target) return status
    const requestId = crypto.randomUUID()
    const started = await bounded(
      request(target, {
        type: "bootstrap",
        requestId,
        heartbeatIntervalMs: input.heartbeatIntervalMs ?? 20_000,
        ...(restored.identity ? { identity: restored.identity } : {}),
        ...(input.displayName ? { displayName: input.displayName } : {}),
      }),
      startupTimeoutMs,
      "Host Connector child bootstrap",
    )
    if (startedIn !== era) return status
    return settle(started)
  }

  const terminate = (reason: "closed" | "revoked" | "error", detail: string) => {
    era++
    intentionalExit = true
    const target = child
    child = undefined
    if (target) {
      try {
        target.postMessage({ type: "stop", requestId: crypto.randomUUID() })
      } finally {
        target.kill()
      }
    }
    rejectPending(new Error(detail))
    settle({ status: "stopped", reason, detail })
  }

  return {
    status: () => status,
    async start() {
      if (child && status.status === "enrolled") return status
      starting ??= launch()
        .catch((error) => {
          if (child) {
            intentionalExit = true
            child.kill()
            child = undefined
          }
          input.onError?.("child-start", error)
          if (status.status === "stopped" && status.reason === "revoked") return status
          return settle({ status: "stopped", reason: "error", detail: String(error) })
        })
        .finally(() => {
          starting = undefined
        })
      return starting
    },
    stop() {
      terminate("closed", "connector closed")
    },
    revoke() {
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
