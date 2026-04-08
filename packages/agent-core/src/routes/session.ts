import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import type { AgentAdapter, PromptInput } from "../../../workspace-runtime/src/adapters/index"
import {
  buildAssistantMessage,
  permissionReplied,
  sessionError,
  withDir,
  type CompatEnvelope,
  type CompatEvent,
} from "../../../workspace-runtime/src/compat-events"

type SessionBus = {
  publish: (event: unknown) => void
  subscribe: (fn: (event: unknown) => void) => () => void
}

type Ctx = {
  req: {
    query: (k: string) => string | undefined
    header: (k: string) => string | undefined
    param: (k: string) => string
    json: () => Promise<unknown>
  }
}

type Opts = {
  resolveAdapter: (c: Ctx) => Promise<AgentAdapter> | AgentAdapter
  resolveDirectory: (c: Ctx) => Promise<string> | string
  sessionBus: SessionBus
  publishGlobal: (event: CompatEnvelope) => void
}

function mkAssistantId(userMessageId?: string) {
  if (userMessageId) return userMessageId + "_r"
  const ts = Date.now().toString(16)
  const rand = Math.random().toString(36).slice(2, 10)
  return `msg_${ts}${rand}`
}

function normalizeSession(s: unknown): unknown {
  if (!s || typeof s !== "object") return s
  const r = s as Record<string, unknown>
  if (r.time) return r
  const ts = typeof r.created_at === "number" ? r.created_at : Date.now()
  return {
    id: r.id,
    title: r.title ?? null,
    slug: r.id,
    version: "local",
    directory: r.directory ?? "",
    time: { created: ts, updated: ts },
  }
}

function summarizeSession(s: unknown): unknown {
  const row = normalizeSession(s)
  if (!row || typeof row !== "object") return row
  const item = row as Record<string, unknown>
  return {
    id: item.id,
    title: item.title ?? null,
    time: item.time ?? {
      created: Date.now(),
      updated: Date.now(),
    },
    directory: item.directory ?? "",
  }
}

type PromptBody = {
  parts?: unknown[]
  messageID?: string
  agent?: string
  model?: { providerID?: string; modelID?: string }
  tools?: Record<string, boolean>
  format?: PromptInput["format"]
  system?: string
  variant?: string
}

function prompt(body: PromptBody): PromptInput {
  return {
    parts: body.parts ?? [],
    userMessageId: body.messageID,
    assistantMessageId: mkAssistantId(body.messageID),
    agent: body.agent ?? "general",
    model: {
      providerID: body.model?.providerID ?? "anthropic",
      modelID: body.model?.modelID ?? "claude-sonnet-4-6",
    },
    ...(body.tools ? { tools: body.tools } : {}),
    ...(body.format ? { format: body.format } : {}),
    ...(body.system ? { system: body.system } : {}),
    ...(body.variant ? { variant: body.variant } : {}),
  }
}

function isMessage(input: unknown): input is { info: { id: string; role: string }; parts: unknown[] } {
  if (!input || typeof input !== "object") return false
  const info = (input as { info?: unknown }).info
  return !!info && typeof info === "object" && typeof (info as { id?: unknown }).id === "string"
    && typeof (info as { role?: unknown }).role === "string"
}

function failure(input: unknown): string {
  if (!input || typeof input !== "object") return "session error"
  const data = (input as { data?: unknown }).data
  if (!data || typeof data !== "object") return "session error"
  return typeof (data as { message?: unknown }).message === "string"
    ? (data as { message: string }).message
    : "session error"
}

function reply(messages: unknown[], assistantId: string) {
  const rows = messages.filter(isMessage)
  const exact = rows.find((row) => row.info.id === assistantId)
  if (exact) return exact
  return [...rows].reverse().find((row) => row.info.role === "assistant") ?? null
}

