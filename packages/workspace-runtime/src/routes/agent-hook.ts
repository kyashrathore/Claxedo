/**
 * Agent Hook Routes (standalone claxedo-server version)
 *
 * Receives lifecycle hook callbacks from CLI agents (Claude, Codex, etc.)
 * running in terminals and publishes events to claxedoBus for the frontend.
 */

import { Hono } from "hono"
import z from "zod"
import { claxedoBus } from "../bus"
import { Log } from "../log"
import {
  setupAgentHooks,
  describeAgentMcp,
  getTerminalEnvVars,
  isSetupComplete,
  listWrapperAgents,
  loadMcpAgentConfig,
  toggleAgentMcp,
  MCP_CAPABLE_AGENTS,
  MANAGED_MCP_SERVERS,
  isManagedMcpServer,
} from "../agent-hooks"

const log = Log.create({ service: "agent-hook" })
const VERBOSE = process.env.CLAXEDO_AGENT_LIFECYCLE_DEBUG === "1"
const DEBUG = process.env.CLAXEDO_DEBUG === "1"

export const AgentEventType = z.enum(["Busy", "Idle", "UserActionRequired", "Error"])
export type AgentEventType = z.infer<typeof AgentEventType>

const AgentEventInputType = z.enum([
  "Busy", "Idle", "UserActionRequired", "Error",
  "Start", "Stop", "PermissionRequest", "QuestionRequest", "Failed", "SessionStart", "SessionEnd",
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

const TabPaneContextPayload = z.object({
  leafId: z.string(),
  name: z.string(),
  type: z.string(),
  directory: z.string().optional(),
  title: z.string().optional(),
  sessionId: z.string().optional(),
  terminalId: z.string().optional(),
  pageId: z.string().optional(),
  filePath: z.string().optional(),
  intent: z.record(z.string(), z.unknown()).optional(),
  meta: z.record(z.string(), z.string()).optional(),
})

const TabContextPayload = z.object({
  tabId: z.string(),
  groupId: z.string().optional(),
  tabType: z.string(),
  scope: z.string().optional(),
  directory: z.string().optional(),
  title: z.string().optional(),
  sessionId: z.string().optional(),
  reviewMode: z.string().optional(),
  reviewFromRef: z.string().optional(),
  reviewToRef: z.string().optional(),
  pageId: z.string().optional(),
  terminalId: z.string().optional(),
  activeLeafId: z.string().optional(),
  focusedLeafId: z.string().optional(),
  terminalIds: z.array(z.string()).optional(),
  panes: z.array(TabPaneContextPayload).optional(),
  updatedAt: z.number().optional(),
})
type TabContextPayload = z.infer<typeof TabContextPayload>

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

const TAB_CONTEXT_TTL_MS = (() => {
  const v = Number(process.env.CLAXEDO_TAB_CONTEXT_TTL_MS)
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 30 * 24 * 60 * 60 * 1000
})()
const TAB_CONTEXT_MAX = (() => {
  const v = Number(process.env.CLAXEDO_TAB_CONTEXT_MAX)
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 600
})()
const TERMINAL_SESSION_TTL_MS = (() => {
  const v = Number(process.env.CLAXEDO_TERMINAL_SESSION_TTL_MS)
  return Number.isFinite(v) && v > 0 ? Math.round(v) : TAB_CONTEXT_TTL_MS
})()

const tabContexts = new Map<string, TabContextPayload & { updatedAt: number }>()
const terminalToTab = new Map<string, string>()
const terminalSessions = new Map<string, TerminalSessionPayload>()

const clean = (value: unknown) => (typeof value === "string" ? value.trim() : "")

const tabHasTerminal = (context: TabContextPayload, terminalId: string) => {
  if (context.terminalId === terminalId) return true
  if (context.terminalIds?.includes(terminalId)) return true
  if (context.panes?.some((pane) => pane.terminalId === terminalId)) return true
  return false
}

const terminalIdsForContext = (context: TabContextPayload) => {
  const ids = new Set<string>()
  const root = clean(context.terminalId)
  if (root) ids.add(root)
  for (const id of context.terminalIds ?? []) {
    const next = clean(id)
    if (next) ids.add(next)
  }
  for (const pane of context.panes ?? []) {
    const next = clean(pane.terminalId)
    if (next) ids.add(next)
  }
  return [...ids]
}

const pruneTabContexts = () => {
  const now = Date.now()
  for (const [tabId, context] of tabContexts.entries()) {
    if (now - context.updatedAt <= TAB_CONTEXT_TTL_MS) continue
    tabContexts.delete(tabId)
  }
  for (const [terminalId, tabId] of terminalToTab.entries()) {
    const context = tabContexts.get(tabId)
    if (context && tabHasTerminal(context, terminalId)) continue
    terminalToTab.delete(terminalId)
  }
}

const rememberContext = (context: TabContextPayload & { updatedAt: number }) => {
  tabContexts.set(context.tabId, context)
  for (const id of terminalIdsForContext(context)) {
    terminalToTab.set(id, context.tabId)
  }
}

const storeTabContext = (payload: TabContextPayload) => {
  pruneTabContexts()
  const tabId = clean(payload.tabId)
  if (!tabId) return undefined
  const updatedAt =
    typeof payload.updatedAt === "number" && Number.isFinite(payload.updatedAt)
      ? Math.round(payload.updatedAt)
      : Date.now()
  const context = { ...payload, tabId, updatedAt }
  rememberContext(context)
  return context
}

const readTabContext = (input: { tabId?: string; terminalId?: string }) => {
  pruneTabContexts()
  const tabId = clean(input.tabId)
  if (tabId) {
    const context = tabContexts.get(tabId)
    if (context) return { source: "tab" as const, context }
    return
  }
  const terminalId = clean(input.terminalId)
  if (!terminalId) return
  const mappedTabId = terminalToTab.get(terminalId)
  const mapped = mappedTabId ? tabContexts.get(mappedTabId) : undefined
  if (mapped && tabHasTerminal(mapped, terminalId)) {
    return { source: "terminal-map" as const, context: mapped }
  }
  for (const [id, context] of tabContexts.entries()) {
    if (!tabHasTerminal(context, terminalId)) continue
    terminalToTab.set(terminalId, id)
    return { source: "terminal-scan" as const, context }
  }
}

const normalizeProvider = (value: unknown) => clean(value).toLowerCase()

const REF_STOP = new Set(["the","a","an","and","or","to","for","of","in","on","at","with","from","by","is","are","be","this","that","it","please","can","you","me","my","we","our","do","does","did","help"])

const refWords = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9\s-]+/g, " ").split(/\s+/).filter(Boolean).filter((w) => w.length >= 2).filter((w) => !REF_STOP.has(w))

