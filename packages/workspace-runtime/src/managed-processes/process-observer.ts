import { retirementSettled, type RetirementResult } from "@claxedo/agent-sdk-runtime/launch"
export type ProcessOwnerKind =
  | "runtime"
  | "sidecar"
  | "pty"
  | "managed-process"
  | "session-shell"
  | "mcp"
  | "harness"
  | "probe"
  | "cli"

export type ProcessOwnerRole = ProcessOwnerKind

export type ProcessOwnerCapabilities = {
  stopGracefully: boolean
  killOwnedTree: boolean
}

export type ProcessOwnerDescriptor = {
  ownerId: string
  ownerGeneration: string
  launchId: string
  kind: ProcessOwnerKind
  role: ProcessOwnerRole
  label: string
  pid?: number
  parentOwnerId?: string
  workspaceId?: string
  directory?: string
  sessionId?: string
  harnessId?: string
  access?: "local" | "remote"
  attributionConfidence?: "direct" | "inferred" | "not-process-backed"
}

/**
 * An owner operation answers with what it established. `undefined` means the
 * owner has no process-level evidence to offer at all, which is not the same as
 * success.
 */
export type ProcessOwnerOperations = {
  stopGracefully?: () => Promise<RetirementResult | undefined>
  killOwnedTree?: () => Promise<RetirementResult | undefined>
}

/**
 * What an owner operation reached. `unresolved` on its own says only that the
 * job is not finished; `retirement` says which half is unproven — a leader
 * still alive is a different problem for the operator than descendants nobody
 * can enumerate.
 */
export type ProcessOwnerInvocation = {
  result: "completed" | "unresolved" | "owner-unavailable" | "operation-unavailable"
  retirement?: Pick<RetirementResult, "leader" | "descendants">
}

export type ProcessOwnerExit = {
  reason: "exited" | "error" | "timeout" | "cancelled" | "disposed" | "detached"
  exitCode?: number
}

export type ProcessObserverEvent =
  | {
      type: "registered"
      at: number
      descriptor: ProcessOwnerDescriptor
      capabilities: ProcessOwnerCapabilities
    }
  | {
      type: "updated"
      at: number
      ownerId: string
      ownerGeneration: string
      pid?: number
      lifecycle: "starting" | "ready" | "detached"
    }
  | {
      type: "exited"
      at: number
      ownerId: string
      ownerGeneration: string
      reason: ProcessOwnerExit["reason"]
      exitCode?: number
      observedLifetimeMs: number
    }
  | {
      type: "ownership"
      at: number
      ownerId: string
      ownerGeneration: string
      state: ProcessOwnerOwnershipFault["state"]
      message: string
    }

export type ProcessObserverSink = (event: ProcessObserverEvent) => void

export type ProcessOwnerHandle = {
  update(input: { pid?: number; lifecycle: "starting" | "ready" | "detached" }): void
  exit(input: ProcessOwnerExit): void
  ownership(input: ProcessOwnerOwnershipFault): void
}

/**
 * The durable record of a running process could not be written. It is not
 * telemetry: `unrecorded` means nothing will ever find this process again, and
 * `persistence-unavailable` means the record still claims a launch that this
 * owner has already retired.
 */
export type ProcessOwnerOwnershipFault = {
  state: "unrecorded" | "persistence-unavailable"
  message: string
}

export type ProcessObserver = {
  register(descriptor: ProcessOwnerDescriptor, operations?: ProcessOwnerOperations): ProcessOwnerHandle
  update(input: {
    ownerId: string
    ownerGeneration: string
    pid?: number
    lifecycle: "starting" | "ready" | "detached"
  }): boolean
  exit(input: {
    ownerId: string
    ownerGeneration: string
    reason: ProcessOwnerExit["reason"]
    exitCode?: number
  }): boolean
  invoke(input: {
    ownerId: string
    ownerGeneration: string
    operation: "stop" | "kill"
  }): Promise<ProcessOwnerInvocation>
  detachWorkspace(workspaceId: string): number
  dispose(): void
}

