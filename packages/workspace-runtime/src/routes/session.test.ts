import { describe, expect, it, spyOn } from "bun:test"
import { fetchDouble } from "../test-support/fetch-double"
import type {
  AgentMessage,
  AgentRuntimeStreamEvent,
  PromptInput,
  RuntimeDirectory,
  SessionConfig,
  SessionConfigUpdate,
} from "@claxedo/agent-sdk-runtime"
import type { AgentHarnessAdapter, HttpProxyAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import {
  buildAssistantMessage,
  buildSession,
  buildUserMessage,
  messagePartUpdated,
  messageUpdated,
  sessionError,
  sessionIdle,
  sessionStatus,
  sessionUpdated,
  type CompatEvent,
} from "../compat-events"
import { createRuntimeEventHub } from "../runtime-event-hub"
import { workspaceRuntimeBus, type WorkspaceRuntimeEvent } from "../bus"
import { createSessionRoutes } from "./session-core"
import { SessionRoutes } from "./session"

function adapter(input: {
  // The adapter interface hands these a `RuntimeDirectory` (`string |
  // undefined`), so the doubles must accept one too.
  onPrompt?: (prompt: PromptInput, directory: RuntimeDirectory) => void
  sendMessage?: (id: string, prompt: PromptInput, directory: RuntimeDirectory) => AsyncIterable<AgentRuntimeStreamEvent>
  getMessages?: (id: string, directory: RuntimeDirectory) => Promise<AgentMessage[]> | AgentMessage[]
}): AgentHarnessAdapter {
  return {
    listSessions: async () => [],
    getSession: async (id, directory) => buildSession({ id, directory: directory ?? "", title: "Demo" }),
    createSession: async () => ({ id: "s1" }),
    updateSession: async (id, updates, directory) => buildSession({ id, directory: directory ?? "", title: updates.title ?? "Demo" }),
    getSessionConfig: async () => ({
      harness: { id: "opencode", access: "native" },
      model: { providerID: "openai", modelID: "gpt-5.4" },
      variant: "fast",
      agent: "plan",
    }),
    updateSessionConfig: async (_id, patch) => ({
      harness: patch.harness ?? { id: "opencode", access: "native" },
      ...(patch.model ? { model: patch.model } : {}),
      variant: patch.variant ?? null,
      agent: patch.agent ?? null,
    } satisfies SessionConfig),
    deleteSession: async () => {},
    readHarnessCapabilities: () => ({
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
    }),
    sendMessage(id, prompt, directory) {
      input.onPrompt?.(prompt, directory)
      return input.sendMessage?.(id, prompt, directory) ?? (async function* () {})()
    },
    getMessages: async (id, directory) => input.getMessages?.(id, directory) ?? [],
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
    replyQuestion: async () => {},
    rejectQuestion: async () => {},
    applyConfig: async () => {},
    probeConfigOptions: async () => [],
    dispose: () => {},
  }
}

describe("session prompt route", () => {
  it("serves experimental session summaries", async () => {
    const directory = process.cwd()
    const app = SessionRoutes(() => ({
      ...adapter({}),
      listSessions: async () => [
        buildSession({
          id: "s2",
          directory,
          title: "Second",
          created: 20,
          updated: 30,
        }),
        {
          id: "s-child",
          title: "Child",
          directory,
          parentID: "s2",
          time: { created: 25, updated: 35 },
        },
        {
          id: "s1",
          directory,
          title: "First",
          created_at: 10,
          updated_at: 15,
          status: null,
          lastTurn: { status: "completed", completedAt: 40 },
        },
      ],
    }))

    const res = await app.request(`http://localhost/experimental/session?directory=${encodeURIComponent(directory)}&roots=true&limit=5`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      {
        id: "s2",
        title: "Second",
        projectID: directory,
        time: { created: 20, updated: 30 },
        directory,
      },
      {
        id: "s1",
        title: "First",
        time: { created: 10, updated: 10 },
        directory,
        status: null,
        lastTurn: { status: "completed", completedAt: 40 },
      },
    ])
  })

  /**
   * A harness name that does not resolve used to fall through to undefined,
   * which made the adapter resolve from the DIRECTORY — the last harness
   * selected there. On `/permission/modes` that meant asking for one harness
   * and being handed another's permission modes, with nothing in the reply
   * saying so, which the picker then rendered under the name it had asked for.
   */
  it("rejects a harness it does not recognise instead of answering for another one", async () => {
    const directory = process.cwd()
    const seen: Array<string | undefined> = []
    const app = SessionRoutes((input) => {
      seen.push(input?.harness ? `${input.harness.id}:${input.harness.access}` : undefined)
      return {
        ...adapter({}),
        listPermissionModes: async () => ({
          modes: [{ id: "read-only", name: "Read-only" }],
          appliesFrom: "next-turn" as const,
        }),
      }
    })

    const bogus = await app.request(`/permission/modes?directory=${encodeURIComponent(directory)}&harness=not-a-harness`)
    expect(bogus.status).toBe(400)
    // The adapter must never have been asked for — an answer that reached the
    // adapter at all is an answer that could be returned to the caller.
    expect(seen).toEqual([])

    // A name it does recognise still resolves, and an absent one still means
    // "no preference" rather than an error.
    const known = await app.request(`/permission/modes?directory=${encodeURIComponent(directory)}&harness=codex-acp`)
    expect(known.status).toBe(200)
    expect(seen).toEqual(["codex:acp"])

    const unqualified = await app.request(`/permission/modes?directory=${encodeURIComponent(directory)}`)
    expect(unqualified.status).toBe(200)
    expect(seen).toEqual(["codex:acp", undefined])
  })

  it("excludes archived sessions by default and includes them with ?archived=true", async () => {
    const directory = process.cwd()
    const app = SessionRoutes(() => ({
      ...adapter({}),
      listSessions: async () => [
        buildSession({ id: "active-1", directory, title: "Active", created: 10 }),
        {
          id: "archived-1",
          directory,
          title: "Archived",
          time: { created: 8, updated: 8, archived: 200 },
        },
      ],
    }))

    // Default: archived sessions excluded
    const res1 = await app.request(`http://localhost/experimental/session?directory=${encodeURIComponent(directory)}`)
    expect(res1.status).toBe(200)
    const list1 = await res1.json() as Array<{ id: string }>
    expect(list1.map((s) => s.id)).toEqual(["active-1"])

    // With ?archived=true: all sessions included
    const res2 = await app.request(`http://localhost/experimental/session?directory=${encodeURIComponent(directory)}&archived=true`)
    expect(res2.status).toBe(200)
    const list2 = await res2.json() as Array<{ id: string; time: { archived?: number } }>
    expect(list2.map((s) => s.id)).toEqual(["active-1", "archived-1"])
    expect(list2.find((s) => s.id === "archived-1")!.time.archived).toBe(200)
  })

  it("preserves archived timestamp when archived_at is zero", async () => {
    const directory = process.cwd()
    const app = SessionRoutes(() => ({
      ...adapter({}),
      listSessions: async () => [{
        id: "s-epoch",
        directory,
        title: "Epoch Archive",
        created_at: 10,
        updated_at: 20,
        archived_at: 0,
      }],
    }))

    const res = await app.request(`http://localhost/session?directory=${encodeURIComponent(directory)}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{
      id: "s-epoch",
      title: "Epoch Archive",
      slug: "s-epoch",
      version: "local",
      directory,
      time: {
        created: 10,
        updated: 10,
        archived: 0,
      },
    }])
  })

  it("preserves project identity fields when normalizing legacy session rows", async () => {
    const directory = process.cwd()
    const app = SessionRoutes(() => ({
      ...adapter({}),
      listSessions: async () => [{
        id: "s-project",
        directory,
        title: "Project Session",
        created_at: 10,
        projectID: "proj_1",
        parentID: "parent_1",
        rootID: "root_1",
        tags: ["review"],
        attachments: [{ kind: "page", targetID: "p1" }],
      }],
    }))

    const res = await app.request(`http://localhost/session?directory=${encodeURIComponent(directory)}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{
      id: "s-project",
      title: "Project Session",
      slug: "s-project",
      version: "local",
      directory,
      projectID: "proj_1",
      parentID: "parent_1",
      rootID: "root_1",
      tags: ["review"],
      attachments: [{ kind: "page", targetID: "p1" }],
      time: {
        created: 10,
        updated: 10,
      },
    }])
  })

  it("uses the request directory when normalizing created sessions without a directory", async () => {
    const directory = process.cwd()
    const app = SessionRoutes(() => ({
      ...adapter({}),
      createSession: async () => ({ id: "session-created" }),
    }))

    const res = await app.request(`http://localhost/session?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Created" }),
    })

    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({
      id: "session-created",
      directory,
    })
  })

  it("applies a selected runtime model before creating a session", async () => {
    const directory = process.cwd()
    const calls: string[] = []
    const app = SessionRoutes(() => ({
      ...adapter({}),
      adapterCapabilities: ["runtime-config"] as const,
      setModel(model: string) {
        calls.push(`setModel:${model}`)
      },
      setAuth() {},
      async createSession() {
        calls.push("createSession")
        return { id: "session-created" }
      },
    }))

    const res = await app.request(`http://localhost/session?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Created",
        model: { providerID: "codex-acp", modelID: "gpt-5.5" },
      }),
    })

    expect(res.status).toBe(201)
    expect(calls).toEqual(["setModel:gpt-5.5", "createSession"])
  })

  it("passes session context into resolveDirectory for detail routes", async () => {
    const directory = process.cwd()
    const calls: Array<{ sessionId?: string }> = []
    const app = createSessionRoutes({
      resolveAdapter: async () => adapter({}),
      resolveDirectory: async (_c, input) => {
        calls.push({ sessionId: input?.sessionId })
        return directory
      },
      sessionBus: {
        publish() {},
        subscribe() {
          return () => {}
        },
      },
      publishGlobal() {},
    })

    const res = await app.request("http://localhost/session/s1")
    expect(res.status).toBe(200)
    expect(calls).toEqual([{ sessionId: "s1" }])
  })

  it("returns structured session not-found errors", async () => {
    const directory = process.cwd()
    const app = createSessionRoutes({
      resolveAdapter: async () => ({
        ...adapter({}),
        getSession: async () => null,
        updateSession: async () => null,
      }),
      resolveDirectory: async () => directory,
      sessionBus: {
        publish() {},
        subscribe() {
          return () => {}
        },
      },
      publishGlobal() {},
    })

    for (const request of [
      new Request("http://localhost/session/missing"),
      new Request("http://localhost/session/missing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Missing" }),
      }),
    ]) {
      const res = await app.request(request)
      expect(res.status).toBe(404)
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "session_not_found",
          message: "Session not found",
        },
      })
    }
  })

  it("proxies session status for any adapter with http-proxy capability", async () => {
    const directory = process.cwd()
    const urls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchDouble((async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      urls.push(req.url)
      expect(req.headers.get("x-opencode-directory")).toBe(directory)
      return new Response(JSON.stringify({ status: "proxied" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      })
    }))

    try {
      const app = SessionRoutes(() => ({
        ...adapter({}),
        adapterCapabilities: ["http-proxy"],
        readHarnessCapabilities: () => ({
          harness: "codex",
          abort: true,
          reconnect: false,
          replay: true,
          permissions: true,
          questions: true,
          todos: true,
          commands: false,
          fork: false,
          revert: false,
          unrevert: false,
          configOptions: true,
        }),
        getServerUrl: async () => "http://proxy-capable.test",
        // `http-proxy` is a two-method capability; the double has to satisfy
        // both or it is not the thing the route dispatches through.
        getRequestFn: async () => (async (input: Request) => fetch(input)) as never,
        listSessions: async () => {
          throw new Error("status route should proxy through http-proxy capability")
        },
      } satisfies AgentHarnessAdapter & HttpProxyAdapter))

      const res = await app.request(`http://localhost/session/status?directory=${encodeURIComponent(directory)}`)

      expect(res.status).toBe(202)
      expect(await res.json()).toEqual({ status: "proxied" })
      expect(urls).toEqual(["http://proxy-capable.test/session/status"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("returns the final JSON reply and forwards prompt fields", async () => {
    const directory = process.cwd()
    const seen: Array<{ directory: string; payload: CompatEvent }> = []
    let prompt: PromptInput | undefined
    const eventHub = createRuntimeEventHub()
    const app = SessionRoutes(() =>
      adapter({
        onPrompt(next, dir) {
          prompt = next
          expect(dir).toBe(directory)
        },
        async *sendMessage(id, input, dir) {
          yield messageUpdated(buildUserMessage({
            id: input.userMessageId!,
            sessionID: id,
            agent: input.agent,
            model: input.model,
            ...(input.tools ? { tools: input.tools } : {}),
            ...(input.format ? { format: input.format } : {}),
            ...(input.system ? { system: input.system } : {}),
            ...(input.variant ? { variant: input.variant } : {}),
          }))
          yield messagePartUpdated({
            id: "msg-user-part-0",
            sessionID: id,
            messageID: input.userMessageId!,
            type: "text",
            text: "hello",
          })
          yield messageUpdated(buildAssistantMessage({
            id: input.assistantMessageId,
            sessionID: id,
            parentID: input.userMessageId ?? id,
            agent: input.agent,
            model: input.model,
            directory: dir ?? "",
          }))
          yield messageUpdated(buildAssistantMessage({
            id: "asm-final",
            sessionID: id,
            parentID: input.userMessageId ?? id,
            agent: input.agent,
            model: input.model,
            directory: dir ?? "",
          }))
          yield sessionIdle(id)
        },
        async getMessages(id, dir) {
          return [{
            info: buildUserMessage({
              id: "msg-user",
              sessionID: id,
              agent: "plan",
              model: { providerID: "openai", modelID: "gpt-5.4" },
              system: "sys",
              variant: "fast",
            }),
            parts: [],
          }, {
            info: buildAssistantMessage({
              id: "asm-final",
              sessionID: id,
              parentID: "msg-user",
              agent: "plan",
              model: { providerID: "openai", modelID: "gpt-5.4" },
              directory: dir ?? "",
              completed: Date.now(),
              variant: "fast",
            }),
            parts: [{ id: "p1", sessionID: id, messageID: "asm-final", type: "text", text: "done" }],
          }]
        },
      }), { eventHub })
    const unsub = eventHub.subscribeGlobal((event) => seen.push(event))

    try {
      const res = await app.request(`http://localhost/session/s1/message?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageID: "msg-user",
          agent: "plan",
          model: { providerID: "openai", modelID: "gpt-5.4" },
          parts: [{ type: "text", text: "hello" }],
          tools: { bash: true },
          format: { type: "json_schema", schema: { type: "object" } },
          system: "sys",
          variant: "fast",
        }),
      })

      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("application/json")
      expect(prompt).toMatchObject({
        userMessageId: "msg-user",
        agent: "plan",
        model: { providerID: "openai", modelID: "gpt-5.4" },
        tools: { bash: true },
        format: { type: "json_schema" },
        system: "sys",
        variant: "fast",
      })
      expect(await res.json()).toMatchObject({
        info: { id: "asm-final", role: "assistant", agent: "plan", variant: "fast" },
        parts: [{ type: "text", text: "done" }],
      })
      expect(seen.map((row) => row.payload.type)).toEqual([
        "message.updated",
        "message.part.updated",
        "message.updated",
        "message.updated",
        "session.idle",
      ])
      expect(seen[1]?.payload).toMatchObject({
        type: "message.part.updated",
        properties: {
          part: {
            messageID: "msg-user",
            type: "text",
            text: "hello",
          },
        },
      })
    } finally {

    }
  })

  it("returns a synthetic error reply when the sync message stream throws", async () => {
    const directory = process.cwd()
    const seen: string[] = []
    const eventHub = createRuntimeEventHub()
    const app = createSessionRoutes({
      resolveAdapter: () => adapter({
        async *sendMessage() {
          throw new Error("adapter unavailable")
        },
      }),
      resolveDirectory: () => directory,
      sessionBus: { publish() {}, subscribe: () => () => {} },
      publishGlobal: (event) => {
        seen.push(event.payload.type)
        eventHub.publishGlobal(event)
      },
    })

    const res = await app.request(`http://localhost/session/s1/message?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageID: "msg-user",
        parts: [{ type: "text", text: "hello" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      info: {
        role: "assistant",
        error: { data: { message: "adapter unavailable" } },
      },
      parts: [],
    })
    expect(seen).toContain("session.error")
  })

  it("returns and checkpoints a completed turn when document flushing fails", async () => {
    const directory = process.cwd()
    const checkpoints: unknown[][] = []
    const error = spyOn(console, "error").mockImplementation(() => {})
    const messages = [{
      info: buildAssistantMessage({
        id: "asm-final",
        sessionID: "s1",
        parentID: "msg-user",
        agent: "plan",
        model: { providerID: "openai", modelID: "gpt-5.4" },
        directory,
        completed: Date.now(),
      }),
      parts: [{ id: "p1", sessionID: "s1", messageID: "asm-final", type: "text", text: "done" }],
    }]
    const app = createSessionRoutes({
      resolveAdapter: () => adapter({
        async *sendMessage(id) {
          yield sessionIdle(id)
        },
        getMessages: () => messages,
      }),
      resolveDirectory: () => directory,
      sessionBus: { publish() {}, subscribe: () => () => {} },
      publishGlobal() {},
      flushSessionDocuments: async () => { throw new Error("write-back unavailable") },
      afterMessageCheckpoint: (_c, _directory, _sessionId, next) => { checkpoints.push(next) },
    })

    try {
      const response = await app.request(`http://localhost/session/s1/message?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageID: "msg-user", parts: [{ type: "text", text: "hello" }] }),
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        info: { id: "asm-final", role: "assistant" },
        parts: [{ type: "text", text: "done" }],
      })
      expect(checkpoints).toEqual([messages])
      expect(error).toHaveBeenCalledWith("[runtime-document] end-of-turn write-back failed for s1:", expect.any(Error))
    } finally {
      error.mockRestore()
    }
  })

  it("defaults message model fields from session config when the request omits them", async () => {
    const directory = process.cwd()
    let prompt: PromptInput | undefined
    const app = SessionRoutes(() =>
      adapter({
        onPrompt(next, dir) {
          prompt = next
          expect(dir).toBe(directory)
        },
        async *sendMessage(id, input, dir) {
          yield messageUpdated(buildAssistantMessage({
            id: input.assistantMessageId,
            sessionID: id,
            parentID: input.userMessageId ?? id,
            agent: input.agent,
            model: input.model,
            directory: dir ?? "",
            ...(input.variant ? { variant: input.variant } : {}),
          }))
          yield sessionIdle(id)
        },
        async getMessages(id, dir) {
          return [{
            info: buildAssistantMessage({
              id: "asm-final",
              sessionID: id,
              parentID: "msg-user",
              agent: "plan",
              model: { providerID: "openai", modelID: "gpt-5.4" },
              directory: dir ?? "",
              completed: Date.now(),
              variant: "fast",
            }),
            parts: [{ id: "p1", sessionID: id, messageID: "asm-final", type: "text", text: "done" }],
          }]
        },
      }))

    const res = await app.request(`http://localhost/session/s1/message?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageID: "msg-user",
        parts: [{ type: "text", text: "hello" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(prompt).toMatchObject({
      userMessageId: "msg-user",
      agent: "plan",
      model: { providerID: "openai", modelID: "gpt-5.4" },
      variant: "fast",
    })
  })

  it("returns a synthetic error reply when no final assistant message exists", async () => {
    const directory = process.cwd()
    const app = SessionRoutes(() =>
      adapter({
        async *sendMessage(id, input, dir) {
          yield messageUpdated(buildAssistantMessage({
            id: input.assistantMessageId,
            sessionID: id,
            parentID: input.userMessageId ?? id,
            agent: input.agent,
            model: input.model,
            directory: dir ?? "",
          }))
          yield sessionError("boom", id)
        },
        async getMessages() {
          return []
        },
      }))

    const res = await app.request(`http://localhost/session/s1/message?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageID: "msg-user",
        parts: [{ type: "text", text: "hello" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      info: {
        role: "assistant",
        error: {
          name: "UnknownError",
          data: { message: "boom" },
        },
      },
      parts: [],
    })
  })

  it("updates session via PATCH", async () => {
    const directory = process.cwd()
    const app = SessionRoutes(() =>
      adapter({
      }))

    const res = await app.request(`http://localhost/session/s1?directory=${encodeURIComponent(directory)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Updated Title" }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { id: string; title: string }
    expect(body.id).toBe("s1")
    expect(body.title).toBe("Updated Title")
  })

  it("returns 404 for PATCH on non-existent session", async () => {
    const directory = process.cwd()
    const app = SessionRoutes(() => ({
      ...adapter({}),
      updateSession: async () => null,
    }))

    const res = await app.request(`http://localhost/session/missing?directory=${encodeURIComponent(directory)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Nope" }),
    })

    expect(res.status).toBe(404)
  })

  it("gets session config", async () => {
    const directory = process.cwd()
    const app = SessionRoutes(() => adapter({}))

    const res = await app.request(`http://localhost/session/s1/config?directory=${encodeURIComponent(directory)}`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      harness: { id: "opencode", access: "native" },
      model: { providerID: "openai", modelID: "gpt-5.4" },
      variant: "fast",
      agent: "plan",
    })
  })

  it("returns harness capabilities for global and session-specific adapters", async () => {
    const directory = process.cwd()
    const app = createSessionRoutes({
      resolveAdapter: async (_c, input) => ({
        ...adapter({}),
        readHarnessCapabilities: () => ({
          harness: input?.sessionId ? "codex" : "opencode",
          abort: true,
          reconnect: false,
          replay: true,
          permissions: true,
          questions: !input?.sessionId,
          todos: true,
          commands: !input?.sessionId,
          fork: true,
          revert: !input?.sessionId,
          unrevert: !input?.sessionId,
          configOptions: !!input?.sessionId,
        }),
      }),
      resolveDirectory: async (_c, input) => input?.sessionId ? `${directory}/session` : directory,
      sessionBus: {
        publish() {},
        subscribe() {
          return () => {}
        },
      },
      publishGlobal() {},
    })

    const global = await app.request(`http://localhost/session/capabilities?directory=${encodeURIComponent(directory)}`)
    const session = await app.request(`http://localhost/session/s1/capabilities?directory=${encodeURIComponent(directory)}`)

    expect(global.status).toBe(200)
    expect(await global.json()).toMatchObject({
      harness: "opencode",
      commands: true,
      questions: true,
      configOptions: false,
    })
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({
      harness: "codex",
      commands: false,
      questions: false,
      configOptions: true,
    })
  })

  it("exposes command routes by default and supports central-server opt-out", async () => {
    const directory = process.cwd()
    const commands = [{ name: "review", description: "Review current changes" }]
    const base = {
      resolveDirectory: async () => directory,
      sessionBus: {
        publish() {},
        subscribe() {
          return () => {}
        },
      },
      publishGlobal() {},
    }
    const standalone = createSessionRoutes({
      ...base,
      resolveAdapter: async () => ({
        ...adapter({}),
        listCommands: async () => commands,
      }),
    })
    const central = createSessionRoutes({
      ...base,
      exposeCommandRoute: false,
      resolveAdapter: async () => ({
        ...adapter({}),
        listCommands: async () => {
          throw new Error("central server should not resolve workspace-runtime commands")
        },
      }),
    })

    const standaloneRes = await standalone.request(`http://localhost/command?directory=${encodeURIComponent(directory)}`)
    const centralRes = await central.request(`http://localhost/command?directory=${encodeURIComponent(directory)}`)

    expect(standaloneRes.status).toBe(200)
    expect(await standaloneRes.json()).toEqual(commands)
    expect(centralRes.status).toBe(404)
  })

  it("patches session config", async () => {
    const directory = process.cwd()
    const app = SessionRoutes(() => adapter({}))

    const res = await app.request(`http://localhost/session/s1/config?directory=${encodeURIComponent(directory)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: { providerID: "claude-acp", modelID: "sonnet" },
        variant: "max",
        agent: "build",
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      harness: { id: "opencode", access: "native" },
      model: { providerID: "claude-acp", modelID: "sonnet" },
      variant: "max",
      agent: "build",
    })
  })

  it("allows session config patches to set model for the same harness", async () => {
    const directory = process.cwd()
    const calls: SessionConfigUpdate[] = []
    const app = SessionRoutes(() => ({
      ...adapter({}),
      getSessionConfig: async () => ({
        harness: { id: "codex", access: "native", connection: { kind: "process", binary: "codex" } },
        model: { providerID: "codex", modelID: "default" },
        variant: null,
        agent: "build",
      }),
      updateSessionConfig: async (_id, patch) => {
        calls.push(patch)
        return {
          harness: patch.harness ?? { id: "codex", access: "native" },
          ...(patch.model ? { model: patch.model } : {}),
          variant: patch.variant ?? null,
          agent: patch.agent ?? null,
        }
      },
      readHarnessCapabilities: () => ({
        harness: "codex",
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
      }),
    }))

    const patch = {
      harness: { id: "codex", access: "native", connection: { kind: "process", binary: "codex" } },
      model: { providerID: "codex", modelID: "gpt-5" },
      variant: null,
      agent: "build",
    } satisfies SessionConfigUpdate
    const res = await app.request(`http://localhost/session/s1/config?directory=${encodeURIComponent(directory)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      harness: { id: "codex", access: "native", connection: { kind: "process", binary: "codex" } },
      model: { providerID: "codex", modelID: "gpt-5" },
      variant: null,
      agent: "build",
    })
    expect(calls).toEqual([patch])
  })

  it("can keep session config durable through route-level hooks", async () => {
    const directory = process.cwd()
    const configs = new Map<string, SessionConfig>()
    const app = SessionRoutes(() => adapter({}), {
      getSessionConfig: async ({ adapter, directory, sessionId }) =>
        configs.get(sessionId) ?? await adapter.getSessionConfig(sessionId, directory),
      updateSessionConfig: async ({ sessionId, update }) => {
        const next = {
          harness: update.harness ?? { id: "opencode", access: "native" },
          ...(update.model ? { model: update.model } : {}),
          variant: update.variant ?? null,
          agent: update.agent ?? null,
        } satisfies SessionConfig
        configs.set(sessionId, next)
        return next
      },
    })

    const patch = {
      harness: { id: "opencode", access: "native" },
      model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
      variant: null,
      agent: "build",
    } satisfies SessionConfig
    const update = await app.request(`http://localhost/session/s-opencode/config?directory=${encodeURIComponent(directory)}&runner=opencode`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
    const read = await app.request(`http://localhost/session/s-opencode/config?directory=${encodeURIComponent(directory)}&runner=opencode`)

    expect(update.status).toBe(200)
    expect(read.status).toBe(200)
    expect(await update.json()).toEqual(patch)
    expect(await read.json()).toEqual(patch)
  })

  it("rejects session config harness switches before mutating adapter state", async () => {
    const directory = process.cwd()
    const calls: string[] = []
    const app = SessionRoutes(() => ({
      ...adapter({}),
      updateSessionConfig: async () => {
        calls.push("updateSessionConfig")
        return { harness: { id: "claude", access: "acp" } }
      },
    }))

    const res = await app.request(`http://localhost/session/s1/config?directory=${encodeURIComponent(directory)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness: { id: "claude", access: "acp", connection: { kind: "process", binary: "/tmp/claude-agent-acp" } },
        model: { providerID: "claude-acp", modelID: "sonnet" },
      }),
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      ok: false,
      error: {
        code: "unsupported_operation",
        operation: "harness_switch",
        capability: "session_harness",
        harness: "opencode",
        transport: "opencode",
        reason: "harness_switch_not_supported",
        message: "opencode sessions cannot switch to claude through session config patch",
      },
    })
    expect(calls).toEqual([])
  })

  it("accepts http transport spelling as a session config alias for streamable-http", async () => {
    const directory = process.cwd()
    const calls: SessionConfigUpdate[] = []
    const app = SessionRoutes(() => ({
      ...adapter({}),
      getSessionConfig: async () => ({
        harness: {
          id: "claude",
          access: "acp",
          connection: {
            kind: "remote",
            transport: "streamable-http",
            url: "http://127.0.0.1:7331/acp",
          },
        },
        variant: null,
        agent: null,
      }),
      updateSessionConfig: async (_id, patch) => {
        calls.push(patch)
        return {
          harness: {
            id: "claude",
            access: "acp",
            connection: {
              kind: "remote",
              transport: "streamable-http",
              url: "http://127.0.0.1:7331/acp",
            },
          },
          variant: null,
          agent: null,
        }
      },
    }))

    const patch = {
      harness: {
        id: "claude",
        access: "acp",
        connection: {
          kind: "remote",
          transport: "http",
          url: "http://127.0.0.1:7331/acp",
        },
      },
    } as unknown as SessionConfigUpdate
    const res = await app.request(`http://localhost/session/s1/config?directory=${encodeURIComponent(directory)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })

    expect(res.status).toBe(200)
    expect(calls).toEqual([{
      harness: {
        id: "claude",
        access: "acp",
        connection: {
          kind: "remote",
          transport: "streamable-http",
          url: "http://127.0.0.1:7331/acp",
        },
      },
    }])
  })

  it("returns 204 for prompt_async", async () => {
    const directory = process.cwd()
    let seen = false
    const app = SessionRoutes(() =>
      adapter({
        async *sendMessage(id) {
          seen = true
          yield sessionIdle(id)
        },
      }))

    const res = await app.request(`http://localhost/session/s1/prompt_async?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "hello" }],
      }),
    })

    expect(res.status).toBe(204)
    await Bun.sleep(0)
    expect(seen).toBe(true)
  })

  it("deduplicates exact prompt_async retries while replaying an unsubmitted retry", async () => {
    const directory = process.cwd()
    let executions = 0
    const make = (messages: AgentMessage[] = [], beforeMessages = async () => {}) => SessionRoutes(() =>
      adapter({
        getMessages: async () => {
          await beforeMessages()
          return messages
        },
        async *sendMessage(id) {
          executions++
          yield sessionIdle(id)
        },
      }))
    const request = (app: ReturnType<typeof make>, retry = false) => app.request(
      `http://localhost/session/s1/prompt_async?directory=${encodeURIComponent(directory)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(retry ? { "x-claxedo-idempotency-retry": "1" } : {}),
        },
        body: JSON.stringify({ messageID: "msg-workgraph", parts: [{ type: "text", text: "hello" }] }),
      },
    )

    const live = make()
    expect((await request(live)).status).toBe(204)
    expect((await request(live, true)).status).toBe(204)
    await Bun.sleep(0)
    expect(executions).toBe(1)

    const restored = make([{ info: { id: "msg-workgraph", role: "user" }, parts: [] }])
    expect((await request(restored, true)).status).toBe(204)
    await Bun.sleep(0)
    expect(executions).toBe(1)

    let release!: () => void
    const concurrent = make([], () => new Promise<void>((resolve) => { release = resolve }))
    const first = request(concurrent, true)
    await Bun.sleep(0)
    const second = request(concurrent, true)
    release()
    await Promise.all([first, second])
    await Bun.sleep(0)
    expect(executions).toBe(2)

    const prepared = make()
    expect((await request(prepared, true)).status).toBe(204)
    await Bun.sleep(0)
    expect(executions).toBe(3)
  })

  it("returns structured abort result and publishes recovery status", async () => {
    const directory = process.cwd()
    const seen: CompatEvent[] = []
    const app = createSessionRoutes({
      resolveAdapter: async () => ({
        ...adapter({}),
        // This test specifically exercises the recovery
        // surface; override the default adapter's abort (which
        // returns "cancelled") so the route receives the recovering
        // shape it then publishes through the global bus.
        abort: async () => ({
          ok: false as const,
          status: "recovering" as const,
          message: "ACP session cancellation failed; the agent process was stopped.",
        }),
      }),
      resolveDirectory: async () => directory,
      sessionBus: {
        publish() {},
        subscribe() {
          return () => {}
        },
      },
      publishGlobal(event) {
        seen.push(event.payload)
      },
    })

    const res = await app.request(`http://localhost/session/s1/abort?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: false,
      status: "recovering",
      message: "ACP session cancellation failed; the agent process was stopped.",
    })
    expect(seen).toEqual([{
      id: "session.status:s1",
      type: "session.status",
      properties: {
        sessionID: "s1",
        status: {
          type: "recovering",
          kind: "process_restart",
          message: "ACP session cancellation failed; the agent process was stopped.",
        },
      },
    }])
  })

  it("returns typed unsupported operation failures from harness capabilities", async () => {
    const directory = process.cwd()
    const calls: string[] = []
    const app = SessionRoutes(() => ({
      ...adapter({}),
      readHarnessCapabilities: () => ({
        harness: "claude",
        abort: false,
        reconnect: false,
        replay: true,
        permissions: false,
        questions: false,
        todos: true,
        commands: false,
        fork: false,
        revert: false,
        unrevert: false,
        configOptions: true,
      }),
      abort: async () => {
        calls.push("abort")
        return { ok: true as const, status: "cancelled" as const }
      },
      revert: async () => {
        calls.push("revert")
      },
      unrevert: async () => {
        calls.push("unrevert")
      },
      forkSession: async () => {
        calls.push("fork")
        return { id: "forked" }
      },
      executeCommand: async () => {
        calls.push("command")
      },
      respondPermission: async () => {
        calls.push("permission")
      },
      replyQuestion: async () => {
        calls.push("question.reply")
      },
      rejectQuestion: async () => {
        calls.push("question.reject")
      },
    }))

    for (const item of [
      { method: "POST", path: "/session/s1/abort", operation: "abort" },
      { method: "POST", path: "/session/s1/revert", operation: "revert" },
      { method: "POST", path: "/session/s1/unrevert", operation: "unrevert" },
      { method: "POST", path: "/session/s1/fork", operation: "fork", body: { messageId: "m1" } },
      { method: "POST", path: "/session/s1/command", operation: "command", body: { command: "review" } },
      { method: "POST", path: "/session/s1/permissions/p1", operation: "permission_response", body: { response: "once" } },
      { method: "POST", path: "/question/q1/reply", operation: "question_response", body: { answer: "yes" } },
      { method: "POST", path: "/question/q1/reject", operation: "question_response" },
    ]) {
      const url = new URL(`http://localhost${item.path}`)
      url.searchParams.set("directory", directory)
      url.searchParams.set("sessionId", "s1")
      const res = await app.request(url.toString(), {
        method: item.method,
        headers: { "Content-Type": "application/json" },
        ...(item.body ? { body: JSON.stringify(item.body) } : {}),
      })

      expect(res.status, item.path).toBe(409)
      await expect(res.json()).resolves.toEqual({
        ok: false,
        error: {
          code: "unsupported_operation",
          operation: item.operation,
          capability: item.operation === "command"
            ? "commands"
            : item.operation === "permission_response"
            ? "permissions"
            : item.operation === "question_response"
            ? "questions"
            : item.operation,
          harness: "claude",
          transport: "claude",
          reason: "capability_disabled",
          message: `claude does not support ${item.operation}`,
        },
      })
    }
    expect(calls).toEqual([])
  })

  it("keeps supported OpenCode session operations on the existing success path", async () => {
    const directory = process.cwd()
    const calls: string[] = []
    const app = SessionRoutes(() => ({
      ...adapter({}),
      revert: async () => {
        calls.push("revert")
      },
    }))

    const res = await app.request(`http://localhost/session/s1/revert?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
    expect(calls).toEqual(["revert"])
  })

  it("does not sync created sessions to the control plane from workspace runtime", async () => {
    const directory = process.cwd()
    const seen: string[] = []
    const prevUrl = process.env.CLAXEDO_CONTROL_PLANE_URL
    const prevWorkspaceId = process.env.WORKSPACE_RUNTIME_WORKSPACE_ID
    const original = globalThis.fetch
    process.env.CLAXEDO_CONTROL_PLANE_URL = "http://control.test"
    process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = "ws_runtime"
    globalThis.fetch = fetchDouble((async (input) => {
      seen.push(typeof input === "string" ? input : input instanceof Request ? input.url : String(input))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }))

    try {
      const app = SessionRoutes(() => ({
        ...adapter({}),
        createSession: async () => ({ id: "session-created" }),
      }))

      const res = await app.request(`http://localhost/session?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Created" }),
      })

      expect(res.status).toBe(201)
      await Bun.sleep(25)
      expect(seen).toEqual([])
    } finally {
      globalThis.fetch = original
      process.env.CLAXEDO_CONTROL_PLANE_URL = prevUrl
      process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = prevWorkspaceId
    }
  })

  it("does not sync session messages to the control plane on passive reads", async () => {
    const directory = process.cwd()
    const seen: Array<{ url: string; body: string | undefined }> = []
    const prevUrl = process.env.CLAXEDO_CONTROL_PLANE_URL
    const prevWorkspaceId = process.env.WORKSPACE_RUNTIME_WORKSPACE_ID
    const original = globalThis.fetch
    process.env.CLAXEDO_CONTROL_PLANE_URL = "http://control.test"
    process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = "ws_runtime"
    globalThis.fetch = fetchDouble((async (input, init) => {
      seen.push({
        url: typeof input === "string" ? input : input instanceof Request ? input.url : String(input),
        body: typeof init?.body === "string" ? init.body : undefined,
      })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }))

    try {
      const app = SessionRoutes(() =>
        adapter({
          getMessages: () => [{
            info: { id: "msg-1", role: "user" },
            parts: [{ type: "text", text: "hello" }],
          }],
        }),
      )

      const res = await app.request(`http://localhost/session/s1/message?directory=${encodeURIComponent(directory)}`)

      expect(res.status).toBe(200)
      await Bun.sleep(25)
      expect(seen).toHaveLength(0)
    } finally {
      globalThis.fetch = original
      process.env.CLAXEDO_CONTROL_PLANE_URL = prevUrl
      process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = prevWorkspaceId
    }
  })

  it("does not sync full session messages to the control plane after prompt completion", async () => {
    const directory = process.cwd()
    const seen: string[] = []
    const prevUrl = process.env.CLAXEDO_CONTROL_PLANE_URL
    const prevWorkspaceId = process.env.WORKSPACE_RUNTIME_WORKSPACE_ID
    const original = globalThis.fetch
    process.env.CLAXEDO_CONTROL_PLANE_URL = "http://control.test"
    process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = "ws_runtime"
    globalThis.fetch = fetchDouble((async (input) => {
      seen.push(typeof input === "string" ? input : input instanceof Request ? input.url : String(input))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }))

    try {
      const app = SessionRoutes(() =>
        adapter({
          getMessages: () => [{
            info: { id: "msg-1", role: "user" },
            parts: [{ type: "text", text: "hello" }],
          }],
        }),
      )

      const res = await app.request(`http://localhost/session/s1/message?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "hello" }] }),
      })

      expect(res.status).toBe(200)
      await Bun.sleep(25)
      expect(seen).toEqual([])
    } finally {
      globalThis.fetch = original
      process.env.CLAXEDO_CONTROL_PLANE_URL = prevUrl
      process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = prevWorkspaceId
    }
  })

  it("bridges terminal runtime lifecycle events to workspaceRuntimeBus once", async () => {
    const directory = process.cwd()
    const lifecycle: Extract<WorkspaceRuntimeEvent, { type: "agent.lifecycle" }>[] = []
    const unsubscribe = workspaceRuntimeBus.subscribe((event) => {
      if (event.type === "agent.lifecycle" && event.sessionId === "s1") lifecycle.push(event)
    })

    try {
      const app = SessionRoutes(() =>
        adapter({
          async *sendMessage(id) {
            yield sessionStatus(id, { type: "busy" })
            yield sessionIdle(id)
          },
        }),
      )

      const res = await app.request(`http://localhost/session/s1/message?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [],
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
          variant: "default",
        }),
      })

      expect(res.status).toBe(200)
      expect(lifecycle.map((event) => event.eventType)).toEqual(["Busy", "Idle"])
      expect(lifecycle.map((event) => event.tabId)).toEqual(["s1", "s1"])
      expect(lifecycle.map((event) => event.workspaceId)).toEqual([expect.any(String), expect.any(String)])
    } finally {
      unsubscribe()
    }
  })

  it("forwards session.updated to workspaceRuntimeBus exactly once", async () => {
    const directory = process.cwd()
    const previousWorkspaceId = process.env.WORKSPACE_RUNTIME_WORKSPACE_ID
    process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = "ws_title_updates"
    const update = sessionUpdated(buildSession({
      id: "s1",
      directory,
      title: "Prompt-derived title",
      created: 10,
      updated: 20,
    }))
    const events: Extract<WorkspaceRuntimeEvent, { type: "session.updated" }>[] = []
    const unsubscribe = workspaceRuntimeBus.subscribe((event) => {
      if (event.type === "session.updated" && (event.properties as { info?: { id?: string } } | undefined)?.info?.id === "s1") {
        events.push(event)
      }
    })

    try {
      const app = SessionRoutes(() => adapter({
        async *sendMessage() {
          yield update
        },
      }))
      const res = await app.request(`http://localhost/session/s1/message?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [] }),
      })

      expect(res.status).toBe(200)
      expect(events).toEqual([{
        type: "session.updated",
        directory,
        workspaceId: "ws_title_updates",
        properties: update.properties,
      }])
    } finally {
      unsubscribe()
      process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = previousWorkspaceId
    }
  })

  it("streams workspaceRuntimeBus process events on the documented compatibility event route", async () => {
    const app = SessionRoutes(() => adapter({}))
    const res = await app.request("http://localhost/event")
    expect(res.status).toBe(200)
    expect(res.body).toBeTruthy()

    const reader = res.body!.getReader()
    workspaceRuntimeBus.publish({ type: "process.status", directory: "/work", configId: "proc_1", status: "running" })

    try {
      const chunk = await reader.read()
      expect(new TextDecoder().decode(chunk.value)).toContain(
        'data: {"type":"process.status","directory":"/work","configId":"proc_1","status":"running"}',
      )
    } finally {
      await reader.cancel().catch(() => {})
    }
  })

  it("does not contact the control plane before returning local responses", async () => {
    const directory = process.cwd()
    let calls = 0
    const prevUrl = process.env.CLAXEDO_CONTROL_PLANE_URL
    const prevWorkspaceId = process.env.WORKSPACE_RUNTIME_WORKSPACE_ID
    const original = globalThis.fetch
    process.env.CLAXEDO_CONTROL_PLANE_URL = "http://control.test"
    process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = "ws_runtime"
    globalThis.fetch = fetchDouble((async () => {
      calls++
      await new Promise(() => {})
      return new Response("unreachable")
    }))

    try {
      const app = SessionRoutes(() => ({
        ...adapter({}),
        createSession: async () => ({ id: "session-created" }),
      }))

      const result = await Promise.race([
        app.request(`http://localhost/session?directory=${encodeURIComponent(directory)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Created" }),
        }),
        Bun.sleep(25).then(() => "timed out" as const),
      ])

      expect(result).not.toBe("timed out")
      expect((result as Response).status).toBe(201)
      await Bun.sleep(25)
      expect(calls).toBe(0)
    } finally {
      globalThis.fetch = original
      process.env.CLAXEDO_CONTROL_PLANE_URL = prevUrl
      process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = prevWorkspaceId
    }
  })

  it("publishes initial user parts for prompt_async", async () => {
    const directory = process.cwd()
    const seen: CompatEvent[] = []
    const app = createSessionRoutes({
      resolveAdapter: async () =>
        adapter({
          async *sendMessage(id, input, dir) {
            yield messageUpdated(buildUserMessage({
              id: input.userMessageId ?? "msg-user",
              sessionID: id,
              agent: input.agent,
              model: input.model,
            }))
            yield messagePartUpdated({
              id: "msg-user-part-0",
              sessionID: id,
              messageID: input.userMessageId ?? "msg-user",
              type: "text",
              text: "hello",
            })
            yield messageUpdated(buildAssistantMessage({
              id: input.assistantMessageId,
              sessionID: id,
              parentID: input.userMessageId ?? id,
              agent: input.agent,
              model: input.model,
              directory: dir ?? "",
            }))
            yield sessionIdle(id)
          },
        }),
      resolveDirectory: async () => directory,
      sessionBus: {
        publish() {},
        subscribe() {
          return () => {}
        },
      },
      publishGlobal(event) {
        seen.push(event.payload)
      },
    })

    const res = await app.request(`http://localhost/session/s1/prompt_async?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageID: "msg-user",
        parts: [{ type: "text", text: "hello" }],
      }),
    })

    expect(res.status).toBe(204)
    await Bun.sleep(0)
    expect(seen.map((row) => row.type)).toEqual([
      "message.updated",
      "message.part.updated",
      "message.updated",
      "session.idle",
    ])
    expect(seen[1]).toMatchObject({
      type: "message.part.updated",
      properties: {
        part: {
          messageID: "msg-user",
          type: "text",
          text: "hello",
        },
      },
    })
  })

  it("publishes question reply with the pending question session id", async () => {
    const directory = process.cwd()
    const seen: CompatEvent[] = []
    const app = createSessionRoutes({
      resolveAdapter: async () => ({
        ...adapter({}),
        listQuestions: async () => [{ id: "q1", sessionID: "s1", questions: [] }],
      }),
      resolveDirectory: async () => directory,
      sessionBus: {
        publish() {},
        subscribe() {
          return () => {}
        },
      },
      publishGlobal(event) {
        seen.push(event.payload)
      },
    })

    const res = await app.request(`http://localhost/question/q1/reply?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "Continue" }),
    })

    expect(res.status).toBe(200)
    expect(seen).toEqual([{
      id: "question.replied:q1",
      type: "question.replied",
      properties: {
        sessionID: "s1",
        requestID: "q1",
        answers: [["Continue"]],
      },
    }])
  })

  it("publishes question reject with the pending question session id", async () => {
    const directory = process.cwd()
    const seen: CompatEvent[] = []
    const app = createSessionRoutes({
      resolveAdapter: async () => ({
        ...adapter({}),
        listQuestions: async () => [{ id: "q1", sessionID: "s1", questions: [] }],
      }),
      resolveDirectory: async () => directory,
      sessionBus: {
        publish() {},
        subscribe() {
          return () => {}
        },
      },
      publishGlobal(event) {
        seen.push(event.payload)
      },
    })

    const res = await app.request(`http://localhost/question/q1/reject?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })

    expect(res.status).toBe(200)
    expect(seen).toEqual([{
      id: "question.rejected:q1",
      type: "question.rejected",
      properties: {
        sessionID: "s1",
        requestID: "q1",
      },
    }])
  })

  // `?sessionId=` is optional on the question routes, so gating admission on it
  // let any caller reach replyQuestion/rejectQuestion by simply leaving it off.
  it("admits question replies and rejections on the resolved session when sessionId is omitted", async () => {
    for (const path of ["/question/q1/reply", "/question/q1/reject"]) {
      const directory = process.cwd()
      const admissions: { sessionId: string; operation: string }[] = []
      const calls: string[] = []
      const app = createSessionRoutes({
        resolveAdapter: async () => ({
          ...adapter({}),
          listQuestions: async () => [{ id: "q1", sessionID: "s1", questions: [] }],
          replyQuestion: async () => {
            calls.push("reply")
          },
          rejectQuestion: async () => {
            calls.push("reject")
          },
        }),
        resolveDirectory: async () => directory,
        listQuestions: async () => [{ id: "q1", sessionID: "s1", questions: [] }],
        beforeSessionOperation: (_c, input) => {
          admissions.push(input)
          return new Response(JSON.stringify({ ok: false, error: { code: "session_not_admitted" } }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          })
        },
        sessionBus: {
          publish() {},
          subscribe() {
            return () => {}
          },
        },
        publishGlobal() {},
      })

      const res = await app.request(`http://localhost${path}?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "Continue" }),
      })

      expect(res.status, path).toBe(403)
      await expect(res.json()).resolves.toEqual({ ok: false, error: { code: "session_not_admitted" } })
      expect(admissions, path).toEqual([{ sessionId: "s1", operation: "question_response" }])
      expect(calls, path).toEqual([])
    }
  })

  // When neither the query param nor the host listing names the session, only
  // the adapter can. Admission still has to happen before the reply lands.
  it("admits question replies on a session only the adapter listing knows", async () => {
    const directory = process.cwd()
    const admissions: { sessionId: string; operation: string }[] = []
    const calls: string[] = []
    const app = createSessionRoutes({
      resolveAdapter: async () => ({
        ...adapter({}),
        listQuestions: async () => [{ id: "q1", sessionID: "s-from-adapter", questions: [] }],
        replyQuestion: async () => {
          calls.push("reply")
        },
      }),
      resolveDirectory: async () => directory,
      beforeSessionOperation: (_c, input) => {
        admissions.push(input)
        return new Response(JSON.stringify({ ok: false }), { status: 403, headers: { "Content-Type": "application/json" } })
      },
      sessionBus: {
        publish() {},
        subscribe() {
          return () => {}
        },
      },
      publishGlobal() {},
    })

    const res = await app.request(`http://localhost/question/q1/reply?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "Continue" }),
    })

    expect(res.status).toBe(403)
    expect(admissions).toEqual([{ sessionId: "s-from-adapter", operation: "question_response" }])
    expect(calls).toEqual([])
  })

  it("admits question replies on the explicit sessionId when one is supplied", async () => {
    const directory = process.cwd()
    const admissions: { sessionId: string; operation: string }[] = []
    let resolvedAdapters = 0
    const app = createSessionRoutes({
      resolveAdapter: async () => {
        resolvedAdapters += 1
        return adapter({})
      },
      resolveDirectory: async () => directory,
      beforeSessionOperation: (_c, input) => {
        admissions.push(input)
      },
      sessionBus: {
        publish() {},
        subscribe() {
          return () => {}
        },
      },
      publishGlobal() {},
    })

    const res = await app.request(
      `http://localhost/question/q1/reply?directory=${encodeURIComponent(directory)}&sessionId=s9`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "Continue" }),
      },
    )

    expect(res.status).toBe(200)
    expect(admissions).toEqual([{ sessionId: "s9", operation: "question_response" }])
    expect(resolvedAdapters).toBe(1)
  })

  // Resolving an adapter can construct one on the host, so a caller the guard
  // turns away must not reach that when the session is already known.
  it("does not resolve an adapter for a rejected question reply", async () => {
    const directory = process.cwd()
    let resolvedAdapters = 0
    const app = createSessionRoutes({
      resolveAdapter: async () => {
        resolvedAdapters += 1
        return adapter({})
      },
      resolveDirectory: async () => directory,
      beforeSessionOperation: () =>
        new Response(JSON.stringify({ ok: false }), { status: 403, headers: { "Content-Type": "application/json" } }),
      sessionBus: {
        publish() {},
        subscribe() {
          return () => {}
        },
      },
      publishGlobal() {},
    })

    const explicit = await app.request(
      `http://localhost/question/q1/reply?directory=${encodeURIComponent(directory)}&sessionId=s9`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer: "x" }) },
    )
    expect(explicit.status).toBe(403)
    expect(resolvedAdapters).toBe(0)
  })
})
