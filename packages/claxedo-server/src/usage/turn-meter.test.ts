import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { describe, expect, test, vi } from "vitest"
import { messageCompleted, messageUpdated, sessionError, sessionUsage } from "@claxedo/agent-runtime-contract"
import type { AgentEventEnvelope } from "@claxedo/agent-runtime-contract"
import type { RuntimeUsageObservation } from "@claxedo/agent-runtime-contract"
import { buildAssistantMessage } from "@claxedo/agent-runtime-contract"
import type { TurnUsageRevision, UsageRevisionWriteResult } from "@claxedo/server-core/usage/contracts"
import { CLAXEDO_MIGRATION_JOURNAL } from "@claxedo/server-core/platform/db/journal"
import { createSqliteUsageLedger } from "@claxedo/server-core/usage/adapters/sqlite-usage-ledger"
import { createSqliteTurnMeterStateStore } from "@claxedo/server-core/usage/adapters/sqlite-turn-meter-state"
import { createTurnMeter } from "@claxedo/server-core/usage/turn-meter"

function harness() {
  const facts: TurnUsageRevision[] = []
  const writeRevision = vi.fn(async (fact: TurnUsageRevision): Promise<UsageRevisionWriteResult> => {
    facts.push(fact)
    return { status: "accepted" }
  })
  const meter = createTurnMeter({
    writer: { writeRevision },
    resolveContext: async ({ sessionId }) => ({
      sessionRef: `workspace:ws-1:session:${sessionId}`,
      workspaceId: "ws-1",
      hostId: "host-1",
      location: "cloud-workspace",
      harness: "codex-app-server",
    }),
    now: () => 9_000,
  })
  return { meter, facts, writeRevision }
}

function envelope(payload: AgentEventEnvelope["payload"]): AgentEventEnvelope {
  return { directory: "/private/path-must-not-persist", payload }
}

function assistant(input: { id?: string; completed?: number; error?: boolean; tokens?: Record<string, unknown> } = {}) {
  const row = buildAssistantMessage({
    id: input.id ?? "msg-1",
    sessionID: "session-1",
    parentID: "user-1",
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-5.4" },
    directory: "/private/path-must-not-persist",
    created: 100,
    ...(input.completed ? { completed: input.completed } : {}),
    ...(input.error ? { error: { name: "UnknownError", data: { message: "provider failed" } } } : {}),
  })
  return { ...row, ...(input.tokens ? { tokens: input.tokens } : {}) }
}

