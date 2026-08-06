import { describe, expect, test } from "bun:test"
import { createSessionRoutes, type RuntimeSessionBusEvent, type SessionLifecycleEvent } from "./session-core"
import type {
  AgentMessageRow,
  AgentRuntime,
  AgentRuntimeStreamEvent,
  PromptInput,
  RuntimeDirectory,
  SessionConfig,
} from "@claxedo/agent-sdk-runtime"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
// These fixtures carry only the fields the routes under test read; the cast
// keeps them minimal rather than filling in a full UserMessage/AssistantMessage.
import { messagePartUpdated, messageUpdated, sessionIdle, type CompatEnvelope } from "../compat-events"
import type { Message } from "@opencode-ai/sdk/v2"

function adapter(input: {
  onDirectory?: (directory: RuntimeDirectory) => void
  events?: AgentRuntimeStreamEvent[]
  messages?: AgentMessageRow[]
} = {}): AgentHarnessAdapter {
  return {
    listSessions: async (directory) => {
      input.onDirectory?.(directory)
      return []
    },
    getSession: async (id, directory) => {
      input.onDirectory?.(directory)
      return { id, title: "Hybrid", time: { created: 1, updated: 1 } }
    },
    createSession: async () => ({ id: "session_1" }),
    updateSession: async (id) => ({ id, title: "Hybrid", time: { created: 1, updated: 1 } }),
    getSessionConfig: async (_id, directory) => {
      input.onDirectory?.(directory)
      return {
        harness: { id: "opencode", access: "native" },
        model: { providerID: "test", modelID: "fixture" },
        agent: "build",
        variant: null,
      } satisfies SessionConfig
    },
    updateSessionConfig: async (_id, patch) => ({
      harness: patch.harness ?? { id: "opencode", access: "native" },
      ...(patch.model ? { model: patch.model } : {}),
      agent: patch.agent ?? null,
      variant: patch.variant ?? null,
    }),
    deleteSession: async () => {},
    readHarnessCapabilities: (directory) => {
      input.onDirectory?.(directory)
      return {
        harness: "opencode",
        abort: true,
        reconnect: false,
        replay: true,
        permissions: true,
        questions: true,
        todos: true,
        commands: true,
        fork: true,
        revert: true,
        unrevert: true,
        configOptions: false,
        subagents: true,
      }
    },
    sendMessage: (_id: string, _prompt: PromptInput, directory: RuntimeDirectory) => {
      input.onDirectory?.(directory)
      return (async function* () {
        for (const event of input.events ?? []) yield event
      })()
    },
    getMessages: async (_id, directory) => {
      input.onDirectory?.(directory)
      return input.messages ?? []
    },
    abort: async () => ({ ok: true, status: "cancelled" }),
    revert: async () => {},
    unrevert: async () => {},
    forkSession: async () => ({ id: "forked" }),
    executeCommand: async () => {},
    listCommands: async () => [],
    listAgents: async () => [],
    getTodos: async () => [],
    listPermissions: async () => [],
    respondPermission: async () => {},
    listQuestions: async () => [],
    replyQuestion: async () => {},
    rejectQuestion: async () => {},
    applyConfig: async () => {},
    probeConfigOptions: async () => [],
    dispose: () => {},
  }
}

function routes(input: {
  adapter: AgentHarnessAdapter
  events?: CompatEnvelope[]
  busEvents?: RuntimeSessionBusEvent[]
  lifecycle?: SessionLifecycleEvent[]
}) {
  return createSessionRoutes({
    resolveAdapter: () => input.adapter,
    resolveDirectory: () => undefined,
    sessionBus: {
      publish: (event) => input.busEvents?.push(event),
      subscribe: () => () => {},
    },
    publishGlobal: (event) => input.events?.push(event),
    publishSessionLifecycle: (event) => input.lifecycle?.push(event),
  })
}

