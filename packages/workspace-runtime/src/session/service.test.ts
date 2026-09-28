import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { SessionHarness } from "@claxedo/agent-runtime-contract"
import type { TurnOrigin } from "@claxedo/harness/contract"
import type { CompatEnvelope } from "../compat-events"
import { createStoreBrokerPorts } from "../broker-ports/index"
import { createAgentRuntime, type AgentRuntime, type HarnessHandle, type LaunchComposer } from "../host/runtime"
import { createRuntimeEventHub } from "../projection/runtime-event-hub"
import { RuntimeStore } from "../store"
import { FakeTransport, type FakeTransportOptions } from "../test-support/fake-transport"
import {
  parseSessionPromptBody,
  runRuntimePromptTurn,
  sessionPromptReply,
} from "./service"

const WORKSPACE = "workspace-test"
const DIRECTORY = "/work"
const HARNESS: SessionHarness = { id: "fake", access: "connection" }
const ORIGIN: TurnOrigin = { actor: { kind: "machine-owner" }, via: "loopback", reissued: false }

type Host = {
  store: RuntimeStore
  runtime: AgentRuntime
  transport: FakeTransport
  eventHub: ReturnType<typeof createRuntimeEventHub>
}

const hosts: Array<{ host: Host; root: string }> = []

/** The real runtime host over a durable store, with the scripted transport behind it. */
function host(options: FakeTransportOptions = {}): Host {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-session-service-"))
  const store = new RuntimeStore(root)
  const eventHub = createRuntimeEventHub()
  const transport = new FakeTransport(options)
  const ownerGeneration = "owner-1"
  const handle: HarnessHandle = { key: "fake", runner: HARNESS, kind: transport.kind, transport, locality: "local", retired: () => false, pin: () => () => {} }
  const launch: LaunchComposer = {
    workspaceId: WORKSPACE,
    projection: () => ({ generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] }),
    credentials: () => ({ providers: {}, secrets: {}, leaseGeneration: "g1" }),
  }
  const ports = createStoreBrokerPorts(store, {
    ownerGeneration,
    patternEvaluator: async () => {},
    publishers: eventHub,
    reportOwnerFailure: (sessionId, error) => runtime.recovery.reportOwnerFailure(sessionId, error),
    retainLeasedTurnFailure: (sessionId, turn, error) => runtime.recovery.retainLeasedTurnFailure(sessionId, turn, error),
  })
  const runtime = createAgentRuntime({
    store, eventHub, ports, ownerGeneration, launch,
    transports: { forHarness: async () => handle, composed: () => [handle], onRetire: () => () => {} },
    identity: { workspaceId: WORKSPACE },
    savedCommands: () => [],
  })
  const created = { store, runtime, transport, eventHub }
  hosts.push({ host: created, root })
  return created
}

function createSession(fixture: Host, id: string, config: { variant?: string | null } = {}) {
  return fixture.runtime.sessions.create({
    id, workspaceId: WORKSPACE, directory: DIRECTORY, harness: HARNESS, owner: ORIGIN.actor, origin: ORIGIN, ...config,
  })
}

