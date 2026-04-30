import { Hono, type Context } from "hono"
import { streamSSE } from "hono/streaming"
import type { AgentAdapter, PromptInput, SessionConfig, SessionConfigPatch } from "../adapters/index"
import type { ClaxedoEvent } from "../bus"
import {
  buildAssistantMessage,
  messagePartUpdated,
  permissionReplied,
  questionRejected,
  questionReplied,
  sessionError,
  sessionStatus,
  withDir,
  type CompatPart,
  type CompatEnvelope,
} from "../compat-events"
import { recovering } from "../types/status"

type SessionBus = {
  publish: (event: ClaxedoEvent) => void
  subscribe: (fn: (event: ClaxedoEvent) => void) => () => void
}

type Ctx = Context

type Opts = {
  resolveAdapter: (
    c: Ctx,
    input?: {
      sessionId?: string
    },
  ) => Promise<AgentAdapter> | AgentAdapter
  resolveDirectory: (
    c: Ctx,
    input?: {
      sessionId?: string
    },
  ) => Promise<string> | string
  listSessions?: (c: Ctx, directory: string) => Promise<unknown[]>
  createSession?: (c: Ctx, directory: string, title?: string) => Promise<{ id: string }>
  listPermissions?: (c: Ctx, directory: string) => Promise<unknown[]>
  getStatus?: (c: Ctx, directory: string, adapter: AgentAdapter) => Promise<unknown | Response> | unknown | Response
  afterListSessions?: (c: Ctx, directory: string, sessions: unknown[]) => Promise<void> | void
  afterCreateSession?: (c: Ctx, directory: string, session: unknown) => Promise<void> | void
  afterGetSession?: (c: Ctx, directory: string, session: unknown) => Promise<void> | void
  getSessionConfig?: (c: Ctx, directory: string, sessionId: string, adapter: AgentAdapter) => Promise<SessionConfig>
  updateSessionConfig?: (
    c: Ctx,
    directory: string,
    sessionId: string,
    patch: SessionConfigPatch,
    adapter: AgentAdapter,
  ) => Promise<SessionConfig>
  getMessages?: (c: Ctx, directory: string, sessionId: string) => Promise<unknown[] | undefined> | unknown[] | undefined
  afterUpdateSession?: (c: Ctx, directory: string, session: unknown) => Promise<void> | void
  afterDeleteSession?: (c: Ctx, directory: string, sessionId: string) => Promise<void> | void
  afterMessages?: (c: Ctx, directory: string, sessionId: string, messages: unknown[]) => Promise<void> | void
  sessionBus: SessionBus
  publishGlobal: (event: CompatEnvelope) => void
}

function mkAssistantId(userMessageId?: string) {
  if (userMessageId) return userMessageId + "_r"
  const ts = Date.now().toString(16)
  const rand = Math.random().toString(36).slice(2, 10)
  return `msg_${ts}${rand}`
}

