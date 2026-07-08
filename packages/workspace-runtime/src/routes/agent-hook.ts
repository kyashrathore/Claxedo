/**
 * Agent Hook Routes
 *
 * Receives lifecycle hook callbacks from CLI agents (Claude, Codex, etc.)
 * running in terminals and publishes events to the runtime event bus.
 */

import { Hono } from "hono"
import z from "zod"
import { workspaceRuntimeBus } from "../bus"
import { Log } from "../log"
import { boundedJsonBody, isRequestBodyTooLarge, requestBodyTooLargeBody } from "./http"
import {
  setupAgentHooks,
  getTerminalEnvVars,
  isSetupComplete,
  listWrapperAgents,
} from "../agent-hooks"

const log = Log.create({ service: "agent-hook" })

export const AgentEventType = z.enum(["Busy", "Idle", "UserActionRequired", "Error"])
export type AgentEventType = z.infer<typeof AgentEventType>

const AgentEventInputType = z.enum([
  "Busy",
  "Idle",
  "UserActionRequired",
  "Error",
  "Start",
  "Stop",
  "PermissionRequest",
  "QuestionRequest",
  "Failed",
  "SessionStart",
  "SessionEnd",
])

const normalizeAgentEventType = (value: unknown): AgentEventType | undefined => {
  const parsed = AgentEventInputType.safeParse(value)
  if (!parsed.success) return
  if (parsed.data === "Start" || parsed.data === "SessionStart") return "Busy"
  if (parsed.data === "Stop" || parsed.data === "SessionEnd") return "Idle"
  if (parsed.data === "PermissionRequest" || parsed.data === "QuestionRequest") return "UserActionRequired"
  if (parsed.data === "Failed") return "Error"
  return parsed.data as AgentEventType
}

export const AgentLifecyclePayload = z.object({
  tabId: z.string(),
  terminalId: z.string().optional(),
  workspaceId: z.string().optional(),
  provider: z.string().optional(),
  sessionId: z.string().optional(),
  transcriptPath: z.string().optional(),
  refName: z.string().optional(),
  prompt: z.string().optional(),
  lastAssistantMessage: z.string().optional(),
  eventType: AgentEventType,
})
export type AgentLifecyclePayload = z.infer<typeof AgentLifecyclePayload>

const AgentLifecycleInputPayload = AgentLifecyclePayload.extend({
  eventType: AgentEventInputType,
})

const TerminalSessionPayload = z.object({
  terminalId: z.string(),
  tabId: z.string().optional(),
  workspaceId: z.string().optional(),
  provider: z.string().optional(),
  sessionId: z.string().nullable().optional(),
  transcriptPath: z.string().nullable().optional(),
  refName: z.string().optional(),
  prompt: z.string().optional(),
  lastAssistantMessage: z.string().optional(),
  eventType: AgentEventType.optional(),
  updatedAt: z.number(),
})
type TerminalSessionPayload = z.infer<typeof TerminalSessionPayload>

const TERMINAL_SESSION_TTL_MS = (() => {
  const v = Number(process.env.WORKSPACE_RUNTIME_TERMINAL_SESSION_TTL_MS)
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 30 * 24 * 60 * 60 * 1000
})()

const terminalSessions = new Map<string, TerminalSessionPayload>()

const clean = (value: unknown) => (typeof value === "string" ? value.trim() : "")

const normalizeProvider = (value: unknown) => clean(value).toLowerCase()

const REF_STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "for",
  "of",
  "in",
  "on",
  "at",
  "with",
  "from",
  "by",
  "is",
  "are",
  "be",
  "this",
  "that",
  "it",
  "please",
  "can",
  "you",
  "me",
  "my",
  "we",
  "our",
  "do",
  "does",
  "did",
  "help",
])

const refWords = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => w.length >= 2)
    .filter((w) => !REF_STOP.has(w))

const weakText = (value: string) => /^(hi|hello|hey|yo|greeting|greetings)$/i.test(clean(value).replace(/[^a-z0-9]+/gi, " ").trim())