describe("turn usage meter", () => {
  test("keeps the canonical usage observation when compatibility message tokens settle the turn", async () => {
    const { meter, facts } = harness()
    await meter.consume(
      envelope(
        sessionUsage({
          sessionID: "session-1",
          messageID: "msg-1",
          contextSize: 100,
          contextUsed: 15,
          observation: {
            kind: "cumulative",
            providerObservationId: "obs-1",
            nativeSessionId: "provider-thread-1",
            observedAt: 1_000,
            tokens: { input: 10, output: 2, reasoning: null, cache: { read: 3, write: null } },
          },
        }),
      ),
    )
    await meter.consume(
      envelope(
        messageUpdated(
          assistant({
            completed: 2_000,
            tokens: { input: 10, output: 8, reasoning: 1, cache: { read: 3, write: 0 } },
          }) as never,
        ),
      ),
    )
    await meter.consume(envelope(messageCompleted("session-1", "msg-1")))

    expect(facts).toHaveLength(2)
    expect(facts[0]).toMatchObject({ revision: 1, settlement: "provisional", status: "running" })
    expect(facts[1]).toMatchObject({
      revision: 2,
      settlement: "final",
      status: "completed",
      providerId: "openai",
      modelId: "gpt-5.4",
      nativeSessionId: "provider-thread-1",
      tokens: { input: 10, output: 2, reasoning: null, cache: { read: 3, write: null } },
      quality: {
        source: "provider",
        observationKind: "cumulative",
        providerObservationId: "obs-1",
        knownCategories: ["input", "output", "cache_read"],
      },
    })
  })

  test("uses compatibility message tokens only when no canonical usage observation arrived", async () => {
    const { meter, facts } = harness()
    await meter.consume(
      envelope(
        messageUpdated(
          assistant({
            completed: 2_000,
            tokens: { input: 4, output: 3, reasoning: 0, cache: { read: 1, write: 0 } },
          }) as never,
        ),
      ),
    )

    expect(facts.at(-1)).toMatchObject({
      settlement: "final",
      tokens: { input: 4, output: 3, reasoning: 0, cache: { read: 1, write: 0 } },
      quality: { source: "provider-message" },
    })
  })

  test("retains provider tokens that arrive before the assistant completion timestamp", async () => {
    const { meter, facts } = harness()
    await meter.consume(
      envelope(
        messageUpdated(
          assistant({
            tokens: { input: 7, output: 5, reasoning: 2, cache: { read: 11, write: 3 } },
          }) as never,
        ),
      ),
    )
    await meter.consume(envelope(messageCompleted("session-1", "msg-1")))

    expect(facts).toHaveLength(2)
    expect(facts[0]).toMatchObject({ settlement: "provisional", status: "running" })
    expect(facts[1]).toMatchObject({
      settlement: "final",
      status: "completed",
      tokens: { input: 7, output: 5, reasoning: 2, cache: { read: 11, write: 3 } },
      quality: { source: "provider-message" },
    })
  })

  test("replaces cumulative observations and adds delta observations without fabricating unknown categories", async () => {
    const { meter, facts } = harness()
    const usage = (id: string, kind: "cumulative" | "delta", input: number | null, output: number | null) =>
      envelope(
        sessionUsage({
          sessionID: "session-1",
          messageID: "msg-1",
          contextSize: 100,
          contextUsed: 1,
          observation: {
            kind,
            providerObservationId: id,
            tokens: { input, output, reasoning: null, cache: { read: null, write: null } },
          },
        }),
      )
    await meter.consume(usage("1", "cumulative", 10, 1))
    // A provider turn/run id identifies the stream, not one immutable usage
    // snapshot. A larger cumulative update with the same id must replace it.
    await meter.consume(usage("1", "cumulative", 12, 4))
    await meter.consume(usage("3", "delta", null, 2))
    expect(facts.map((fact) => fact.tokens)).toEqual([
      { input: 10, output: 1, reasoning: null, cache: { read: null, write: null } },
      { input: 12, output: 4, reasoning: null, cache: { read: null, write: null } },
      { input: 12, output: 6, reasoning: null, cache: { read: null, write: null } },
    ])
  })

  test("sums each scope's usage, and a cumulative replaces only its own scope", async () => {
    const { meter, facts } = harness()
    const usage = (scope: string | undefined, kind: "cumulative" | "delta", id: string, input: number, output: number) =>
      envelope(
        sessionUsage({
          sessionID: "session-1",
          messageID: "msg-1",
          contextSize: 100,
          contextUsed: 1,
          observation: {
            kind,
            ...(scope === undefined ? {} : { scope }),
            providerObservationId: id,
            tokens: { input, output, reasoning: null, cache: { read: null, write: null } },
          },
        }),
      )
    await meter.consume(usage(undefined, "cumulative", "own", 10, 1))
    await meter.consume(usage("thread-2:turn-1", "cumulative", "turn-1", 100, 10))
    await meter.consume(usage("thread-2:turn-2", "cumulative", "turn-2", 1_000, 100))
    await meter.consume(usage("thread-2:turn-1", "cumulative", "turn-1", 200, 20))
    await meter.consume(usage("child:a", "delta", "same-id", 5, 0))
    await meter.consume(usage("child:b", "delta", "same-id", 7, 0))
    await meter.consume(usage("child:b", "delta", "same-id", 7, 0))

    expect(facts.map((fact) => [fact.tokens.input, fact.tokens.output])).toEqual([
      [10, 1],
      [110, 11],
      [1_110, 111],
      [1_210, 121],
      [1_215, 121],
      [1_222, 121],
    ])
  })

  test("a provider observation supersedes tokens read off an assistant message before it", async () => {
    const { meter, facts } = harness()
    await meter.consume(envelope(messageUpdated(assistant({ tokens: { input: 50, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } }) as never)))
    await meter.consume(
      envelope(
        sessionUsage({
          sessionID: "session-1",
          messageID: "msg-1",
          contextSize: 100,
          contextUsed: 1,
          observation: {
            kind: "delta",
            providerObservationId: "step-1",
            tokens: { input: 3, output: 2, reasoning: null, cache: { read: null, write: null } },
          },
        }),
      ),
    )

    expect(facts.at(-1)?.tokens).toEqual({ input: 3, output: 2, reasoning: null, cache: { read: null, write: null } })
  })

  test("adds one-hour cache writes across deltas and takes a cumulative's split as reported", async () => {
    const { meter, facts } = harness()
    const usage = (id: string, kind: "cumulative" | "delta", write: number, write1h?: number) =>
      envelope(
        sessionUsage({
          sessionID: "session-1",
          messageID: "msg-1",
          contextSize: 100,
          contextUsed: 1,
          observation: {
            kind,
            providerObservationId: id,
            tokens: {
              input: 1,
              output: 1,
              reasoning: null,
              cache: { read: null, write, ...(write1h === undefined ? {} : { write1h }) },
            },
          },
        }),
      )
    await meter.consume(usage("1", "delta", 100, 70))
    await meter.consume(usage("2", "delta", 50))
    await meter.consume(usage("3", "delta", 10, 10))
    await meter.consume(usage("4", "cumulative", 400, 300))
    expect(facts.map((fact) => fact.tokens.cache)).toEqual([
      { read: null, write: 100, write1h: 70 },
      { read: null, write: 150, write1h: 70 },
      { read: null, write: 160, write1h: 80 },
      { read: null, write: 400, write1h: 300 },
    ])
  })

  test("usage that lands on a finished turn does not make it the turn a later session error settles", async () => {
    const { meter, facts } = harness()
    const usage = (scope: string, input: number) =>
      envelope(
        sessionUsage({
          sessionID: "session-1",
          messageID: "msg-1",
          contextSize: 100,
          contextUsed: 1,
          observation: {
            kind: "cumulative",
            scope,
            tokens: { input, output: 1, reasoning: null, cache: { read: null, write: null } },
          },
        }),
      )
    await meter.consume(usage("own", 10))
    await meter.consume(envelope(messageUpdated(assistant({ completed: 2_000 }) as never)))
    await meter.consume(usage("title:thread-t", 3))
    await meter.consume(envelope(sessionError("next turn failed before it began", "session-1")))

    expect(facts.at(-1)).toMatchObject({ messageId: "msg-1", status: "completed", settlement: "final", tokens: { input: 13 } })
    expect(facts.some((fact) => fact.status === "error")).toBe(false)
  })

  test("usage that lands on a finished turn leaves a running turn the one a session error settles", async () => {
    const { meter, facts } = harness()
    const usage = (messageID: string, scope: string, input: number) =>
      envelope(
        sessionUsage({
          sessionID: "session-1",
          messageID,
          contextSize: 100,
          contextUsed: 1,
          observation: {
            kind: "cumulative",
            scope,
            tokens: { input, output: 1, reasoning: null, cache: { read: null, write: null } },
          },
        }),
      )
    await meter.consume(usage("msg-1", "own", 10))
    await meter.consume(envelope(messageUpdated(assistant({ completed: 2_000 }) as never)))
    await meter.consume(envelope(messageUpdated(assistant({ id: "msg-2" }) as never)))
    await meter.consume(usage("msg-2", "own", 20))
    await meter.consume(usage("msg-1", "title:thread-t", 3))
    await meter.consume(envelope(sessionError("second turn failed", "session-1")))

    expect(facts.filter((fact) => fact.messageId === "msg-1").at(-1)).toMatchObject({ status: "completed", tokens: { input: 13 } })
    expect(facts.filter((fact) => fact.messageId === "msg-2").at(-1)).toMatchObject({ status: "error", settlement: "final" })
  })

  test("provider error settles known usage and terminal-without-usage is unavailable", async () => {
    const known = harness()
    await known.meter.consume(
      envelope(
        sessionUsage({
          sessionID: "session-1",
          messageID: "msg-1",
          contextSize: 100,
          contextUsed: 1,
          observation: {
            kind: "cumulative",
            tokens: { input: 1, output: 2, reasoning: null, cache: { read: null, write: null } },
          },
        }),
      ),
    )
    await known.meter.consume(envelope(sessionError("boom", "session-1")))
    expect(known.facts.at(-1)).toMatchObject({ settlement: "final", status: "error", revision: 2 })

    const missing = harness()
    await missing.meter.consume(envelope(messageUpdated(assistant() as never)))
    await missing.meter.consume(envelope(messageCompleted("session-1", "msg-1")))
    expect(missing.facts.at(-1)).toMatchObject({
      settlement: "unavailable",
      status: "completed",
      tokens: { input: null, output: null, reasoning: null, cache: { read: null, write: null } },
    })
  })

  test("durable stop, steer, and process-loss outcomes settle partial or unavailable", async () => {
    const partial = harness()
    await partial.meter.consume(
      envelope(
        sessionUsage({
          sessionID: "session-1",
          messageID: "msg-1",
          contextSize: 100,
          contextUsed: 1,
          observation: {
            kind: "cumulative",
            tokens: { input: 1, output: 2, reasoning: null, cache: { read: null, write: null } },
          },
        }),
      ),
    )
    await partial.meter.settle({ sessionId: "session-1", messageId: "msg-1", status: "stopped" })
    expect(partial.facts.at(-1)).toMatchObject({ settlement: "partial", status: "stopped" })

    const steered = harness()
    await steered.meter.consume(
      envelope(
        sessionUsage({
          sessionID: "session-1",
          messageID: "msg-1",
          contextSize: 100,
          contextUsed: 1,
          observation: {
            kind: "cumulative",
            tokens: { input: 3, output: 1, reasoning: null, cache: { read: null, write: null } },
          },
        }),
      ),
    )
    await steered.meter.settle({ sessionId: "session-1", messageId: "msg-1", status: "interrupted_by_steer" })
    expect(steered.facts.at(-1)).toMatchObject({ settlement: "partial", status: "interrupted_by_steer" })

    const unavailable = harness()
    await unavailable.meter.settle({ sessionId: "session-1", messageId: "msg-lost", status: "process_lost" })
    expect(unavailable.facts.at(-1)).toMatchObject({ settlement: "unavailable", status: "process_lost" })
  })

  test("deduplicates a replayed provider observation and stores only the minimal fact", async () => {
    const { meter, facts } = harness()
    const event = envelope(
      sessionUsage({
        sessionID: "session-1",
        messageID: "msg-1",
        contextSize: 100,
        contextUsed: 1,
        observation: {
          kind: "cumulative",
          providerObservationId: "same",
          tokens: { input: 1, output: 2, reasoning: null, cache: { read: null, write: null } },
        },
      }),
    )
    await meter.consume(event)
    await meter.consume(event)
    expect(facts).toHaveLength(1)
    expect(JSON.stringify(facts[0])).not.toContain("private/path")
  })

  test("reports a same-revision conflict without silently promoting divergent data", async () => {
    const onDegraded = vi.fn()
    const writeRevision = vi.fn(async () => ({ status: "conflict" as const, currentRevision: 1 }))
    const meter = createTurnMeter({
      writer: { writeRevision },
      resolveContext: async () => ({
        sessionRef: "workspace:ws-1:session:session-1",
        workspaceId: "ws-1",
        hostId: "host-1",
        location: "local",
        harness: "claude-sdk",
      }),
      onDegraded,
    })

    await meter.consume(envelope(messageCompleted("session-1", "msg-1")))

    expect(writeRevision).toHaveBeenCalledTimes(1)
    expect(onDegraded).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("conflicts") }),
      expect.objectContaining({ revision: 1 }),
    )
  })

  test("deduplicates a persisted delta observation after restart", async () => {
    const writes: TurnUsageRevision[] = []
    const current = revisionForRecovery("msg-1", {
      input: 4,
      output: 2,
      reasoning: null,
      cache: { read: null, write: null },
    })
    current.quality.providerObservationId = "delta-1"
    current.quality.observationKind = "delta"
    const meter = createTurnMeter({
      writer: {
        writeRevision: async (fact) => {
          writes.push(fact)
          return { status: "accepted" }
        },
      },
      reader: { current: async () => [current] },
      resolveContext: async () => ({
        sessionRef: current.sessionRef,
        workspaceId: "ws-1",
        hostId: "host-1",
        location: "local",
        harness: "claude-sdk",
      }),
    })

    await meter.consume(
      envelope(
        sessionUsage({
          sessionID: "session-1",
          messageID: "msg-1",
          contextSize: 100,
          contextUsed: 1,
          observation: {
            kind: "delta",
            providerObservationId: "delta-1",
            tokens: { input: 4, output: 2, reasoning: null, cache: { read: null, write: null } },
          },
        }),
      ),
    )

    expect(writes).toEqual([])
  })

  test("recovers a terminal unavailable turn when authoritative usage arrives late", async () => {
    const { meter, facts } = harness()
    await meter.consume(envelope(messageCompleted("session-1", "msg-1")))
    await meter.consume(
      envelope(
        sessionUsage({
          sessionID: "session-1",
          messageID: "msg-1",
          contextSize: 100,
          contextUsed: 1,
          observation: {
            kind: "cumulative",
            providerObservationId: "late-final",
            tokens: { input: 8, output: 3, reasoning: null, cache: { read: 2, write: null } },
          },
        }),
      ),
    )

    expect(facts).toHaveLength(2)
    expect(facts[0]).toMatchObject({ settlement: "unavailable", status: "completed" })
    expect(facts[1]).toMatchObject({
      revision: 2,
      settlement: "recovered",
      status: "completed",
      tokens: { input: 8, output: 3, cache: { read: 2 } },
    })
  })

  test("startup reconciliation settles orphaned lifecycle and usage revisions", async () => {
    const recovered: TurnUsageRevision[] = []
    const currentReader = vi.fn(async () => current)
    const current = [
      revisionForRecovery("msg-partial", {
        input: 4,
        output: 2,
        reasoning: null,
        cache: { read: null, write: null },
      }),
      revisionForRecovery("msg-unavailable"),
    ]
    const meter = createTurnMeter({
      writer: {
        writeRevision: async (fact) => {
          recovered.push(structuredClone(fact))
          return { status: "accepted" }
        },
      },
      reader: {
        current: currentReader,
      },
      resolveContext: async () => {
        throw new Error("session metadata was already removed")
      },
      reconcileProvisionalOnStart: true,
      now: () => 3_000,
    })
    await meter.start()
    expect(currentReader).toHaveBeenCalledWith({ settlement: "provisional" })
    expect(recovered).toEqual([
      expect.objectContaining({ messageId: "msg-partial", revision: 2, settlement: "partial", status: "process_lost" }),
      expect.objectContaining({
        messageId: "msg-unavailable",
        revision: 2,
        settlement: "unavailable",
        status: "process_lost",
      }),
    ])
  })

  test("deduplicates the exact persisted cumulative observation after bounded restart", async () => {
    const writes: TurnUsageRevision[] = []
    const tokens = { input: 4, output: 2, reasoning: null, cache: { read: null, write: null } }
    const current = revisionForRecovery("msg-1", tokens)
    current.revision = 2
    current.settlement = "partial"
    current.status = "process_lost"
    current.completedAt = 2_000
    current.nativeSessionId = "native-1"
    current.quality.observationKind = "cumulative"
    current.quality.providerObservationId = "cumulative-1"
    current.quality.providerObservationKey = JSON.stringify({
      kind: "cumulative",
      sequence: null,
      providerObservationId: "cumulative-1",
      nativeSessionId: "native-1",
      observedAt: 1_000,
      tokens,
    })
    const meter = createTurnMeter({
      writer: {
        writeRevision: async (fact) => {
          writes.push(fact)
          return { status: "accepted" }
        },
      },
      reader: {
        current: async (filter) => (filter?.settlement === "provisional" ? [] : [current]),
      },
      resolveContext: async () => {
        throw new Error("settled fact owns its context")
      },
      reconcileProvisionalOnStart: true,
    })

    await meter.consume(
      envelope(
        sessionUsage({
          sessionID: "session-1",
          messageID: "msg-1",
          contextSize: 100,
          contextUsed: 1,
          observation: {
            kind: "cumulative",
            providerObservationId: "cumulative-1",
            nativeSessionId: "native-1",
            observedAt: 1_000,
            tokens,
          },
        }),
      ),
    )

    expect(writes).toEqual([])
  })

  test("hydrates a settled turn on demand after bounded startup recovery", async () => {
    const writes: TurnUsageRevision[] = []
    const settled = revisionForRecovery("msg-1")
    settled.revision = 2
    settled.settlement = "unavailable"
    settled.status = "completed"
    settled.completedAt = 2_000
    const current = vi.fn(async (filter?: { settlement?: string; messageId?: string }) =>
      filter?.settlement === "provisional" ? [] : filter?.messageId === "msg-1" ? [settled] : [],
    )
    const meter = createTurnMeter({
      writer: {
        writeRevision: async (fact) => {
          writes.push(structuredClone(fact))
          return { status: "accepted" }
        },
      },
      reader: { current },
      resolveContext: async () => ({
        sessionRef: settled.sessionRef,
        workspaceId: "ws-1",
        hostId: "host-1",
        location: "local",
        harness: "claude-sdk",
      }),
      reconcileProvisionalOnStart: true,
      now: () => 3_000,
    })

    await meter.consume(
      envelope(
        sessionUsage({
          sessionID: "session-1",
          messageID: "msg-1",
          contextSize: 100,
          contextUsed: 1,
          observation: {
            kind: "cumulative",
            providerObservationId: "late-final",
            tokens: { input: 8, output: 3, reasoning: null, cache: { read: 2, write: null } },
          },
        }),
      ),
    )

    expect(current).toHaveBeenNthCalledWith(1, { settlement: "provisional" })
    expect(current).toHaveBeenNthCalledWith(2, {
      sessionId: "session-1",
      messageId: "msg-1",
    })
    expect(writes).toEqual([
      expect.objectContaining({
        revision: 3,
        settlement: "recovered",
        status: "completed",
        tokens: { input: 8, output: 3, reasoning: null, cache: { read: 2, write: null } },
      }),
    ])
  })
})

