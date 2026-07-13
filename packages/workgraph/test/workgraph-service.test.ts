import { describe, expect, it } from "vitest"
import type {
  ChangeCursor,
  CommandResult,
  OperationID,
  OwnerUserID,
  RequestID,
  StreamID,
  StreamLifecycleState,
  WorkGraphCommandRequest,
  WorkGraphContext,
} from "../src/contracts"
import { transitionStream } from "../src/domain/transitions"
import { createWorkGraphService } from "../src/application/workgraph-service"
import { defineAtomicWorkGraphStore, type WorkGraphCommandHandlers } from "../src/ports/store"
import type { WorkGraphCommandRequestOf } from "../src/ports/store"

const branded = <Type>(value: string) => value as Type

const ownerA = context("owner_a")
const ownerB = context("owner_b")

describe("WorkGraph application service", () => {
  it("returns the stored result for an exact retry without appending another event", async () => {
    const fixture = memoryStore()
    const service = createWorkGraphService(fixture.store)
    const request = createStream("operation_01", "Ship Cloud")

    const first = await service.execute(ownerA, request)
    const retry = await service.execute(ownerA, request)

    expect(first).toBe(retry)
    expect(first.ok).toBe(true)
    expect(fixture.eventCount()).toBe(1)
  })

  it("rejects reuse of an operation ID for a different command", async () => {
    const fixture = memoryStore()
    const service = createWorkGraphService(fixture.store)

    await service.execute(ownerA, createStream("operation_01", "Ship Cloud"))
    const conflict = await service.execute(ownerA, createStream("operation_01", "Different command"))

    expect(conflict).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } })
    expect(fixture.eventCount()).toBe(1)
  })

  it("does not append an event when an atomic transition is invalid", async () => {
    const fixture = memoryStore()
    const service = createWorkGraphService(fixture.store)
    const created = await service.execute(ownerA, createStream("operation_01", "Ship Cloud"))
    if (!created.ok) throw new Error("expected stream creation")

    const result = await service.execute(ownerA, {
      operationId: branded<OperationID>("operation_02"),
      command: {
        version: 1,
        type: "set_stream_lifecycle",
        streamId: branded<StreamID>(String((created.value as { streamId: string }).streamId)),
        expectedVersion: 0,
        state: "reopened",
        reason: "illegal from active",
      },
    } satisfies WorkGraphCommandRequestOf<"set_stream_lifecycle">)

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_transition" } })
    expect(fixture.eventCount()).toBe(1)
  })

  it("binds queries to trusted owner context", async () => {
    const fixture = memoryStore()
    const service = createWorkGraphService(fixture.store)
    const created = await service.execute(ownerA, createStream("operation_01", "Private stream"))
    if (!created.ok) throw new Error("expected stream creation")
    const streamId = branded<StreamID>(String((created.value as { streamId: string }).streamId))

    await expect(service.query(ownerA, "streams", "read", { streamId })).resolves.toMatchObject({ title: "Private stream" })
    await expect(service.query(ownerB, "streams", "read", { streamId })).resolves.toBeUndefined()
  })

  it("exposes the same typed query capabilities for embedded in-process consumers", async () => {
    const fixture = memoryStore()
    const service = createWorkGraphService(fixture.store)
    const created = await service.execute(ownerA, createStream("operation_01", "Embedded stream"))
    if (!created.ok) throw new Error("expected stream creation")
    const streamId = branded<StreamID>(String((created.value as { streamId: string }).streamId))

    expect(service.queries).toBe(fixture.store.queries)
    await expect(service.queries.streams.read(ownerA, { streamId })).resolves.toMatchObject({ title: "Embedded stream" })
  })
})

function memoryStore() {
  const events: string[] = []
  const operations = new Map<string, { fingerprint: string; result: CommandResult }>()
  const streams = new Map<string, { ownerUserId: OwnerUserID; title: string; state: StreamLifecycleState }>()

  const execute = async (context: WorkGraphContext, request: WorkGraphCommandRequest): Promise<CommandResult> => {
    const key = `${context.ownerUserId}:${request.operationId}`
    const fingerprint = JSON.stringify(request.command)
    const previous = operations.get(key)
    if (previous?.fingerprint === fingerprint) return previous.result
    if (previous) return failure(request.operationId, "idempotency_conflict", "Operation ID already used")

    if (request.command.type === "create_stream") {
      const streamId = branded<StreamID>(`stream_${streams.size + 1}`)
      streams.set(streamId, { ownerUserId: context.ownerUserId, title: request.command.title, state: "active" })
      events.push(`created:${streamId}`)
      const result = success(request.operationId, events.length, { streamId })
      operations.set(key, { fingerprint, result })
      return result
    }

    if (request.command.type === "set_stream_lifecycle") {
      const stream = streams.get(request.command.streamId)
      if (!stream || stream.ownerUserId !== context.ownerUserId) return failure(request.operationId, "not_found", "Stream not found")
      const transition = transitionStream(stream.state, request.command.state)
      if (!transition.ok) return failure(request.operationId, transition.error.code, "Invalid stream transition")
      stream.state = transition.state
      events.push(`transitioned:${request.command.streamId}`)
      const result = success(request.operationId, events.length, { streamId: request.command.streamId, state: stream.state })
      operations.set(key, { fingerprint, result })
      return result
    }

    return failure(request.operationId, "internal_error", "Unsupported test command")
  }

  const commands = {
    create_stream: execute,
    set_stream_lifecycle: execute,
  } satisfies Partial<WorkGraphCommandHandlers>

  return {
    store: defineAtomicWorkGraphStore({
      commands,
      queries: {
        streams: {
          read: async (context: WorkGraphContext, input: { streamId: StreamID }) => {
            const stream = streams.get(input.streamId)
            if (stream?.ownerUserId === context.ownerUserId) return stream
            return undefined
          },
        },
      },
    }),
    eventCount: () => events.length,
  }
}

function context(ownerUserId: string): WorkGraphContext {
  return {
    ownerUserId: branded<OwnerUserID>(ownerUserId),
    actor: { type: "user", id: branded(ownerUserId) },
    requestId: branded<RequestID>(`request_${ownerUserId}`),
    access: { mode: "owner" },
  }
}

function createStream(operationId: string, title: string): WorkGraphCommandRequestOf<"create_stream"> {
  return {
    operationId: branded<OperationID>(operationId),
    command: { version: 1, type: "create_stream", title },
  }
}

function success(operationId: OperationID, cursor: number, value: Record<string, string>): CommandResult {
  return { ok: true, operationId, cursor: branded<ChangeCursor>(String(cursor)), value }
}

function failure(operationId: OperationID, code: "idempotency_conflict" | "invalid_transition" | "not_found" | "internal_error", message: string): CommandResult {
  return { ok: false, operationId, error: { code, message, retryable: false } }
}