describe("createSessionRoutes directory-less sessions", () => {
  test("keeps a missing backend title empty in the created lifecycle row", async () => {
    const lifecycle: SessionLifecycleEvent[] = []
    const res = await routes({ adapter: adapter(), lifecycle }).request("http://localhost/session", {
      method: "POST",
      body: "{}",
    })

    expect(res.status).toBe(201)
    expect((lifecycle.find((event) => event.phase === "created")?.info as { title?: string } | undefined)?.title).toBe("")
  })

  test("returns an empty agent list when harness cannot expose live agent options", async () => {
    const res = await routes({
      adapter: {
        ...adapter(),
        listAgents: async () => {
          throw new Error("opencode does not expose live agent options")
        },
      },
    }).request("http://localhost/agent")

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  test("passes undefined directory through detail routes", async () => {
    const directories: RuntimeDirectory[] = []
    const res = await routes({
      adapter: adapter({ onDirectory: (directory) => directories.push(directory) }),
    }).request("http://localhost/session/session_1/capabilities")

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ harness: "opencode" })
    expect(directories).toEqual([undefined])
  })

  test("uses session id as legacy event scope when directory is absent", async () => {
    const events: CompatEnvelope[] = []
    const busEvents: RuntimeSessionBusEvent[] = []
    const res = await routes({
      events,
      busEvents,
      adapter: adapter({
        events: [
          messageUpdated({
            id: "user_1",
            sessionID: "session_1",
            role: "user",
            time: { created: 1 },
          } as Message),
          messagePartUpdated({
            id: "user_1_part_0",
            sessionID: "session_1",
            messageID: "user_1",
            type: "text",
            text: "hello",
          }),
          messageUpdated({
            id: "assistant_1",
            sessionID: "session_1",
            role: "assistant",
            time: { created: 1 },
          } as Message),
          sessionIdle("session_1"),
        ],
        messages: [{
          info: {
            id: "assistant_1",
            sessionID: "session_1",
            role: "assistant",
          },
          parts: [],
        }],
      }),
    }).request("http://localhost/session/session_1/message", {
      method: "POST",
      body: JSON.stringify({
        agent: "build",
        model: { providerID: "test", modelID: "fixture" },
        variant: "fixture",
        parts: [{ type: "text", text: "hello" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(events.map((event) => event.directory)).toEqual(["session_1", "session_1", "session_1", "session_1"])
    expect(events.map((event) => event.payload.type).slice(0, 2)).toEqual(["message.updated", "message.part.updated"])
    expect(busEvents).toEqual([
      { type: "process.status", directory: "session_1", configId: "session_1", status: "streaming" },
      { type: "process.status", directory: "session_1", configId: "session_1", status: "streaming" },
      { type: "process.status", directory: "session_1", configId: "session_1", status: "streaming" },
      { type: "process.status", directory: "session_1", configId: "session_1", status: "streaming" },
    ])
  })

  test("can run message turns through the agent runtime facade", async () => {
    const events: CompatEnvelope[] = []
    const busEvents: RuntimeSessionBusEvent[] = []
    const messages: AgentMessageRow[] = [{
      info: {
        id: "assistant_1",
        sessionID: "session_1",
        role: "assistant",
      },
      parts: [],
    }]
    const turnStarts: unknown[] = []
    const runtime = {
      turns: {
        start: async (input: unknown) => {
          turnStarts.push(input)
          return {
            sessionId: "session_1",
            userMessageId: "user_1",
            assistantMessageId: "assistant_1",
            directory: undefined,
            prompt: {
              parts: [{ type: "text", text: "hello" }],
              userMessageId: "user_1",
              assistantMessageId: "assistant_1",
              agent: "build",
              model: { providerID: "test", modelID: "fixture" },
            },
          }
        },
      },
      events: {
        subscribe: () => (async function*() {
          yield {
            sessionId: "session_1",
            directory: undefined,
            payload: messageUpdated({
              id: "assistant_1",
              sessionID: "session_1",
              role: "assistant",
              time: { created: 1 },
            } as Message),
          }
          yield {
            sessionId: "session_1",
            directory: undefined,
            payload: sessionIdle("session_1"),
          }
        })(),
        list: async () => messages,
      },
    } as unknown as AgentRuntime
    const app = createSessionRoutes({
      resolveAdapter: () => adapter(),
      resolveRuntime: () => runtime,
      resolveDirectory: () => undefined,
      sessionBus: {
        publish: (event) => busEvents.push(event),
        subscribe: () => () => {},
      },
      publishGlobal: (event) => events.push(event),
    })

    const res = await app.request("http://localhost/session/session_1/message", {
      method: "POST",
      body: JSON.stringify({
        agent: "build",
        model: { providerID: "test", modelID: "fixture" },
        parts: [{ type: "text", text: "hello" }],
      }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual(messages[0])
    expect(turnStarts).toEqual([{
      sessionId: "session_1",
      parts: [{ type: "text", text: "hello" }],
      agent: "build",
      model: { providerID: "test", modelID: "fixture" },
    }])
    expect(events.map((event) => event.payload.type)).toEqual(["message.updated", "session.idle"])
    expect(busEvents).toEqual([
      { type: "process.status", directory: "session_1", configId: "session_1", status: "streaming" },
      { type: "process.status", directory: "session_1", configId: "session_1", status: "streaming" },
    ])
  })

  test("preserves the cause instead of flattening a failed turn to 'Stream error'", async () => {
    const events: CompatEnvelope[] = []
    const runtime = {
      turns: {
        start: async () => {
          throw new Error("thread not found: 019f73fb-ef5d-7fd0-9011-124481bc6ef0")
        },
      },
      events: {
        subscribe: () => (async function* () {})(),
        list: async () => [],
      },
    } as unknown as AgentRuntime
    const app = createSessionRoutes({
      resolveAdapter: () => adapter(),
      resolveRuntime: () => runtime,
      resolveDirectory: () => undefined,
      sessionBus: { publish: () => {}, subscribe: () => () => {} },
      publishGlobal: (event) => events.push(event),
    })

    const res = await app.request("http://localhost/session/session_1/prompt_async", {
      method: "POST",
      body: JSON.stringify({
        agent: "build",
        model: { providerID: "test", modelID: "fixture" },
        parts: [{ type: "text", text: "hello" }],
      }),
    })

    // prompt_async is fire-and-forget: the route acknowledges immediately.
    expect(res.status).toBe(204)
    // Let the detached turn run its catch/finally and publish its failure.
    await new Promise((resolve) => setTimeout(resolve, 10))

    const sessionErrors = events.filter((event) => event.payload.type === "session.error")
    expect(sessionErrors.length).toBeGreaterThan(0)
    for (const event of sessionErrors) {
      const error = (event.payload as { properties: { error: { data?: { message?: string; firstTurnErrorClass?: string } } } })
        .properties.error
      // The real cause survives — never the literal "Stream error".
      expect(error.data?.message).not.toBe("Stream error")
      expect(error.data?.message).toContain("thread not found")
      // And it now classifies (a lost thread → session recovery, not the old workspace fallback).
      expect(error.data?.firstTurnErrorClass).toBe("session")
    }
  })
})