const refNameFrom = (input: { prompt?: string; assistant?: string; provider?: string; sessionId?: string }) => {
  const prompt = clean(input.prompt)
  const assistant = clean(input.assistant)
  const provider = normalizeProvider(input.provider) || "agent"
  const sessionId = clean(input.sessionId)
  const tokens = refWords(prompt || assistant).slice(0, 3)
  const base = (tokens.join("-") || provider || "agent").slice(0, 26).replace(/^-+|-+$/g, "") || "agent"
  const suffix = sessionId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-4)
  return `@${suffix ? `${base}-${suffix}` : base}`
}

const primaryTerminalId = (context: TabContextPayload | undefined) => {
  const root = clean(context?.terminalId)
  if (root) return root
  for (const value of context?.terminalIds ?? []) {
    const next = clean(value)
    if (next) return next
  }
  for (const pane of context?.panes ?? []) {
    const next = clean(pane.terminalId)
    if (next) return next
  }
  return ""
}

const resolveTerminalId = (input: { terminalId?: string; tabId?: string }) => {
  const direct = clean(input.terminalId)
  if (direct) return direct
  const tabId = clean(input.tabId)
  if (!tabId) return ""
  const context = readTabContext({ tabId })?.context
  return primaryTerminalId(context)
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
    (!sessionChanged && clean(previous?.refName)) ||
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
    claxedoBus.publish({
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
claxedoBus.subscribe((event) => {
  if (event.type === "pty.exited") {
    clearTerminalSession(event.id)
  } else if (event.type === "pty.deleted") {
    clearTerminalSession(event.id)
  }
})

export function AgentHookRoutes() {
  return (
    new Hono()
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
        if (VERBOSE) {
          log.info("agent lifecycle resolve", { tabId, terminalId, resolvedTerminalId })
        }
        const normalized = {
          tabId,
          terminalId: resolvedTerminalId || terminalId || undefined,
          workspaceId: workspaceId || undefined,
          provider: normalizeProvider(provider) || undefined,
          sessionId: sessionId || undefined,
          transcriptPath: transcriptPath || undefined,
          refName: refName || undefined,
          prompt: prompt || undefined,
          lastAssistantMessage: lastAssistantMessage || undefined,
          eventType: normalizedEventType,
        }

        if (resolvedTerminalId) {
          upsertTerminalSession({
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
        }

        log.info("agent lifecycle", normalized)
        if (VERBOSE) {
          log.info("agent lifecycle publish", { type: "agent.lifecycle", ...normalized })
        }
        claxedoBus.publish({ type: "agent.lifecycle", ...normalized })

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
        const body = await c.req.json().catch(() => null)
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
        if (VERBOSE) {
          log.info("agent lifecycle resolve (POST)", {
            tabId: payload.tabId,
            terminalId: payload.terminalId,
            resolvedTerminalId,
          })
        }

        const normalized = {
          ...payload,
          terminalId: resolvedTerminalId || clean(payload.terminalId) || undefined,
          workspaceId: clean(payload.workspaceId) || undefined,
          provider: normalizeProvider(payload.provider) || undefined,
          sessionId: clean(payload.sessionId) || undefined,
          transcriptPath: clean(payload.transcriptPath) || undefined,
          refName: clean(payload.refName) || undefined,
          prompt: clean(payload.prompt) || undefined,
          lastAssistantMessage: clean(payload.lastAssistantMessage) || undefined,
          eventType,
        }

        if (resolvedTerminalId) {
          upsertTerminalSession({
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
        }

        log.info("agent lifecycle (POST)", normalized)
        if (VERBOSE) {
          log.info("agent lifecycle publish (POST)", { type: "agent.lifecycle", ...normalized })
        }
        claxedoBus.publish({ type: "agent.lifecycle", ...normalized })

        return c.json({ success: true })
      })
      .post("/tab-context", async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = TabContextPayload.safeParse(body)
        if (!parsed.success) {
          return c.json({ success: false, error: "Invalid payload" }, 400)
        }
        const context = storeTabContext(parsed.data)
        if (!context) return c.json({ success: false, error: "tabId is required" }, 400)
        return c.json({ success: true, tabId: context.tabId, updatedAt: context.updatedAt })
      })
      .get("/tab-context", async (c) => {
        const tabId = c.req.query("tabId")
        const terminalId = c.req.query("terminalId")
        const result = readTabContext({ tabId, terminalId })
        if (!result) {
          return c.json({ success: false, error: "No tab context found for given identifiers" }, 404)
        }
        return c.json({ success: true, source: result.source, context: result.context })
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
          const body = await c.req.json().catch(() => ({})) as {
            port?: number
            force?: boolean
            wrappers?: string[]
            replaceWrappers?: boolean
          }
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
          return c.json(
            { success: false, error: error instanceof Error ? error.message : "Unknown error" },
            500,
          )
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
      .get("/mcp-agents", async (c) => {
        const config = await loadMcpAgentConfig()
        const status = Object.fromEntries(
          MANAGED_MCP_SERVERS.map((server) => [
            server,
            Object.fromEntries(
              MCP_CAPABLE_AGENTS.map((agent) => [agent, describeAgentMcp(server, agent, config)]),
            ),
          ]),
        )
        return c.json({
          servers: config.servers,
          defaults: config.defaults,
          overrides: config.overrides,
          status,
          managed: [...MANAGED_MCP_SERVERS],
          capable: [...MCP_CAPABLE_AGENTS],
        })
      })
      .post("/mcp-agents", async (c) => {
        const body = await c.req.json().catch(() => null) as { server?: string; agent?: string; enabled?: boolean } | null
        if (!body || typeof body.server !== "string" || typeof body.agent !== "string" || typeof body.enabled !== "boolean") {
          return c.json({ success: false, error: "server, agent, and enabled are required" }, 400)
        }
        const { server, agent, enabled } = body
        if (!isManagedMcpServer(server)) {
          return c.json({ success: false, error: `MCP server '${server}' is not managed here` }, 400)
        }
        if (!MCP_CAPABLE_AGENTS.includes(agent as any)) {
          return c.json({ success: false, error: `Agent '${agent}' does not support MCP` }, 400)
        }
        try {
          await toggleAgentMcp(server, agent, enabled)
          return c.json({ success: true, server, agent, enabled })
        } catch (error) {
          log.error("Failed to toggle MCP for agent", { server, agent, enabled, error })
          return c.json(
            { success: false, error: error instanceof Error ? error.message : "Unknown error" },
            500,
          )
        }
      })
  )
}