export function createSessionRoutes(opts: Opts) {
  return new Hono()
    .get("/session", async (c) => {
      const adapter = await opts.resolveAdapter(c as unknown as Ctx)
      const directory = await opts.resolveDirectory(c as unknown as Ctx)
      const sessions = await adapter.listSessions(directory)
      return c.json((sessions as unknown[]).map(normalizeSession))
    })
    .get("/experimental/session", async (c) => {
      const adapter = await opts.resolveAdapter(c as unknown as Ctx)
      const directory = await opts.resolveDirectory(c as unknown as Ctx)
      const limit = Math.min(Number(c.req.query("limit") ?? "100") || 100, 500)
      const sessions = await adapter.listSessions(directory)
      return c.json((sessions as unknown[])
        .map(summarizeSession)
        .filter((item) => !!item)
        .slice(0, limit))
    })
    .post("/session", async (c) => {
      const adapter = await opts.resolveAdapter(c as unknown as Ctx)
      const directory = await opts.resolveDirectory(c as unknown as Ctx)
      const body = (await c.req.json().catch(() => ({}))) as { title?: string }
      const session = await adapter.createSession(directory, body.title)
      return c.json(normalizeSession(session), 201)
    })
    .get("/session/:id", async (c) => {
      const adapter = await opts.resolveAdapter(c as unknown as Ctx)
      const directory = await opts.resolveDirectory(c as unknown as Ctx)
      const session = await adapter.getSession(c.req.param("id"), directory)
      if (!session) return c.json({ error: "Not found" }, 404)
      return c.json(normalizeSession(session))
    })
    .delete("/session/:id", async (c) => {
      const adapter = await opts.resolveAdapter(c as unknown as Ctx)
      const directory = await opts.resolveDirectory(c as unknown as Ctx)
      await adapter.deleteSession(c.req.param("id"), directory)
      return c.json({ ok: true })
    })
    .post("/session/:id/message", async (c) => {
      const adapter = await opts.resolveAdapter(c as unknown as Ctx)
      const id = c.req.param("id")
      const directory = await opts.resolveDirectory(c as unknown as Ctx)
      const input = prompt((await c.req.json().catch(() => ({}))) as PromptBody)
      let assistantId = input.assistantMessageId
      let error: string | undefined

      for await (const event of adapter.sendMessage(id, input, directory)) {
        opts.sessionBus.publish({ type: "process.status", configId: id, status: "streaming" })
        opts.publishGlobal(withDir(directory, event))
        if (event.type === "message.updated" && event.properties.info.role === "assistant") {
          assistantId = event.properties.info.id
        }
        if (event.type === "session.error") error = failure(event.properties.error)
        if (event.type === "session.idle" || event.type === "session.error") break
      }

      const messages = await adapter.getMessages(id, directory)
      const final = reply(messages, assistantId)
      if (final) return c.json(final)
      return c.json({
        info: buildAssistantMessage({
          id: assistantId,
          sessionID: id,
          parentID: input.userMessageId ?? id,
          agent: input.agent,
          model: input.model,
          directory,
          completed: Date.now(),
          ...(error
            ? {
                error: {
                  name: "UnknownError" as const,
                  data: { message: error },
                },
              }
            : {}),
          ...(input.variant ? { variant: input.variant } : {}),
        }),
        parts: [],
      })
    })
    .get("/session/:id/message", async (c) => {
      const adapter = await opts.resolveAdapter(c as unknown as Ctx)
      const directory = await opts.resolveDirectory(c as unknown as Ctx)
      const messages = await adapter.getMessages(c.req.param("id"), directory)
      return c.json(messages)
    })
    .get("/session/:id/todo", async (c) => {
      const adapter = await opts.resolveAdapter(c as unknown as Ctx)
      const directory = await opts.resolveDirectory(c as unknown as Ctx)
      const todos = await adapter.getTodos(c.req.param("id"), directory)
      return c.json(todos)
    })
    .post("/session/:id/abort", async (c) => {
      const adapter = await opts.resolveAdapter(c as unknown as Ctx)
      const directory = await opts.resolveDirectory(c as unknown as Ctx)
      await adapter.abort(c.req.param("id"), directory)
      return c.json({ ok: true })
    })
    .post("/session/:id/revert", async (c) => {
      const adapter = await opts.resolveAdapter(c as unknown as Ctx)
      const directory = await opts.resolveDirectory(c as unknown as Ctx)
      await adapter.revert(c.req.param("id"), directory)
      return c.json({ ok: true })
    })
    .post("/session/:id/unrevert", async (c) => {
      const adapter = await opts.resolveAdapter(c as unknown as Ctx)
      const directory = await opts.resolveDirectory(c as unknown as Ctx)
      await adapter.unrevert(c.req.param("id"), directory)
      return c.json({ ok: true })
    })
    .post("/session/:id/fork", async (c) => {
      const adapter = await opts.resolveAdapter(c as unknown as Ctx)
      const directory = await opts.resolveDirectory(c as unknown as Ctx)
      const body = (await c.req.json().catch(() => ({}))) as { messageId?: string }
      const next = await adapter.forkSession(c.req.param("id"), body.messageId ?? "", directory)
      return c.json(next, 201)
    })
    .post("/session/:id/command", async (c) => {
      const adapter = await opts.resolveAdapter(c as unknown as Ctx)
      const directory = await opts.resolveDirectory(c as unknown as Ctx)
      const body = (await c.req.json().catch(() => ({}))) as { command?: string }
      await adapter.executeCommand(c.req.param("id"), body.command ?? "", directory)
      return c.json({ ok: true })
    })
    .post("/session/:id/prompt_async", async (c) => {
      const adapter = await opts.resolveAdapter(c as unknown as Ctx)
      const id = c.req.param("id")
      const directory = await opts.resolveDirectory(c as unknown as Ctx)
      const input = prompt((await c.req.json().catch(() => ({}))) as PromptBody)
      ;(async () => {
        try {
          for await (const event of adapter.sendMessage(id, input, directory)) {
            opts.sessionBus.publish({ type: "process.status", configId: id, status: "streaming" })
            opts.publishGlobal(withDir(directory, event))
            if (event.type === "session.idle" || event.type === "session.error") break
          }
        } catch {
          opts.publishGlobal(withDir(directory, sessionError("Stream error", id)))
        }
      })()
      return c.body(null, 204)
    })
    .get("/command", async (c) => {
      const adapter = await opts.resolveAdapter(c as unknown as Ctx)
      const directory = await opts.resolveDirectory(c as unknown as Ctx)
      return c.json(await adapter.listCommands(directory))
    })
    .get("/agent", async (c) => {
      const adapter = await opts.resolveAdapter(c as unknown as Ctx)
      const directory = await opts.resolveDirectory(c as unknown as Ctx)
      return c.json(await adapter.listAgents(directory))
    })
    .get("/permission", async (c) => {
      const adapter = await opts.resolveAdapter(c as unknown as Ctx)
      const directory = await opts.resolveDirectory(c as unknown as Ctx)
      return c.json(await adapter.listPermissions(directory))
    })
    .post("/session/:sessionId/permissions/:permId", async (c) => {
      const adapter = await opts.resolveAdapter(c as unknown as Ctx)
      const directory = await opts.resolveDirectory(c as unknown as Ctx)
      const body = (await c.req.json().catch(() => ({}))) as { response?: string }
      const r = body.response ?? "deny"
      const decision = r === "once" ? "allow_once" : r === "always" ? "allow_always" : "deny"
      await adapter.respondPermission(c.req.param("permId"), decision, directory)
      opts.publishGlobal(
        withDir(
          directory,
          permissionReplied(
            c.req.param("sessionId"),
            c.req.param("permId"),
            r === "always" ? "always" : r === "once" ? "once" : "reject",
          ),
        ),
      )
      return c.json({ ok: true })
    })
    .post("/question/:id/reply", async (c) => {
      const adapter = await opts.resolveAdapter(c as unknown as Ctx)
      const directory = await opts.resolveDirectory(c as unknown as Ctx)
      const body = (await c.req.json().catch(() => ({}))) as { answer?: string }
      await adapter.replyQuestion(c.req.param("id"), body.answer ?? "", directory)
      return c.json({ ok: true })
    })
    .post("/question/:id/reject", async (c) => {
      const adapter = await opts.resolveAdapter(c as unknown as Ctx)
      const directory = await opts.resolveDirectory(c as unknown as Ctx)
      await adapter.rejectQuestion(c.req.param("id"), directory)
      return c.json({ ok: true })
    })
    .get("/event", async (c) =>
      streamSSE(c, async (stream) => {
        const unsub = opts.sessionBus.subscribe((event) => {
          void stream.writeSSE({ data: JSON.stringify(event) })
        })
        const hb = setInterval(() => {
          void stream.writeSSE({ data: JSON.stringify({ type: "heartbeat" }) })
        }, 30_000)
        await new Promise<void>((resolve) => {
          stream.onAbort(() => {
            clearInterval(hb)
            unsub()
            resolve()
          })
        })
      }),
    )
}
