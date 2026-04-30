import { describe, expect, it } from "bun:test"
import type { AgentAdapter, PromptInput, SessionConfig } from "../adapters/index"
import {
  buildAssistantMessage,
  buildSession,
  buildUserMessage,
  messageUpdated,
  sessionError,
  sessionIdle,
  type CompatEvent,
} from "../compat-events"
import { subscribeGlobalEvents } from "../global-event-bus"
import { createSessionRoutes } from "./session-core"
import { SessionRoutes } from "./session"

function adapter(input: {
  sendMessage?: (id: string, prompt: PromptInput, directory: string) => AsyncIterable<CompatEvent>
  getMessages?: (id: string, directory: string) => Promise<unknown[]>
  onPrompt?: (prompt: PromptInput, directory: string) => void
}): AgentAdapter {
  return {
    listSessions: async () => [],
    getSession: async (id, directory) => buildSession({ id, directory, title: "Demo" }),
    createSession: async () => ({ id: "s1" }),
    updateSession: async (id, updates, directory) => buildSession({ id, directory, title: updates.title ?? "Demo" }),
    getSessionConfig: async () => ({
      runner: { type: "opencode" },
      model: { providerID: "openai", modelID: "gpt-5.4" },
      variant: "fast",
      agent: "plan",
    }),
    updateSessionConfig: async (_id, patch) => ({
      runner: patch.runner ?? { type: "opencode" },
      ...(patch.model ? { model: patch.model } : {}),
      variant: patch.variant ?? null,
      agent: patch.agent ?? null,
    } satisfies SessionConfig),
    deleteSession: async () => {},
    sendMessage(id, prompt, directory) {
      input.onPrompt?.(prompt, directory)
      return input.sendMessage?.(id, prompt, directory) ?? (async function* () {})()
    },
    getMessages: async (id, directory) => input.getMessages?.(id, directory) ?? [],
    abort: async () => ({ ok: true, status: "cancelled" }),
    revert: async () => {},
    unrevert: async () => {},
    forkSession: async () => ({ id: "fork" }),
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

  it("returns the final JSON reply and forwards prompt fields", async () => {
    const directory = process.cwd()
    const seen: Array<{ directory: string; payload: CompatEvent }> = []
    let prompt: PromptInput | undefined
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
      }))
    const unsub = subscribeGlobalEvents((event) => seen.push(event))

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
        "message.part.updated",
        "message.updated",
        "message.updated",
        "message.updated",
        "session.idle",
      ])
      expect(seen[0]?.payload).toMatchObject({
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
      unsub()
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
      runner: { type: "opencode" },
      model: { providerID: "openai", modelID: "gpt-5.4" },
      variant: "fast",
      agent: "plan",
    })
  })

  it("patches session config", async () => {
    const directory = process.cwd()
    const app = SessionRoutes(() => adapter({}))

    const res = await app.request(`http://localhost/session/s1/config?directory=${encodeURIComponent(directory)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runner: { type: "claude-acp", binary: "/tmp/claude-agent-acp" },
        model: { providerID: "claude-acp", modelID: "sonnet" },
        variant: "max",
        agent: "build",
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      runner: { type: "claude-acp", binary: "/tmp/claude-agent-acp" },
      model: { providerID: "claude-acp", modelID: "sonnet" },
      variant: "max",
      agent: "build",
    })
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

  it("returns structured abort result and publishes recovery status", async () => {
    const directory = process.cwd()
    const seen: CompatEvent[] = []
    const app = createSessionRoutes({
      resolveAdapter: async () => ({
        ...adapter({}),
        abort: async () => ({
          ok: false,
          status: "recovering",
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

  it("syncs created sessions to the control plane when configured", async () => {
    const directory = process.cwd()
    const seen: Array<{ url: string; method: string; body: string | undefined }> = []
    const prevUrl = process.env.CLAXEDO_CONTROL_PLANE_URL
    const prevWorkspaceId = process.env.CLAXEDO_WR_WORKSPACE_ID
    const original = globalThis.fetch
    process.env.CLAXEDO_CONTROL_PLANE_URL = "http://control.test"
    process.env.CLAXEDO_WR_WORKSPACE_ID = "ws_runtime"
    globalThis.fetch = (async (input, init) => {
      seen.push({
        url: typeof input === "string" ? input : input.url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      })
      return new Response(JSON.stringify([{ result: { data: { json: { ok: true } } } }]), { status: 200 })
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
      expect(seen).toHaveLength(1)
      expect(seen[0]?.url).toContain("http://control.test/api/control/trpc/session.sync")
      expect(seen[0]?.method).toBe("POST")
      expect(seen[0]?.body).toContain("ws_runtime")
      expect(seen[0]?.body).toContain("session-created")
    } finally {
      globalThis.fetch = original
      process.env.CLAXEDO_CONTROL_PLANE_URL = prevUrl
      process.env.CLAXEDO_WR_WORKSPACE_ID = prevWorkspaceId
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
      "message.part.updated",
      "message.updated",
      "message.updated",
      "session.idle",
    ])
    expect(seen[0]).toMatchObject({
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
      type: "question.rejected",
      properties: {
        sessionID: "s1",
        requestID: "q1",
      },
    }])
  })
})
