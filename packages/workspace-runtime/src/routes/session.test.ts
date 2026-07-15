import { describe, expect, it } from "bun:test"
import type {
  AgentRuntimeStreamEvent,
  PromptInput,
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
  type CompatEvent,
} from "../compat-events"
import { createRuntimeEventHub } from "../runtime-event-hub"
import { workspaceRuntimeBus, type WorkspaceRuntimeEvent } from "../bus"
import { createSessionRoutes } from "./session-core"
import { SessionRoutes } from "./session"

function adapter(input: {
  onPrompt?: (prompt: PromptInput, directory: string) => void
  sendMessage?: (id: string, prompt: PromptInput, directory: string) => AsyncIterable<AgentRuntimeStreamEvent>
  getMessages?: (id: string, directory: string) => Promise<unknown[]> | unknown[]
}): AgentHarnessAdapter {
  return {
    listSessions: async () => [],
    getSession: async (id, directory) => buildSession({ id, directory, title: "Demo" }),
    createSession: async () => ({ id: "s1" }),
    updateSession: async (id, updates, directory) => buildSession({ id, directory, title: updates.title ?? "Demo" }),
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
        getSession: async () => undefined,
        updateSession: async () => undefined,
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
    globalThis.fetch = (async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      urls.push(req.url)
      expect(req.headers.get("x-opencode-directory")).toBe(directory)
      return new Response(JSON.stringify({ status: "proxied" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

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
            directory: dir,
          }))
          yield messageUpdated(buildAssistantMessage({
            id: "asm-final",
            sessionID: id,
            parentID: input.userMessageId ?? id,
            agent: input.agent,
            model: input.model,
            directory: dir,
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
              directory: dir,
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
            directory: dir,
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
              directory: dir,
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
            directory: dir,
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
    const make = (messages: unknown[] = [], beforeMessages = async () => {}) => SessionRoutes(() =>
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
    globalThis.fetch = (async (input) => {
      seen.push(typeof input === "string" ? input : input.url)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch

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
    globalThis.fetch = (async (input, init) => {
      seen.push({
        url: typeof input === "string" ? input : input.url,
        body: typeof init?.body === "string" ? init.body : undefined,
      })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch

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
    globalThis.fetch = (async (input) => {
      seen.push(typeof input === "string" ? input : input.url)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch

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
    const lifecycle: WorkspaceRuntimeEvent[] = []
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
    globalThis.fetch = (async () => {
      calls++
      await new Promise(() => {})
      return new Response("unreachable")
    }) as typeof fetch

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
              directory: dir,
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
})
