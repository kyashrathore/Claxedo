import { describe, expect, test, vi } from "vitest"
import { messageCompleted, messageUpdated, sessionError, sessionUsage } from "@claxedo/agent-sdk-runtime/compat-events"
import type { CompatEnvelope } from "@claxedo/agent-sdk-runtime"
import { buildAssistantMessage } from "@claxedo/agent-sdk-runtime/compat-events"
import type { TurnUsageRevision, UsageRevisionWriteResult } from "./contracts"
import { createTurnMeter } from "./turn-meter"

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

function envelope(payload: CompatEnvelope["payload"]): CompatEnvelope {
  return { directory: "/private/path-must-not-persist", payload }
}

function assistant(input: { completed?: number; error?: boolean; tokens?: Record<string, unknown> } = {}) {
  const row = buildAssistantMessage({
    id: "msg-1",
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
  test("writes a cumulative provider observation then settles the same turn at a higher revision", async () => {
    const { meter, facts } = harness()
    await meter.consume(envelope(sessionUsage({
      sessionID: "session-1",
      messageID: "msg-1",
      contextSize: 100,
      contextUsed: 15,
      observation: {
        kind: "cumulative",
        providerObservationId: "obs-1",
        observedAt: 1_000,
        tokens: { input: 10, output: 2, reasoning: null, cache: { read: 3, write: null } },
      },
    })))
    await meter.consume(envelope(messageUpdated(assistant({
      completed: 2_000,
      tokens: { input: 10, output: 8, reasoning: 1, cache: { read: 3, write: 0 } },
    }) as never)))
    await meter.consume(envelope(messageCompleted("session-1", "msg-1")))

    expect(facts).toHaveLength(2)
    expect(facts[0]).toMatchObject({ revision: 1, settlement: "provisional", status: "running" })
    expect(facts[1]).toMatchObject({
      revision: 2,
      settlement: "final",
      status: "completed",
      providerId: "openai",
      modelId: "gpt-5.4",
      tokens: { input: 10, output: 8, reasoning: 1, cache: { read: 3, write: 0 } },
    })
  })

  test("replaces cumulative observations and adds delta observations without fabricating unknown categories", async () => {
    const { meter, facts } = harness()
    const usage = (id: string, kind: "cumulative" | "delta", input: number | null, output: number | null) => envelope(sessionUsage({
      sessionID: "session-1",
      messageID: "msg-1",
      contextSize: 100,
      contextUsed: 1,
      observation: {
        kind,
        providerObservationId: id,
        tokens: { input, output, reasoning: null, cache: { read: null, write: null } },
      },
    }))
    await meter.consume(usage("1", "cumulative", 10, 1))
    await meter.consume(usage("2", "cumulative", 12, 4))
    await meter.consume(usage("3", "delta", null, 2))
    expect(facts.map((fact) => fact.tokens)).toEqual([
      { input: 10, output: 1, reasoning: null, cache: { read: null, write: null } },
      { input: 12, output: 4, reasoning: null, cache: { read: null, write: null } },
      { input: 12, output: 6, reasoning: null, cache: { read: null, write: null } },
    ])
  })

  test("provider error settles known usage and terminal-without-usage is unavailable", async () => {
    const known = harness()
    await known.meter.consume(envelope(sessionUsage({
      sessionID: "session-1",
      messageID: "msg-1",
      contextSize: 100,
      contextUsed: 1,
      observation: {
        kind: "cumulative",
        tokens: { input: 1, output: 2, reasoning: null, cache: { read: null, write: null } },
      },
    })))
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

  test("durable stop and process-loss outcomes settle partial or unavailable", async () => {
    const partial = harness()
    await partial.meter.consume(envelope(sessionUsage({
      sessionID: "session-1",
      messageID: "msg-1",
      contextSize: 100,
      contextUsed: 1,
      observation: {
        kind: "cumulative",
        tokens: { input: 1, output: 2, reasoning: null, cache: { read: null, write: null } },
      },
    })))
    await partial.meter.settle({ sessionId: "session-1", messageId: "msg-1", status: "stopped" })
    expect(partial.facts.at(-1)).toMatchObject({ settlement: "partial", status: "stopped" })

    const unavailable = harness()
    await unavailable.meter.settle({ sessionId: "session-1", messageId: "msg-lost", status: "process_lost" })
    expect(unavailable.facts.at(-1)).toMatchObject({ settlement: "unavailable", status: "process_lost" })
  })

  test("deduplicates a replayed provider observation and stores only the minimal fact", async () => {
    const { meter, facts } = harness()
    const event = envelope(sessionUsage({
      sessionID: "session-1",
      messageID: "msg-1",
      contextSize: 100,
      contextUsed: 1,
      observation: {
        kind: "cumulative",
        providerObservationId: "same",
        tokens: { input: 1, output: 2, reasoning: null, cache: { read: null, write: null } },
      },
    }))
    await meter.consume(event)
    await meter.consume(event)
    expect(facts).toHaveLength(1)
    expect(JSON.stringify(facts[0])).not.toContain("private/path")
  })

  test("startup reconciliation settles orphaned lifecycle and usage revisions", async () => {
    const recovered: TurnUsageRevision[] = []
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
        current: async () => current,
        pendingOutbox: async () => [],
      },
      resolveContext: async ({ sessionId }) => ({
        sessionRef: `workspace:ws-1:session:${sessionId}`,
        workspaceId: "ws-1",
        hostId: "host-1",
        location: "local",
        harness: "claude-sdk",
      }),
      reconcileProvisionalOnStart: true,
      now: () => 3_000,
    })
    await meter.start()
    expect(recovered).toEqual([
      expect.objectContaining({ messageId: "msg-partial", revision: 2, settlement: "partial", status: "process_lost" }),
      expect.objectContaining({ messageId: "msg-unavailable", revision: 2, settlement: "unavailable", status: "process_lost" }),
    ])
  })
})

function revisionForRecovery(messageId: string, tokens: TurnUsageRevision["tokens"] = {
  input: null,
  output: null,
  reasoning: null,
  cache: { read: null, write: null },
}): TurnUsageRevision {
  const known = [tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write]
    .some((value) => value !== null)
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
