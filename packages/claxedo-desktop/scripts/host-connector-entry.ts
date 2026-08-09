import { createHostConnector, type ConnectorTransport } from "@claxedo/host-connector/connector"
import { createHostKeyPair, hostKeyPairFromJwk } from "@claxedo/host-connector/host-identity"

import {
  HOST_ENROLLMENT_OPERATIONS,
  parseHostConnectorParentMessage,
  type HostConnectorBootstrapIdentity,
  type HostConnectorChildMessage,
  type HostConnectorParentMessage,
  type HostEnrollmentOperation,
} from "../src/main/host-connector/child-protocol"

type ChildPort = {
  postMessage(message: HostConnectorChildMessage): void
  onMessage(listener: (message: unknown) => void): void
}

type Pending<T> = {
  resolve(value: T): void
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

function requireString(value: unknown, field: string, operation: string): string {
  if (typeof value !== "string" || !value) throw new Error(`operation "${operation}" returned no ${field}`)
  return value
}

function requireNumber(value: unknown, field: string, operation: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`operation "${operation}" returned no ${field}`)
  }
  return value
}

function newHostId(): string {
  return `host_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`
}

/**
 * Run the connector against a private parent port.
 *
 * Exported so the boot test can exercise the real entry without launching an
 * Electron process. The executable path below adapts Electron's parentPort to
 * this same interface; there is no second runtime implementation.
 */
export function runHostConnectorChild(port: ChildPort) {
  const account = new Map<string, Pending<unknown>>()
  const identityStored = new Map<string, Pending<void>>()
  let connector: ReturnType<typeof createHostConnector> | undefined
  let bootstrapped = false

  const send = (message: HostConnectorChildMessage) => port.postMessage(message)
  const requestAccountOperation = (
    name: HostEnrollmentOperation,
    input?: Record<string, unknown>,
  ): Promise<unknown> => {
    const requestId = crypto.randomUUID()
    const pending = deferred<unknown>()
    account.set(requestId, pending)
    send({ type: "account-operation", requestId, name, ...(input ? { input } : {}) })
    return pending.promise.finally(() => account.delete(requestId))
  }

  const transport: ConnectorTransport = {
    createRequest: async ({ hostId }) => {
      const name = HOST_ENROLLMENT_OPERATIONS.createRequest
      const value = (await requestAccountOperation(name, { hostId })) as Record<string, unknown> | undefined
      return {
        request_id: requireString(value?.request_id, "request_id", name),
        nonce: requireString(value?.nonce, "nonce", name),
        expires_at: requireNumber(value?.expires_at, "expires_at", name),
      }
    },
    enroll: async (input) => {
      const name = HOST_ENROLLMENT_OPERATIONS.enroll
      const value = (await requestAccountOperation(name, { ...input })) as
        | { enrollment?: Record<string, unknown> }
        | undefined
      const enrollment = value?.enrollment
      return {
        enrollment_id: requireString(enrollment?.enrollment_id, "enrollment_id", name),
        host_id: requireString(enrollment?.host_id, "host_id", name),
        expires_at: requireNumber(enrollment?.expires_at, "expires_at", name),
      }
    },
    heartbeat: async (input) => {
      const name = HOST_ENROLLMENT_OPERATIONS.heartbeat
      const value = (await requestAccountOperation(name, { ...input })) as Record<string, unknown> | undefined
      return { expires_at: requireNumber(value?.expires_at, "expires_at", name) }
    },
  }

  const createIdentity = async (requestId: string) => {
    const created = await createHostKeyPair()
    const { privateKeyJwk, ...keys } = created
    const identity: HostConnectorBootstrapIdentity = {
      hostId: newHostId(),
      privateKeyJwk,
    }
    const stored = deferred<void>()
    identityStored.set(requestId, stored)
    send({ type: "identity-created", requestId, identity })
    await stored.promise.finally(() => identityStored.delete(requestId))
    return { identity, keys }
  }

  const bootstrap = async (message: Extract<HostConnectorParentMessage, { type: "bootstrap" }>) => {
    if (bootstrapped) throw new Error("Host Connector child has already been bootstrapped")
    bootstrapped = true

    const restored = message.identity
      ? { identity: message.identity, keys: await hostKeyPairFromJwk(message.identity.privateKeyJwk) }
      : await createIdentity(message.requestId)

    connector = createHostConnector({
      hostId: restored.identity.hostId,
      keys: restored.keys,
      transport,
      heartbeatIntervalMs: message.heartbeatIntervalMs,
      setInterval: (fn, ms) => {
        const handle = setInterval(fn, ms)
        handle.unref?.()
        return { cancel: () => clearInterval(handle) }
      },
      ...(message.displayName ? { displayName: message.displayName } : {}),
      onError: () => {
        // `createHostConnector` settles its stopped state immediately after
        // invoking this callback. Announce after that synchronous transition.
        queueMicrotask(() => {
          if (connector) send({ type: "status", status: connector.state() })
        })
      },
    })
    const status = await connector.start()
    send({ type: "status", status })
    return status
  }

  const onMessage = async (value: unknown) => {
    const message = parseHostConnectorParentMessage(value)
    if (!message) return

    if (message.type === "account-result") {
      const pending = account.get(message.requestId)
      if (!pending) return
      if (message.ok) pending.resolve(message.value)
      else pending.reject(new Error(message.error))
      return
    }

    if (message.type === "identity-stored") {
      identityStored.get(message.requestId)?.resolve()
      return
    }

    if (message.type === "stop") {
      connector?.close()
      const status = connector?.state() ?? { status: "stopped" as const, reason: "closed" as const, detail: "connector closed" }
      send({ type: "status", status })
      send({ type: "response", requestId: message.requestId, ok: true, status })
      return
    }

    try {
      const status = await bootstrap(message)
      send({ type: "response", requestId: message.requestId, ok: true, status })
    } catch (error) {
      send({ type: "response", requestId: message.requestId, ok: false, error: String(error) })
    }
  }

  port.onMessage((message) => {
    void onMessage(message)
  })
  send({ type: "ready" })

  return {
    close() {
      connector?.close()
      for (const pending of account.values()) pending.reject(new Error("Host Connector child closed"))
      for (const pending of identityStored.values()) pending.reject(new Error("Host Connector child closed"))
      account.clear()
      identityStored.clear()
    },
  }
}

if (process.parentPort) {
  runHostConnectorChild({
    postMessage: (message) => process.parentPort!.postMessage(message),
    onMessage: (listener) => {
      process.parentPort!.on("message", (event) => listener(event.data))
    },
  })
}