function revisionForRecovery(
  messageId: string,
  tokens: TurnUsageRevision["tokens"] = {
    input: null,
    output: null,
    reasoning: null,
    cache: { read: null, write: null },
  },
): TurnUsageRevision {
  const known = [tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write].some(
    (value) => value !== null,
  )
  return {
    sessionRef: `workspace:ws-1:session:session-1`,
    sessionId: "session-1",
    messageId,
    revision: 1,
    observedAt: 1_000,
    settlement: "provisional",
    status: "running",
    location: "local",
    harness: "claude-sdk",
    providerId: "anthropic",
    modelId: "claude-sonnet-5",
    workspaceId: "ws-1",
    hostId: "host-1",
    tokens,
    quality: {
      source: known ? "provider" : "lifecycle",
      knownCategories: known ? ["input", "output"] : [],
    },
  }
}

/**
 * One machine's usage database, and a meter over it the way the local
 * compositions build one. `restart` is a new process on the same file.
 */
function machine(input: { harness: string; state?: boolean; nativeSessionId?: string; modelId?: string }) {
  const sqlite = new Database(":memory:")
  for (const name of readdirSync(CLAXEDO_MIGRATION_JOURNAL).toSorted()) {
    const file = path.join(CLAXEDO_MIGRATION_JOURNAL, name, "migration.sql")
    if (existsSync(file)) sqlite.exec(readFileSync(file, "utf8"))
  }
  const db = drizzle({ client: sqlite })
  const database = {
    use: <T>(callback: (client: typeof db) => T) => callback(db),
    transaction: <T>(callback: (client: typeof db) => T) =>
      (db.transaction as unknown as (run: (client: typeof db) => T) => T)(callback),
  }
  const ledger = createSqliteUsageLedger({ database: database as never })
  const facts: TurnUsageRevision[] = []
  const degraded: unknown[] = []
  const writes = { failing: false }
  const boot = () => {
    const meter = createTurnMeter({
      writer: {
        writeRevision: async (fact, options) => {
          if (writes.failing) throw new Error("usage database is busy")
          facts.push(structuredClone(fact))
          return await ledger.writeRevision(fact, options)
        },
      },
      reader: ledger,
      ...(input.state === false ? {} : { state: createSqliteTurnMeterStateStore({ database: database as never }) }),
      reconcileProvisionalOnStart: true,
      resolveContext: async ({ sessionId }) => ({
        sessionRef: `local:/work:session:${sessionId}`,
        workspaceId: "ws-1",
        hostId: "host-1",
        location: "local",
        harness: input.harness,
        providerId: "provider",
        modelId: input.modelId ?? "configured",
        ...(input.nativeSessionId ? { nativeSessionId: input.nativeSessionId } : {}),
      }),
      onDegraded: (error) => degraded.push(error),
      now: () => 5_000,
    })
    void meter.start()
    return meter
  }
  return { facts, degraded, boot, writes }
}