function rec(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

function normalizeSession(s: unknown): unknown {
  if (!s || typeof s !== "object") return s
  const r = s as Record<string, unknown>
  if (r.time) return r
  const ts = typeof r.created_at === "number" ? r.created_at : Date.now()
  const archived = typeof r.archived_at === "number" ? r.archived_at : undefined
  return {
    id: r.id,
    title: r.title ?? null,
    slug: r.id,
    version: "local",
    directory: r.directory ?? "",
    ...(typeof r.parentID === "string" ? { parentID: r.parentID } : {}),
    ...(typeof r.rootID === "string" ? { rootID: r.rootID } : {}),
    ...(typeof r.projectID === "string" ? { projectID: r.projectID } : {}),
    ...(Array.isArray(r.tags) ? { tags: r.tags } : {}),
    ...(Array.isArray(r.attachments) ? { attachments: r.attachments } : {}),
    time: { created: ts, updated: ts, ...(archived !== undefined ? { archived } : {}) },
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
    ...(typeof item.parentID === "string" ? { parentID: item.parentID } : {}),
    ...(typeof item.rootID === "string" ? { rootID: item.rootID } : {}),
    ...(typeof item.projectID === "string" ? { projectID: item.projectID } : {}),
    ...(Array.isArray(item.tags) ? { tags: item.tags } : {}),
    ...(Array.isArray(item.attachments) ? { attachments: item.attachments } : {}),
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

function prompt(body: PromptBody, config?: SessionConfig): PromptInput {
  return {
    parts: body.parts ?? [],
    userMessageId: body.messageID,
    assistantMessageId: mkAssistantId(body.messageID),
    agent: body.agent ?? config?.agent ?? "build",
    model: {
      providerID: body.model?.providerID ?? config?.model?.providerID ?? "anthropic",
      modelID: body.model?.modelID ?? config?.model?.modelID ?? "claude-sonnet-4-6",
    },
    ...(body.tools ? { tools: body.tools } : {}),
    ...(body.format ? { format: body.format } : {}),
    ...(body.system ? { system: body.system } : {}),
    ...(body.variant !== undefined ? { variant: body.variant } : config?.variant ? { variant: config.variant } : {}),
  }
}

async function promptForSession(adapter: AgentAdapter, sessionId: string, directory: string, body: PromptBody) {
  if (body.agent && body.model?.providerID && body.model?.modelID && body.variant !== undefined) return prompt(body)
  return prompt(body, await adapter.getSessionConfig(sessionId, directory).catch(() => undefined))
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

async function questionSession(adapter: AgentAdapter, qId: string, directory: string, sessionId?: string) {
  if (sessionId) return sessionId
  if (qId.includes(":")) return qId.split(":")[0] ?? ""
  const list = await adapter.listQuestions(directory)
  const hit = list.find((item) => {
    const row = rec(item)
    return row?.id === qId
  })
  return typeof rec(hit)?.sessionID === "string" ? String(rec(hit)?.sessionID) : ""
}

function promptParts(sessionId: string, messageId: string, parts: unknown[]): CompatPart[] {
  return parts.flatMap((item, i) => {
    const row = rec(item)
    const type = typeof row?.type === "string" ? row.type : undefined
    const id = `${String(i).padStart(6, "0")}_${messageId}-input`
    if (type === "text") {
      return [{
        id,
        sessionID: sessionId,
        messageID: messageId,
        type,
        text: typeof row?.text === "string" ? row.text : "",
      } satisfies CompatPart]
    }
    if ((type === "image" || type === "audio") && typeof row?.mimeType === "string" && typeof row?.data === "string") {
      return [{
        id,
        sessionID: sessionId,
        messageID: messageId,
        type,
        mimeType: row.mimeType,
        data: row.data,
      } satisfies CompatPart]
    }
    if (type === "resource_link" && typeof row?.uri === "string") {
      return [{
        id,
        sessionID: sessionId,
        messageID: messageId,
        type: "resource-link",
        uri: row.uri,
        name: typeof row.name === "string" ? row.name : typeof row.title === "string" ? row.title : "resource",
        ...(typeof row.mimeType === "string" ? { mimeType: row.mimeType } : {}),
      } satisfies CompatPart]
    }
    const resource = rec(row?.resource)
    if (type === "resource" && typeof resource?.text === "string") {
      return [{
        id,
        sessionID: sessionId,
        messageID: messageId,
        type: "text",
        text: resource.text,
      } satisfies CompatPart]
    }
    return [] as CompatPart[]
  })
}

async function after(input: void | Promise<void> | undefined) {
  try {
    await input
  } catch {}
}

export function createSessionRoutes(opts: Opts) {
  return new Hono()
    .get("/session", async (c) => {
      const directory = await opts.resolveDirectory(c)
      const roots = c.req.query("roots") === "true" || c.req.query("roots") === "1"
      const sessions = opts.listSessions
        ? await opts.listSessions(c, directory)
        : await (await opts.resolveAdapter(c)).listSessions(directory)
      await after(opts.afterListSessions?.(c, directory, sessions))
      const data = (sessions as unknown[]).map(normalizeSession)
      return c.json(data)
    })
    .get("/experimental/session", async (c) => {
      const directory = await opts.resolveDirectory(c)
      const limit = Math.min(Number(c.req.query("limit") ?? "100") || 100, 500)
      const roots = c.req.query("roots") === "true" || c.req.query("roots") === "1"
      const archived = c.req.query("archived") === "true" || c.req.query("archived") === "1"
      const sessions = opts.listSessions
        ? await opts.listSessions(c, directory)
        : await (await opts.resolveAdapter(c)).listSessions(directory)
      await after(opts.afterListSessions?.(c, directory, sessions))
      const data = (sessions as unknown[])
          .map(summarizeSession)
          .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
          .filter((item) => !roots || typeof item.parentID !== "string")
          .filter((item) => archived || typeof rec(item.time)?.archived !== "number")
          .slice(0, limit)
      return c.json(data)
    })
    .get("/session/status", async (c) => {
      const directory = await opts.resolveDirectory(c)
      const adapter = await opts.resolveAdapter(c)
      const status = await opts.getStatus?.(c, directory, adapter)
      if (status instanceof Response) return status
      return c.json(status ?? {})
    })
    .post("/session", async (c) => {
      const directory = await opts.resolveDirectory(c)
      const body = (await c.req.json().catch(() => ({}))) as { title?: string }
      const session = opts.createSession
        ? await opts.createSession(c, directory, body.title)
        : await (await opts.resolveAdapter(c)).createSession(directory, body.title)
      await after(opts.afterCreateSession?.(c, directory, session))
      return c.json(normalizeSession(session), 201)
    })
    .get("/session/:id", async (c) => {
      const sessionId = c.req.param("id")
      const adapter = await opts.resolveAdapter(c, { sessionId })
      const directory = await opts.resolveDirectory(c, { sessionId })
      const session = await adapter.getSession(sessionId, directory)
      if (!session) return c.json({ error: "Not found" }, 404)
      await after(opts.afterGetSession?.(c, directory, session))
      return c.json(normalizeSession(session))
    })
    .get("/session/:id/config", async (c) => {
      const sessionId = c.req.param("id")
      const adapter = await opts.resolveAdapter(c, { sessionId })
      const directory = await opts.resolveDirectory(c, { sessionId })
      const config = opts.getSessionConfig
        ? await opts.getSessionConfig(c, directory, sessionId, adapter)
        : await adapter.getSessionConfig(sessionId, directory)
      return c.json(config)
    })
    .patch("/session/:id", async (c) => {
      const sessionId = c.req.param("id")
      const adapter = await opts.resolveAdapter(c, { sessionId })
      const directory = await opts.resolveDirectory(c, { sessionId })
      const body = (await c.req.json().catch(() => ({}))) as { title?: string; time?: { archived?: number } }
      const session = await adapter.updateSession(sessionId, body, directory)
      if (!session) return c.json({ error: "Not found" }, 404)
      await after(opts.afterUpdateSession?.(c, directory, session))
      return c.json(normalizeSession(session))
    })
    .patch("/session/:id/config", async (c) => {
      const sessionId = c.req.param("id")
      const adapter = await opts.resolveAdapter(c, { sessionId })
      const directory = await opts.resolveDirectory(c, { sessionId })
      const body = (await c.req.json().catch(() => ({}))) as SessionConfigPatch
      const config = opts.updateSessionConfig
        ? await opts.updateSessionConfig(c, directory, sessionId, body, adapter)
        : await adapter.updateSessionConfig(sessionId, body, directory)
      return c.json(config)
    })
    .delete("/session/:id", async (c) => {
      const sessionId = c.req.param("id")
      const adapter = await opts.resolveAdapter(c, { sessionId })
      const directory = await opts.resolveDirectory(c, { sessionId })
      await adapter.deleteSession(sessionId, directory)
      await after(opts.afterDeleteSession?.(c, directory, sessionId))
      return c.json({ ok: true })
    })
    .post("/session/:id/message", async (c) => {
      const id = c.req.param("id")
      const adapter = await opts.resolveAdapter(c, { sessionId: id })
      const directory = await opts.resolveDirectory(c, { sessionId: id })
      const input = await promptForSession(adapter, id, directory, (await c.req.json().catch(() => ({}))) as PromptBody)
      if (input.userMessageId) {
        for (const part of promptParts(id, input.userMessageId, input.parts)) {
          opts.publishGlobal(withDir(directory, messagePartUpdated(part)))
        }
      }
      let assistantId = input.assistantMessageId
      let error: string | undefined
      for await (const event of adapter.sendMessage(id, input, directory)) {
        opts.sessionBus.publish({ type: "process.status", directory, configId: id, status: "streaming" })
        opts.publishGlobal(withDir(directory, event))
        if (event.type === "message.updated" && event.properties.info.role === "assistant") {
          assistantId = event.properties.info.id
        }
        if (event.type === "session.error") error = failure(event.properties.error)
        if (event.type === "session.idle" || event.type === "session.error") break
      }
      const messages = await adapter.getMessages(id, directory)
      await after(opts.afterMessages?.(c, directory, id, messages))
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
      const sessionId = c.req.param("id")
      const directory = await opts.resolveDirectory(c, { sessionId })
      const replay = await opts.getMessages?.(c, directory, sessionId)
      if (replay) return c.json(replay)
      const adapter = await opts.resolveAdapter(c, { sessionId })
      const messages = await adapter.getMessages(sessionId, directory)
      await after(opts.afterMessages?.(c, directory, sessionId, messages))
      return c.json(messages)
    })
    .get("/session/:id/todo", async (c) => {
      const adapter = await opts.resolveAdapter(c, { sessionId: c.req.param("id") })
      const directory = await opts.resolveDirectory(c)
      return c.json(await adapter.getTodos(c.req.param("id"), directory))
    })
    .post("/session/:id/abort", async (c) => {
      const adapter = await opts.resolveAdapter(c, { sessionId: c.req.param("id") })
      const directory = await opts.resolveDirectory(c)
      const result = await adapter.abort(c.req.param("id"), directory)
      if (result.status === "recovering") {
        opts.publishGlobal(withDir(directory, sessionStatus(c.req.param("id"), recovering(result.message))))
      }
      return c.json(result)
    })
    .post("/session/:id/revert", async (c) => {
      const adapter = await opts.resolveAdapter(c, { sessionId: c.req.param("id") })
      const directory = await opts.resolveDirectory(c)
      await adapter.revert(c.req.param("id"), directory)
      return c.json({ ok: true })
    })
    .post("/session/:id/unrevert", async (c) => {
      const adapter = await opts.resolveAdapter(c, { sessionId: c.req.param("id") })
      const directory = await opts.resolveDirectory(c)
      await adapter.unrevert(c.req.param("id"), directory)
      return c.json({ ok: true })
    })
    .post("/session/:id/fork", async (c) => {
      const adapter = await opts.resolveAdapter(c, { sessionId: c.req.param("id") })
      const directory = await opts.resolveDirectory(c)
      const body = (await c.req.json().catch(() => ({}))) as { messageId?: string }
      return c.json(await adapter.forkSession(c.req.param("id"), body.messageId ?? "", directory), 201)
    })
    .post("/session/:id/command", async (c) => {
      const adapter = await opts.resolveAdapter(c, { sessionId: c.req.param("id") })
      const directory = await opts.resolveDirectory(c)
      const body = (await c.req.json().catch(() => ({}))) as { command?: string }
      await adapter.executeCommand(c.req.param("id"), body.command ?? "", directory)
      return c.json({ ok: true })
    })
    .post("/session/:id/prompt_async", async (c) => {
      const adapter = await opts.resolveAdapter(c, { sessionId: c.req.param("id") })
      const id = c.req.param("id")
      const directory = await opts.resolveDirectory(c)
      const input = await promptForSession(adapter, id, directory, (await c.req.json().catch(() => ({}))) as PromptBody)
      if (input.userMessageId) {
        for (const part of promptParts(id, input.userMessageId, input.parts)) {
          opts.publishGlobal(withDir(directory, messagePartUpdated(part)))
        }
      }
      ;(async () => {
        try {
          for await (const event of adapter.sendMessage(id, input, directory)) {
            opts.sessionBus.publish({ type: "process.status", directory, configId: id, status: "streaming" })
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
      const adapter = await opts.resolveAdapter(c)
      const directory = await opts.resolveDirectory(c)
      return c.json(await adapter.listCommands(directory))
    })
    .get("/agent", async (c) => {
      const adapter = await opts.resolveAdapter(c)
      const directory = await opts.resolveDirectory(c)
      return c.json(await adapter.listAgents(directory))
    })
    .get("/permission", async (c) => {
      const directory = await opts.resolveDirectory(c)
      const rows = opts.listPermissions
        ? await opts.listPermissions(c, directory)
        : await (await opts.resolveAdapter(c)).listPermissions(directory)
      return c.json(rows)
    })
    .get("/question", async (c) => {
      const directory = await opts.resolveDirectory(c)
      const adapter = await opts.resolveAdapter(c)
      return c.json(await adapter.listQuestions(directory))
    })
    .post("/session/:sessionId/permissions/:permId", async (c) => {
      const adapter = await opts.resolveAdapter(c, { sessionId: c.req.param("sessionId") })
      const directory = await opts.resolveDirectory(c)
      const body = (await c.req.json().catch(() => ({}))) as { response?: string }
      const r = body.response ?? "deny"
      const decision = r === "once" ? "allow_once" : r === "always" ? "allow_always" : "deny"
      await adapter.respondPermission(c.req.param("permId"), decision, directory)
      opts.publishGlobal(withDir(directory, permissionReplied(c.req.param("sessionId"), c.req.param("permId"), r === "always" ? "always" : r === "once" ? "once" : "reject")))
      return c.json({ ok: true })
    })
    .post("/question/:id/reply", async (c) => {
      const sessionId = c.req.query("sessionId") ?? ""
      const adapter = await opts.resolveAdapter(c, { sessionId })
      const directory = await opts.resolveDirectory(c)
      const body = (await c.req.json().catch(() => ({}))) as { answer?: string; answers?: string[][] }
      const id = c.req.param("id")
      const sid = await questionSession(adapter, id, directory, sessionId)
      await adapter.replyQuestion(id, body.answer ?? "", directory)
      opts.publishGlobal(withDir(directory, questionReplied(sid, id, body.answers ?? [[body.answer ?? ""]])))
      return c.json({ ok: true })
    })
    .post("/question/:id/reject", async (c) => {
      const sessionId = c.req.query("sessionId") ?? ""
      const adapter = await opts.resolveAdapter(c, { sessionId })
      const directory = await opts.resolveDirectory(c)
      const id = c.req.param("id")
      const sid = await questionSession(adapter, id, directory, sessionId)
      await adapter.rejectQuestion(id, directory)
      opts.publishGlobal(withDir(directory, questionRejected(sid, id)))
      return c.json({ ok: true })
    })
    .get("/event", async (c) =>
      streamSSE(c, async (stream) => {
        const unsub = opts.sessionBus.subscribe((event) => {
          void stream.writeSSE({ data: JSON.stringify(event) })
        })
        const hb = setInterval(() => {
          void stream.writeSSE({ data: JSON.stringify({ type: "heartbeat" }) })
        }, 2 * 60_000)
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