export function createProcessObserver(input: {
  sink?: ProcessObserverSink
  now?: () => number
} = {}): ProcessObserver {
  const records = new Map<
    string,
    {
      descriptor: ProcessOwnerDescriptor
      operations: ProcessOwnerOperations
      registeredAt: number
      lifecycle: "starting" | "ready" | "detached"
    }
  >()
  const now = input.now ?? Date.now
  let disposed = false

  function publish(event: ProcessObserverEvent) {
    if (disposed) return
    try {
      input.sink?.(event)
    } catch {
      // Observation is optional and must never block the process owner.
    }
  }

  function update(event: {
    ownerId: string
    ownerGeneration: string
    pid?: number
    lifecycle: "starting" | "ready" | "detached"
  }) {
    const record = records.get(event.ownerId)
    if (!record || record.descriptor.ownerGeneration !== event.ownerGeneration) return false
    if (event.pid !== undefined && record.descriptor.pid !== undefined && event.pid !== record.descriptor.pid) return false
    if (event.lifecycle === record.lifecycle && (event.pid === undefined || event.pid === record.descriptor.pid)) {
      return true
    }
    if (event.pid !== undefined) record.descriptor = { ...record.descriptor, pid: event.pid }
    record.lifecycle = event.lifecycle
    if (event.lifecycle === "detached") record.operations = {}
    publish({ type: "updated", at: now(), ...event })
    return true
  }

  function exit(event: {
    ownerId: string
    ownerGeneration: string
    reason: ProcessOwnerExit["reason"]
    exitCode?: number
  }) {
    const record = records.get(event.ownerId)
    if (!record || record.descriptor.ownerGeneration !== event.ownerGeneration) return false
    records.delete(event.ownerId)
    const at = now()
    publish({
      type: "exited",
      at,
      ...event,
      observedLifetimeMs: Math.max(0, at - record.registeredAt),
    })
    return true
  }

  return {
    register(descriptor, operations = {}) {
      if (disposed) return { update: () => undefined, exit: () => undefined, ownership: () => undefined }
      const safe = safeDescriptor(descriptor)
      const registeredAt = now()
      records.set(safe.ownerId, { descriptor: safe, operations, registeredAt, lifecycle: "starting" })
      publish({
        type: "registered",
        at: registeredAt,
        descriptor: safe,
        capabilities: {
          stopGracefully: typeof operations.stopGracefully === "function",
          killOwnedTree: typeof operations.killOwnedTree === "function",
        },
      })
      return {
        update: (event) => {
          update({ ownerId: safe.ownerId, ownerGeneration: safe.ownerGeneration, ...event })
        },
        exit: (event) => {
          exit({ ownerId: safe.ownerId, ownerGeneration: safe.ownerGeneration, ...event })
        },
        ownership: (event) => {
          publish({
            type: "ownership",
            at: now(),
            ownerId: safe.ownerId,
            ownerGeneration: safe.ownerGeneration,
            state: event.state,
            message: safeText(event.message, 512),
          })
        },
      }
    },
    update,
    exit,
    async invoke(request) {
      const record = records.get(request.ownerId)
      if (!record || record.descriptor.ownerGeneration !== request.ownerGeneration) return { result: "owner-unavailable" }
      const operation =
        request.operation === "stop" ? record.operations.stopGracefully : record.operations.killOwnedTree
      if (!operation) return { result: "operation-unavailable" }
      const retirement = await operation()
      if (!retirement) return { result: "unresolved" }
      return {
        result: retirementSettled(retirement) ? "completed" : "unresolved",
        retirement: { leader: retirement.leader, descendants: retirement.descendants },
      }
    },
    detachWorkspace(workspaceId) {
      const matching = [...records.values()].filter(
        (record) => record.descriptor.workspaceId === workspaceId,
      )
      matching.forEach((record) => {
        update({
          ownerId: record.descriptor.ownerId,
          ownerGeneration: record.descriptor.ownerGeneration,
          ...(record.descriptor.pid ? { pid: record.descriptor.pid } : {}),
          lifecycle: "detached",
        })
      })
      return matching.length
    },
    dispose() {
      disposed = true
      records.clear()
    },
  }
}

function safeDescriptor(input: ProcessOwnerDescriptor): ProcessOwnerDescriptor {
  if (input.kind !== input.role) throw new Error("Process observer role must match its owner kind")
  return {
    ownerId: safeIdentifier(input.ownerId),
    ownerGeneration: safeIdentifier(input.ownerGeneration),
    launchId: safeIdentifier(input.launchId),
    kind: input.kind,
    role: input.role,
    label: safeLabel(input.label),
    ...(input.pid !== undefined ? { pid: requirePid(input.pid) } : {}),
    ...(input.parentOwnerId ? { parentOwnerId: safeIdentifier(input.parentOwnerId) } : {}),
    ...(input.workspaceId ? { workspaceId: safeIdentifier(input.workspaceId) } : {}),
    ...(input.directory ? { directory: safeText(input.directory, 4_096) } : {}),
    ...(input.sessionId ? { sessionId: safeIdentifier(input.sessionId) } : {}),
    ...(input.harnessId ? { harnessId: safeIdentifier(input.harnessId) } : {}),
    ...(input.access ? { access: input.access } : {}),
    ...(input.attributionConfidence ? { attributionConfidence: input.attributionConfidence } : {}),
  }
}

function safeIdentifier(value: string) {
  const result = sanitized(value)
  if (!result) throw new Error("Process observer identifiers must not be empty")
  if (result.length > 256) throw new Error("Process observer identifiers must not exceed 256 characters")
  return result
}

function safeLabel(value: string) {
  const result = sanitized(value).slice(0, 256)
  if (!result) throw new Error("Process observer labels must not be empty")
  return result
}

function safeText(value: string, max: number) {
  return sanitized(value).slice(0, max)
}

function sanitized(value: string) {
  return value.replaceAll(/[\u0000-\u001f\u007f]/g, " ").trim()
}

function requirePid(value: number) {
  if (!Number.isInteger(value) || value <= 0) throw new Error("Process observer PID must be a positive integer")
  return value
}
