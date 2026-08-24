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
import {
  AgentMessagePageError,
  type AgentHarnessAdapter,
  type AgentMessagePage,
  type AgentMessagePageInput,
} from "@claxedo/agent-sdk-runtime/adapters"
// These fixtures carry only the fields the routes under test read; the cast
// keeps them minimal rather than filling in a full UserMessage/AssistantMessage.
import { messagePartUpdated, messageUpdated, sessionIdle, type CompatEnvelope } from "../compat-events"
import type { Message } from "@opencode-ai/sdk/v2"

function adapter(input: {
  onDirectory?: (directory: RuntimeDirectory) => void
  events?: AgentRuntimeStreamEvent[]
  messages?: AgentMessageRow[]
  getMessagePage?: (
    id: string,
    page: AgentMessagePageInput,
    directory: RuntimeDirectory,
  ) => Promise<AgentMessagePage>
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
    ...(input.getMessagePage ? { getMessagePage: input.getMessagePage } : {}),
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

describe("createSessionRoutes message paging", () => {
  const first = { info: { id: "message-1", role: "user" }, parts: [] } as AgentMessageRow
  const second = { info: { id: "message-2", role: "assistant" }, parts: [] } as AgentMessageRow

  test("uses the route authority before an adapter page and forwards its opaque cursor", async () => {
    const calls: Array<{ sessionId: string; page: AgentMessagePageInput; directory: RuntimeDirectory }> = []
    let adapterResolutions = 0
    const app = createSessionRoutes({
      resolveAdapter: () => {
        adapterResolutions += 1
        return adapter({
          getMessagePage: async () => {
            throw new Error("adapter page must not run")
          },
        })
      },
      resolveDirectory: () => "/workspace",
      getMessagePage: (_c, directory, sessionId, page) => {
        calls.push({ sessionId, page, directory })
        return { messages: [first, second], nextCursor: "journal:opaque/next" }
      },
      sessionBus: { publish() {}, subscribe: () => () => {} },
      publishGlobal() {},
    })

    const response = await app.request("http://localhost/session/session-1/message?limit=2&before=journal%3Aopaque%2Fbefore")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([first, second])
    expect(response.headers.get("access-control-expose-headers")).toBe("X-Next-Cursor")
    expect(response.headers.get("x-next-cursor")).toBe("journal:opaque/next")
    expect(calls).toEqual([{
      sessionId: "session-1",
      page: { limit: 2, before: "journal:opaque/before" },
      directory: "/workspace",
    }])
    expect(adapterResolutions).toBe(1)
  })

  test("uses an optional adapter page when the route authority has no page", async () => {
    const calls: Array<{ id: string; page: AgentMessagePageInput; directory: RuntimeDirectory }> = []
    const app = routes({
      adapter: adapter({
        getMessagePage: async (id, page, directory) => {
          calls.push({ id, page, directory })
          return { messages: [second] }
        },
      }),
    })

    const response = await app.request("http://localhost/session/session-1/message?limit=1")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([second])
    expect(response.headers.get("x-next-cursor")).toBeNull()
    expect(calls).toEqual([{ id: "session-1", page: { limit: 1 }, directory: undefined }])
  })

  test("forwards the authoritative latest-turn view without a numeric limit", async () => {
    const calls: AgentMessagePageInput[] = []
    const app = routes({
      adapter: adapter({
        getMessagePage: async (_id, page) => {
          calls.push(page)
          return { messages: [first, second], nextCursor: "before-user" }
        },
      }),
    })

    const response = await app.request("http://localhost/session/session-1/message?view=latest-turn")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([first, second])
    expect(response.headers.get("x-next-cursor")).toBe("before-user")
    expect(calls).toEqual([{ view: "latest-turn" }])
  })

  test("returns unsupported instead of violating a bounded request with full history", async () => {
    let routeFullReads = 0
    let adapterFullReads = 0
    const fixture = adapter({ messages: [first, second] })
    fixture.getMessages = async () => {
      adapterFullReads += 1
      return [first, second]
    }
    const app = createSessionRoutes({
      resolveAdapter: () => fixture,
      resolveDirectory: () => "/workspace",
      getMessages: () => {
        routeFullReads += 1
        return [first, second]
      },
      sessionBus: { publish() {}, subscribe: () => () => {} },
      publishGlobal() {},
    })
    const response = await app.request("http://localhost/session/session-1/message?limit=1")

    expect(response.status).toBe(501)
    expect(response.headers.get("x-next-cursor")).toBeNull()
    expect(routeFullReads).toBe(0)
    expect(adapterFullReads).toBe(0)
  })

  test("preserves full history for legacy requests without paging parameters", async () => {
    let pageReads = 0
    const response = await routes({
      adapter: adapter({
        messages: [first, second],
        getMessagePage: async () => {
          pageReads += 1
          return { messages: [second] }
        },
      }),
    }).request("http://localhost/session/session-1/message")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([first, second])
    expect(response.headers.get("x-next-cursor")).toBeNull()
    expect(pageReads).toBe(0)
  })

  test("keeps snapshot reads full and ignores paging parameters", async () => {
    let pageCalls = 0
    const snapshot = { messages: [first, second], maxEventOrdinal: 14 }
    const app = createSessionRoutes({
      resolveAdapter: () => adapter(),
      resolveDirectory: () => "/workspace",
      getMessageSnapshot: () => snapshot,
      getMessagePage: () => {
        pageCalls += 1
        return { messages: [second], nextCursor: "must-not-leak" }
      },
      sessionBus: { publish() {}, subscribe: () => () => {} },
      publishGlobal() {},
    })

    const response = await app.request("http://localhost/session/session-1/message?snapshot=1&limit=invalid&before=")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(snapshot)
    expect(response.headers.get("x-next-cursor")).toBeNull()
    expect(pageCalls).toBe(0)
  })

  test("rejects malformed page inputs before resolving a producer", async () => {
    let adapterResolutions = 0
    const app = createSessionRoutes({
      resolveAdapter: () => {
        adapterResolutions += 1
        return adapter()
      },
      resolveDirectory: () => "/workspace",
      sessionBus: { publish() {}, subscribe: () => () => {} },
      publishGlobal() {},
    })

    for (const query of [
      "limit=0",
      "limit=1.5",
      "limit=501",
      "before=cursor",
      "limit=1&before=",
      "view=unknown",
      "view=latest-turn&limit=1",
      "view=latest-turn&before=cursor",
    ]) {
      const response = await app.request(`http://localhost/session/session-1/message?${query}`)
      expect(response.status).toBe(400)
    }
    expect(adapterResolutions).toBe(0)
  })

  test("maps typed route and adapter page errors to their explicit HTTP status", async () => {
    const routeErrorApp = createSessionRoutes({
      resolveAdapter: () => adapter(),
      resolveDirectory: () => "/workspace",
      getMessagePage: () => { throw new AgentMessagePageError(404, "session was not found") },
      sessionBus: { publish() {}, subscribe: () => () => {} },
      publishGlobal() {},
    })
    const adapterErrorApp = routes({
      adapter: adapter({
        getMessagePage: async () => { throw new AgentMessagePageError(400, "cursor is invalid") },
      }),
    })

    const [missing, invalid] = await Promise.all([
      routeErrorApp.request("http://localhost/session/missing/message?limit=1"),
      adapterErrorApp.request("http://localhost/session/session-1/message?limit=1&before=opaque"),
    ])

    expect(missing.status).toBe(404)
    expect(await missing.text()).toContain("session was not found")
    expect(invalid.status).toBe(400)
    expect(await invalid.text()).toContain("cursor is invalid")
  })

  test("does not trust an invalid status from an adapter page error", async () => {
    const app = routes({
      adapter: adapter({
        getMessagePage: async () => { throw new AgentMessagePageError(200, "invalid producer status") },
      }),
    })

    const response = await app.request("http://localhost/session/session-1/message?limit=1")

    expect(response.status).toBe(502)
  })
})

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
  test("persists the complete config before publishing a created session", async () => {
    const calls: string[] = []
    const lifecycle: SessionLifecycleEvent[] = []
    const item = adapter()
    const app = routes({
      lifecycle,
      adapter: {
        ...item,
        createSession: async () => {
          calls.push("create")
          return { id: "session_configured" }
        },
        updateSessionConfig: async (id, update) => {
          calls.push(`config:${id}:${update.model?.providerID}:${update.model?.modelID}`)
          return {
            harness: update.harness ?? { id: "claude", access: "native" },
            ...(update.model ? { model: update.model } : {}),
            agent: update.agent ?? null,
            variant: update.variant ?? null,
          }
        },
      },
    })

    const res = await app.request("http://localhost/session", {
      method: "POST",
      body: JSON.stringify({
        model: { providerID: "claude-sdk", id: "sonnet", variant: "high" },
        agent: "build",
      }),
    })

    expect(res.status).toBe(201)
    expect(calls).toEqual(["create", "config:session_configured:claude-sdk:sonnet"])
    expect(lifecycle.map((event) => event.phase)).toEqual(["creating", "created"])
  })

  test("rolls back a session whose initial config cannot be persisted", async () => {
    const calls: string[] = []
    const lifecycle: SessionLifecycleEvent[] = []
    const item = adapter()
    const app = routes({
      lifecycle,
      adapter: {
        ...item,
        createSession: async () => ({ id: "session_rejected" }),
        updateSessionConfig: async () => {
          calls.push("config")
          throw new Error("config unavailable")
        },
        deleteSession: async (id) => {
          calls.push(`delete:${id}`)
        },
      },
    })

    const res = await app.request("http://localhost/session", {
      method: "POST",
      body: JSON.stringify({
        model: { providerID: "claude-sdk", id: "sonnet" },
      }),
    })

    expect(res.status).toBe(500)
    expect(calls).toEqual(["config", "delete:session_rejected"])
    expect(lifecycle.map((event) => event.phase)).toEqual(["creating", "failed"])
    expect(await res.json()).toMatchObject({ error: { message: "config unavailable" } })
  })

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

  test("reads durable subagent associations without consulting the harness", async () => {
    const calls: Array<{ directory: RuntimeDirectory; parentSessionId: string }> = []
    const app = createSessionRoutes({
      resolveAdapter: () => adapter(),
      resolveDirectory: () => undefined,
      listSubagents: (_c, directory, parentSessionId) => {
        calls.push({ directory, parentSessionId })
        return [{ subagentKey: "child_1", revision: 3, status: "running" }]
      },
      sessionBus: {
        publish: () => {},
        subscribe: () => () => {},
      },
      publishGlobal: () => {},
    })
    const res = await app.request("http://localhost/session/parent_1/subagents")

    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual([{ subagentKey: "child_1", revision: 3, status: "running" }])
    expect(calls).toEqual([{ directory: undefined, parentSessionId: "parent_1" }])
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