function observed(observation: RuntimeUsageObservation) {
  return envelope(sessionUsage({ sessionID: "s1", messageID: "m1", contextSize: 1, contextUsed: 1, observation }))
}

const inputTokens = (input: number) => ({ input, output: 0, reasoning: null, cache: { read: null, write: null } })

describe("turn usage meter across a restart", () => {
  test("a replayed scoped cumulative replaces its own scope rather than adding to the restored sum", async () => {
    const box = machine({ harness: "codex-app-server" })
    const turn = (input: number) => observed({
      kind: "cumulative",
      scope: "thread-1:turn-1",
      providerObservationId: "turn-1",
      nativeSessionId: "thread-1",
      tokens: inputTokens(input),
    })
    await box.boot().consume(turn(100))
    const restarted = box.boot()
    await restarted.consume(turn(100))
    await restarted.consume(turn(150))

    expect(box.facts.map((fact) => [fact.status, fact.tokens.input])).toEqual([
      ["running", 100],
      ["process_lost", 100],
      ["process_lost", 150],
    ])
    expect(box.degraded).toEqual([])
  })

  test("a scoped delta replayed onto a settled turn is not counted twice", async () => {
    const box = machine({ harness: "claude" })
    const delta = observed({ kind: "delta", scope: "child:a", providerObservationId: "req-1", tokens: inputTokens(40) })
    const first = box.boot()
    await first.consume(delta)
    await first.consume(envelope(messageCompleted("s1", "m1")))
    await box.boot().consume(delta)

    expect(box.facts.map((fact) => [fact.settlement, fact.tokens.input])).toEqual([
      ["provisional", 40],
      ["final", 40],
    ])
  })

  test("the turn's own cumulative replaces only its own stream beside a restored subagent's", async () => {
    const box = machine({ harness: "claude" })
    const first = box.boot()
    await first.consume(observed({ kind: "cumulative", tokens: inputTokens(60) }))
    await first.consume(observed({ kind: "cumulative", scope: "toolu_sub", tokens: inputTokens(40) }))
    await box.boot().consume(observed({ kind: "cumulative", tokens: inputTokens(70) }))

    expect(box.facts.at(-1)?.tokens.input).toBe(110)
  })

  test("an observation whose revision never landed still counts after a restart", async () => {
    const box = machine({ harness: "claude" })
    const first = box.boot()
    await first.consume(envelope(messageUpdated(buildAssistantMessage({
      id: "m1",
      sessionID: "s1",
      parentID: "u1",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude" },
      directory: "/w",
      created: 1,
    }) as never)))
    box.writes.failing = true
    await first.consume(observed({ kind: "cumulative", tokens: inputTokens(60) }))
    box.writes.failing = false
    await box.boot().consume(observed({ kind: "cumulative", scope: "toolu_sub", tokens: inputTokens(40) }))

    expect(box.degraded).toHaveLength(1)
    expect(box.facts.map((fact) => [fact.status, fact.tokens.input])).toEqual([
      ["running", null],
      ["process_lost", 60],
      ["process_lost", 100],
    ])
  })

  test("without a state store a restored turn keeps metering from its stored sum", async () => {
    const box = machine({ harness: "claude", state: false })
    await box.boot().consume(observed({ kind: "delta", providerObservationId: "req-1", tokens: inputTokens(40) }))
    const restarted = box.boot()
    await restarted.consume(observed({ kind: "delta", providerObservationId: "req-1", tokens: inputTokens(40) }))
    await restarted.consume(observed({ kind: "delta", providerObservationId: "req-2", tokens: inputTokens(5) }))

    expect(box.facts.map((fact) => fact.tokens.input)).toEqual([40, 40, 45])
  })
})