afterEach(async () => {
  for (const { host: fixture, root } of hosts.splice(0)) {
    await fixture.runtime.dispose()
    fixture.store.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe("session service", () => {
  it("refuses the turn before the transport runs when the session config cannot be read", async () => {
    const fixture = host()
    // A session row without its config row: the shape a create leaves behind
    // when it fails between binding the session and recording its config.
    fixture.store.bindSession({
      sessionId: "s1", workspaceId: WORKSPACE, directory: DIRECTORY, connectionId: "connection:fake",
      upstreamSessionId: "s1", agentSessionId: "s1", createdAt: 1,
    })
    const events: CompatEnvelope[] = []

    await expect(runRuntimePromptTurn({
      runtime: fixture.runtime,
      sessionId: "s1",
      directory: DIRECTORY,
      body: { parts: [], agent: "build", model: { providerID: "test", modelID: "fixture" }, variant: "fixture" },
      origin: ORIGIN,
      publishGlobal: (event) => events.push(event),
    })).rejects.toThrow("Session s1 has no runtime config")

    expect(fixture.transport.starts).toEqual([])
    expect(fixture.transport.turns).toEqual([])
    // The refusal reaches the stream as the session's error, so a client
    // waiting on the turn learns why nothing followed its prompt.
    expect(events).toMatchObject([
      { directory: DIRECTORY, payload: { type: "session.error", properties: { sessionID: "s1" } } },
    ])
  })

  it("runs a prompt turn without a Hono route", async () => {
    const fixture = host({
      async *turn({ session }) {
        yield { type: "text-delta", delta: "hello" }
        yield { type: "finish", sessionId: session.binding.sessionId }
      },
    })
    await createSession(fixture, "s1")
    const stream: CompatEnvelope[] = []
    const unsubscribe = fixture.eventHub.subscribeGlobal((event) => stream.push(event))
    const events: CompatEnvelope[] = []
    try {
      const turn = await runRuntimePromptTurn({
        runtime: fixture.runtime,
        sessionId: "s1",
        directory: DIRECTORY,
        body: { messageID: "msg-user", parts: [{ type: "text", text: "hello" }] },
        origin: ORIGIN,
        publishGlobal: (event) => events.push(event),
      })
      const output = sessionPromptReply(turn)

      // The runtime hub carries the turn's rows; the service republishes none of them.
      expect(events).toEqual([])
      const rows = stream.map((event) => event.payload).filter((payload) => payload.type === "message.updated")
      expect(rows.map((payload) => [payload.properties.info.role, payload.properties.info.id])).toEqual(expect.arrayContaining([
        ["user", "msg-user"],
        ["assistant", "msg-user_r"],
      ]))
      // The reply text streams as a delta against the assistant row named before it.
      expect(stream.some((event) => event.payload.type === "message.part.delta"
        && event.payload.properties.messageID === "msg-user_r"
        && event.payload.properties.field === "text"
        && event.payload.properties.delta === "hello")).toBe(true)
      expect(stream.every((event) => event.directory === DIRECTORY)).toBe(true)
      expect(output.body).toMatchObject({
        info: { id: "msg-user_r", sessionID: "s1", role: "assistant" },
        parts: [{ type: "text", text: "hello" }],
      })
      expect(turn.assistantMessagePublished).toBe(true)
      expect(output.assistantMessage).toBeUndefined()
    } finally {
      unsubscribe()
    }
  })

  it("carries the requested permission mode into the transport turn", async () => {
    const fixture = host()
    await createSession(fixture, "s1")

    await runRuntimePromptTurn({
      runtime: fixture.runtime,
      sessionId: "s1",
      directory: DIRECTORY,
      body: { parts: [{ type: "text", text: "hello" }], permissionMode: "agent-full-access" },
      origin: ORIGIN,
      publishGlobal: () => {},
    })

    expect(fixture.transport.turns.map((turn) => turn.turn.prompt.permissionMode)).toEqual(["agent-full-access"])
  })

  it("runs the turn's own effort, none when it asks for none, and the saved one only when it names nothing", async () => {
    const fixture = host()
    const wires = [{ variant: "low" }, { variant: null }, {}]
    for (const [index, wire] of wires.entries()) {
      const sessionId = `s${index}`
      await createSession(fixture, sessionId, { variant: "high" })
      await runRuntimePromptTurn({
        runtime: fixture.runtime,
        sessionId,
        directory: DIRECTORY,
        body: parseSessionPromptBody({ parts: [{ type: "text", text: "hello" }], ...wire }),
        origin: ORIGIN,
        publishGlobal: () => {},
      })
    }

    expect(fixture.transport.turns.map((turn) => turn.turn.effort)).toEqual(["low", undefined, "high"])
  })

  it("carries a requested service tier from the wire body into the transport turn", async () => {
    const fixture = host()
    const wires = [{ serviceTier: "priority" }, {}, { serviceTier: 7 }]
    for (const [index, wire] of wires.entries()) {
      const sessionId = `s${index}`
      await createSession(fixture, sessionId)
      await runRuntimePromptTurn({
        runtime: fixture.runtime,
        sessionId,
        directory: DIRECTORY,
        body: parseSessionPromptBody({ parts: [{ type: "text", text: "hello" }], ...wire }),
        origin: ORIGIN,
        publishGlobal: () => {},
      })
    }

    expect(fixture.transport.turns.map((turn) => turn.turn.prompt.serviceTier)).toEqual(["priority", undefined, undefined])
  })

  it("uses the agent-owned default model when a connection session has no selected model", async () => {
    const fixture = host()
    await createSession(fixture, "s1")

    await runRuntimePromptTurn({
      runtime: fixture.runtime,
      sessionId: "s1",
      directory: DIRECTORY,
      body: { parts: [{ type: "text" as const, text: "hello" }] },
      origin: ORIGIN,
      publishGlobal: () => {},
    })

    expect(fixture.transport.turns.map((turn) => turn.turn.model)).toEqual([undefined])
  })

  it("observes the reply without republishing the runtime-owned event stream", async () => {
    const events: CompatEnvelope[] = []
    const turn = await runRuntimePromptTurn({
      runtime: {
        turns: {
          start: async () => ({
            sessionId: "s1",
            userMessageId: "msg-user",
            assistantMessageId: "msg-user_r",
            directory: "/work",
            prompt: { parts: [], userMessageId: "msg-user", agent: "build", model: { providerID: "test", modelID: "test" } },
            delivery: "start",
          }),
        },
        events: {
          subscribe: () => ({
            async *[Symbol.asyncIterator]() {
              yield { payload: { type: "text-delta", delta: "hi" } }
              yield { payload: { type: "finish", reason: "stop" } }
            },
          }),
          list: async () => [],
        },
      } as never,
      sessionId: "s1",
      directory: "/work",
      body: { parts: [{ type: "text", text: "hello" }] },
      origin: ORIGIN,
      publishGlobal: (event) => events.push(event),
    })

    expect(events).toEqual([])
    expect(turn.assistantId).toBe("msg-user_r")
    expect(turn.assistantMessagePublished).toBe(true)
  })

  it("carries the requested permission mode through the durable runtime turn", async () => {
    const starts: unknown[] = []
    await runRuntimePromptTurn({
      runtime: {
        turns: {
          start: async (input: unknown) => {
            starts.push(input)
            return {
              sessionId: "s1",
              userMessageId: "msg-user",
              assistantMessageId: "msg-user_r",
              directory: "/work",
              prompt: { parts: [], userMessageId: "msg-user", agent: "build", model: { providerID: "test", modelID: "test" } },
            }
          },
        },
        events: {
          subscribe: () => ({
            async *[Symbol.asyncIterator]() {},
          }),
          list: async () => [],
        },
      } as never,
      sessionId: "s1",
      directory: "/work",
      body: { parts: [{ type: "text", text: "hello" }], permissionMode: "agent-full-access" },
      origin: ORIGIN,
      publishGlobal: () => {},
    })

    expect(starts).toEqual([expect.objectContaining({ permissionMode: "agent-full-access" })])
  })

  it("forwards only a complete runtime actor pair", async () => {
    const starts: unknown[] = []
    const runtime = {
      turns: {
        start: async (input: unknown) => {
          starts.push(input)
          return {
            sessionId: "s1",
            userMessageId: "msg-user",
            assistantMessageId: "msg-user_r",
            directory: "/work",
            prompt: { parts: [], userMessageId: "msg-user", agent: "build", model: { providerID: "test", modelID: "test" } },
          }
        },
      },
      events: {
        subscribe: () => ({ async *[Symbol.asyncIterator]() {} }),
        list: async () => [],
      },
    } as never
    const common = {
      runtime,
      sessionId: "s1",
      directory: "/work" as const,
      body: { parts: [{ type: "text" as const, text: "hello" }] },
      origin: ORIGIN,
      publishGlobal: () => {},
    }

    await runRuntimePromptTurn({ ...common, actor: { actorId: "actor-1", actorKind: "human" } })
    await runRuntimePromptTurn(common)

    expect(starts[0]).toEqual(expect.objectContaining({ actorId: "actor-1", actorKind: "human" }))
    expect(starts[1]).not.toHaveProperty("actorId")
    expect(starts[1]).not.toHaveProperty("actorKind")
  })

  it("fails without synthesizing prompt events when the transport yields none", async () => {
    const fixture = host({ async *turn() {} })
    await createSession(fixture, "s1")
    const events: CompatEnvelope[] = []

    const turn = await runRuntimePromptTurn({
      runtime: fixture.runtime,
      sessionId: "s1",
      directory: DIRECTORY,
      body: { messageID: "msg-user", parts: [{ type: "text", text: "hello" }] },
      origin: ORIGIN,
      publishGlobal: (event) => events.push(event),
    })

    expect(fixture.transport.turns).toHaveLength(1)
    expect(events).toEqual([])
    expect(turn.assistantId).toBe("msg-user_r")
    expect(turn.error).toBe("Harness stream ended without a terminal event")
  })

  it("closes runtime event streams when starting a turn fails", async () => {
    let returned = false
    const events: CompatEnvelope[] = []

    await expect(runRuntimePromptTurn({
      runtime: {
        turns: {
          start: async () => {
            throw new Error("missing session")
          },
        },
        events: {
          subscribe: () => ({
            [Symbol.asyncIterator]: () => ({
              next: async () => ({ done: true as const, value: undefined }),
              return: async () => {
                returned = true
                return { done: true as const, value: undefined }
              },
            }),
          }),
          list: async () => [],
        },
      } as never,
      sessionId: "missing",
      directory: "/work",
      body: { parts: [{ type: "text", text: "hello" }] },
      origin: ORIGIN,
      publishGlobal: (event) => events.push(event),
    })).rejects.toThrow("missing session")

    expect(returned).toBe(true)
    expect(events).toMatchObject([
      { directory: "/work", payload: { type: "session.error" } },
    ])
  })

})