const noisyPromptText = (value: string) => {
  const text = clean(value)
  return text.length > 160 || /\b(i'?m|i am)\s+(claude|codex)\b/i.test(text) || /\bai assistant\b/i.test(text)
}

const weakRefName = (value: string) => {
  const ref = clean(value)
    .replace(/^@+/, "")
    .replace(/[-_][a-z0-9]{4,8}$/i, "")
    .replace(/[-_]+/g, " ")
  return weakText(ref)
}

const refNameFrom = (input: { prompt?: string; assistant?: string; provider?: string; sessionId?: string }) => {
  const prompt = clean(input.prompt)
  const assistant = clean(input.assistant)
  const provider = normalizeProvider(input.provider) || "agent"
  const sessionId = clean(input.sessionId)
  const source = prompt && !(assistant && (weakText(prompt) || noisyPromptText(prompt))) ? prompt : assistant || prompt
  const tokens = refWords(source).slice(0, 3)
  const base = (tokens.join("-") || provider || "agent").slice(0, 26).replace(/^-+|-+$/g, "") || "agent"
  const suffix = sessionId
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(-4)
  return `@${suffix ? `${base}-${suffix}` : base}`
}

const resolveTerminalId = (input: { terminalId?: string; tabId?: string }) => {
  return clean(input.terminalId)
}

const toOptionalText = (value: unknown) => {
  const next = clean(value)
  if (!next) return undefined
  return next
}

const toOptionalEventType = (value: unknown): AgentEventType | undefined => {
  const parsed = AgentEventType.safeParse(value)
  if (!parsed.success) return undefined
  return parsed.data
}

const pruneTerminalSessions = () => {
  const now = Date.now()
  for (const [terminalId, session] of terminalSessions.entries()) {
    if (now - session.updatedAt <= TERMINAL_SESSION_TTL_MS) continue
    terminalSessions.delete(terminalId)
  }
}

const rememberTerminalSession = (session: TerminalSessionPayload) => {
  terminalSessions.set(session.terminalId, session)
}

const upsertTerminalSession = (input: {
  terminalId: string
  tabId?: string
  workspaceId?: string
  provider?: string
  sessionId?: string
  transcriptPath?: string
  refName?: string
  prompt?: string
  lastAssistantMessage?: string
  eventType?: AgentEventType
}) => {
  pruneTerminalSessions()
  const terminalId = clean(input.terminalId)
  if (!terminalId) return
  const previous = terminalSessions.get(terminalId)
  const sessionId = clean(input.sessionId)
  const transcriptPath = clean(input.transcriptPath)
  const refName = clean(input.refName)
  const prompt = clean(input.prompt)
  const lastAssistantMessage = clean(input.lastAssistantMessage)
  const provider = normalizeProvider(input.provider) || normalizeProvider(previous?.provider)
  const previousSessionId = clean(previous?.sessionId)
  const sessionChanged = !!sessionId && sessionId !== previousSessionId
  const sessionRefName =
    refName ||
    (!sessionChanged && clean(previous?.refName) && !(weakRefName(clean(previous?.refName)) && lastAssistantMessage)
      ? clean(previous?.refName)
      : "") ||
    refNameFrom({
      prompt: prompt || (sessionChanged ? "" : clean(previous?.prompt)),
      assistant: lastAssistantMessage || (sessionChanged ? "" : clean(previous?.lastAssistantMessage)),
      provider,
      sessionId: sessionId || previousSessionId,
    })
  const next: TerminalSessionPayload = {
    terminalId,
    tabId: clean(input.tabId) || clean(previous?.tabId) || undefined,
    workspaceId: clean(input.workspaceId) || clean(previous?.workspaceId) || undefined,
    provider: provider || undefined,
    sessionId: sessionId ? sessionId : previous?.sessionId,
    transcriptPath: transcriptPath ? transcriptPath : previous?.transcriptPath,
    refName: sessionRefName,
    prompt: prompt ? prompt : sessionChanged ? undefined : clean(previous?.prompt) || undefined,
    lastAssistantMessage: lastAssistantMessage
      ? lastAssistantMessage
      : sessionChanged
        ? undefined
        : clean(previous?.lastAssistantMessage) || undefined,
    eventType: input.eventType || previous?.eventType,
    updatedAt: Date.now(),
  }
  rememberTerminalSession(next)
  return next
}

const clearTerminalSession = (terminalId: string) => {
  pruneTerminalSessions()
  const id = clean(terminalId)
  if (!id) return
  const previous = terminalSessions.get(id)
  const next: TerminalSessionPayload = {
    terminalId: id,
    tabId: clean(previous?.tabId) || undefined,
    workspaceId: clean(previous?.workspaceId) || undefined,
    provider: normalizeProvider(previous?.provider) || undefined,
    sessionId: null,
    transcriptPath: null,
    refName: clean(previous?.refName) || undefined,
    prompt: clean(previous?.prompt) || undefined,
    lastAssistantMessage: clean(previous?.lastAssistantMessage) || undefined,
    eventType: "Idle",
    updatedAt: Date.now(),
  }
  rememberTerminalSession(next)

  // Emit Idle event to frontend so the status indicator clears
  if (previous && previous.eventType && previous.eventType !== "Idle") {
    workspaceRuntimeBus.publish({
      type: "agent.lifecycle",
      tabId: next.tabId || id,
      terminalId: id,
      workspaceId: next.workspaceId,
      eventType: "Idle",
    })
  }

  return next
}

const readTerminalSession = (input: { terminalId?: string; tabId?: string }) => {
  pruneTerminalSessions()
  const terminalId = resolveTerminalId(input)
  if (!terminalId) return
  const mapped = terminalSessions.get(terminalId)
  if (mapped) return { source: "memory" as const, terminalId, session: mapped }
}

// Subscribe to PTY exit/delete events to clear terminal sessions
workspaceRuntimeBus.subscribe((event) => {
  if (event.type === "pty.exited") {
    clearTerminalSession(event.id)
  } else if (event.type === "pty.deleted") {
    clearTerminalSession(event.id)
  }
})

export function AgentHookRoutes() {
  return new Hono()
    .onError((err, c) => {
      if (isRequestBodyTooLarge(err)) return c.json(requestBodyTooLargeBody(), 413)
      throw err
    })
    .get("/agent-lifecycle", async (c) => {
      const tabId = clean(c.req.query("tabId"))
      const terminalId = clean(c.req.query("terminalId"))
      const workspaceId = clean(c.req.query("workspaceId"))
      const provider = clean(c.req.query("provider"))
      const sessionId = clean(c.req.query("sessionId"))
      const transcriptPath = clean(c.req.query("transcriptPath"))
      const refName = clean(c.req.query("refName"))
      const prompt = clean(c.req.query("prompt"))
      const lastAssistantMessage = clean(c.req.query("lastAssistantMessage"))
      const eventType = c.req.query("eventType")

      if (!tabId) return c.json({ success: false, error: "Missing tabId" }, 400)
      if (!eventType) return c.json({ success: false, error: "Missing eventType" }, 400)

      const normalizedEventType = normalizeAgentEventType(eventType)
      if (!normalizedEventType) {
        return c.json({ success: false, error: `Invalid eventType: ${eventType}` }, 400)
      }

      const resolvedTerminalId = resolveTerminalId({ tabId, terminalId })
      const stored = resolvedTerminalId
        ? upsertTerminalSession({
            terminalId: resolvedTerminalId,
            tabId,
            workspaceId: workspaceId || undefined,
            provider: provider || undefined,
            sessionId: sessionId || undefined,
            transcriptPath: transcriptPath || undefined,
            refName: refName || undefined,
            prompt: prompt || undefined,
            lastAssistantMessage: lastAssistantMessage || undefined,
            eventType: normalizedEventType,
          })
        : undefined

      const normalized = {
        tabId,
        terminalId: resolvedTerminalId || terminalId || undefined,
        workspaceId: workspaceId || undefined,
        provider: normalizeProvider(provider) || undefined,
        sessionId: sessionId || undefined,
        transcriptPath: transcriptPath || undefined,
        refName: stored?.refName || refName || undefined,
        prompt: stored?.prompt || prompt || undefined,
        lastAssistantMessage: stored?.lastAssistantMessage || lastAssistantMessage || undefined,
        eventType: normalizedEventType,
      }

      log.info("agent lifecycle", normalized)
      workspaceRuntimeBus.publish({ type: "agent.lifecycle", ...normalized })

      return c.json({
        success: true,
        tabId,
        terminalId: normalized.terminalId,
        provider: normalized.provider,
        sessionId: normalized.sessionId,
        refName: normalized.refName,
        eventType: normalizedEventType,
      })
    })
    .post("/agent-lifecycle", async (c) => {
      const body = await boundedJsonBody<unknown | null>(c, null)
      const parsed = AgentLifecycleInputPayload.safeParse(body)
      if (!parsed.success) {
        return c.json({ success: false, error: "Invalid payload" }, 400)
      }
      const payload = parsed.data
      const eventType = normalizeAgentEventType(payload.eventType)
      if (!eventType) {
        return c.json({ success: false, error: `Invalid eventType: ${payload.eventType}` }, 400)
      }

      const resolvedTerminalId = resolveTerminalId({
        tabId: payload.tabId,
        terminalId: payload.terminalId,
      })

      const stored = resolvedTerminalId
        ? upsertTerminalSession({
            terminalId: resolvedTerminalId,
            tabId: payload.tabId,
            workspaceId: payload.workspaceId,
            provider: payload.provider,
            sessionId: payload.sessionId,
            transcriptPath: payload.transcriptPath,
            refName: payload.refName,
            prompt: payload.prompt,
            lastAssistantMessage: payload.lastAssistantMessage,
            eventType,
          })
        : undefined

      const normalized = {
        ...payload,
        terminalId: resolvedTerminalId || clean(payload.terminalId) || undefined,
        workspaceId: clean(payload.workspaceId) || undefined,
        provider: normalizeProvider(payload.provider) || undefined,
        sessionId: clean(payload.sessionId) || undefined,
        transcriptPath: clean(payload.transcriptPath) || undefined,
        refName: stored?.refName || clean(payload.refName) || undefined,
        prompt: stored?.prompt || clean(payload.prompt) || undefined,
        lastAssistantMessage: stored?.lastAssistantMessage || clean(payload.lastAssistantMessage) || undefined,
        eventType,
      }

      log.info("agent lifecycle (POST)", normalized)
      workspaceRuntimeBus.publish({ type: "agent.lifecycle", ...normalized })

      return c.json({ success: true })
    })
    .get("/terminal-session", async (c) => {
      const tabId = c.req.query("tabId")
      const terminalId = c.req.query("terminalId")
      if (!clean(tabId) && !clean(terminalId)) {
        return c.json({ success: false, error: "tabId or terminalId is required" }, 400)
      }
      const result = readTerminalSession({ tabId, terminalId })
      if (!result) {
        return c.json({
          success: true,
          source: "none",
          terminalId: resolveTerminalId({ tabId, terminalId }) || clean(terminalId) || undefined,
          session: null,
        })
      }
      return c.json({
        success: true,
        source: result.source,
        terminalId: result.terminalId,
        session: result.session,
      })
    })
    .post("/setup", async (c) => {
      try {
        const body = await boundedJsonBody<{
          port?: number
          force?: boolean
          wrappers?: string[]
          replaceWrappers?: boolean
        }>(c, {})
        await setupAgentHooks({
          port: body.port,
          force: body.force,
          wrappers: body.wrappers,
          replaceWrappers: body.replaceWrappers,
        })
        const wrappers = await listWrapperAgents()
        return c.json({
          success: true,
          message: "Agent hooks initialized successfully",
          wrappers: wrappers.all,
          customWrappers: wrappers.custom,
        })
      } catch (error) {
        log.error("Setup failed", { error })
        return c.json({ success: false, error: error instanceof Error ? error.message : "Unknown error" }, 500)
      }
    })
    .get("/setup/status", async (c) => {
      const wrappers = await listWrapperAgents()
      return c.json({
        ready: isSetupComplete(),
        wrappers: wrappers.all,
        customWrappers: wrappers.custom,
      })
    })
    .get("/terminal-env", async (c) => {
      const tabId = c.req.query("tabId")
      const terminalId = c.req.query("terminalId")
      const workspaceId = c.req.query("workspaceId")
      const portStr = c.req.query("port")
      const shell = c.req.query("shell")

      if (!tabId || !terminalId || !portStr) {
        return c.json({ success: false, error: "tabId, terminalId, and port are required" }, 400)
      }
      const port = Number(portStr)
      if (!Number.isFinite(port) || port <= 0) {
        return c.json({ success: false, error: "Invalid port" }, 400)
      }
      const env = getTerminalEnvVars({
        tabId,
        terminalId,
        workspaceId: workspaceId || "",
        port,
        shell,
      })
      return c.json(env)
    })
}