describe("turn usage meter attribution", () => {
  test("names the thread of the turn's first observation, not a later child's", async () => {
    const box = machine({ harness: "codex-app-server" })
    const meter = box.boot()
    await meter.consume(observed({ kind: "cumulative", scope: "parent:t1", nativeSessionId: "parent", tokens: inputTokens(10) }))
    await meter.consume(observed({ kind: "cumulative", scope: "child:t1", nativeSessionId: "child", tokens: inputTokens(5) }))

    expect(box.facts.map((fact) => fact.nativeSessionId)).toEqual(["parent", "parent"])
  })

  test("a thread the composition names outranks any observation's", async () => {
    const box = machine({ harness: "pi", nativeSessionId: "s1" })
    await box.boot().consume(observed({ kind: "delta", nativeSessionId: "provider-side", tokens: inputTokens(1) }))

    expect(box.facts.at(-1)?.nativeSessionId).toBe("s1")
  })

  test("files the turn under the model the provider served, not the configured alias", async () => {
    const box = machine({ harness: "claude", modelId: "opus[1m]" })
    const meter = box.boot()
    await meter.consume(envelope(messageUpdated(buildAssistantMessage({
      id: "m1",
      sessionID: "s1",
      parentID: "u1",
      agent: "build",
      model: { providerID: "anthropic", modelID: "opus[1m]" },
      directory: "/w",
      created: 1,
    }) as never)))
    await meter.consume(observed({ kind: "cumulative", model: "claude-opus-4-5-20251101", tokens: inputTokens(10) }))
    await meter.consume(envelope(messageUpdated(buildAssistantMessage({
      id: "m1",
      sessionID: "s1",
      parentID: "u1",
      agent: "build",
      model: { providerID: "anthropic", modelID: "opus[1m]" },
      directory: "/w",
      created: 1,
      completed: 2,
    }) as never)))

    expect(box.facts.map((fact) => fact.modelId)).toEqual(["opus[1m]", "claude-opus-4-5-20251101", "claude-opus-4-5-20251101"])
  })

  test("holds each scope's one-hour writes within that scope's writes", async () => {
    const box = machine({ harness: "claude" })
    const meter = box.boot()
    const cache = (write: number | null, write1h: number) => ({ input: 1, output: 1, reasoning: null, cache: { read: null, write, write1h } })
    await meter.consume(observed({ kind: "cumulative", scope: "a", tokens: cache(10, 10) }))
    await meter.consume(observed({ kind: "cumulative", scope: "b", tokens: cache(null, 5) }))
    await meter.consume(observed({ kind: "cumulative", scope: "c", tokens: cache(4, 9) }))

    expect(box.degraded).toEqual([])
    expect(box.facts.map((fact) => fact.tokens.cache)).toEqual([
      { read: null, write: 10, write1h: 10 },
      { read: null, write: 10, write1h: 10 },
      { read: null, write: 14, write1h: 14 },
    ])
  })
})
