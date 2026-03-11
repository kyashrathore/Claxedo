/**
 * Agent Hook Routes
 *
 * Receives lifecycle hook callbacks from CLI agents (Claude, Codex, etc.)
 * running in terminals and publishes events for the frontend to update
 * tab status indicators.
 */

import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Pty } from "@/pty"
import { Log } from "@/util/log"
import { lazy } from "@/util/lazy"
import {
  setupAgentHooks,
  getTerminalEnvVars,
  isSetupComplete,
  listWrapperAgents,
  loadMcpAgentConfig,
  toggleAgentMcp,
  MCP_CAPABLE_AGENTS,
  MANAGED_MCP_SERVERS,
  isManagedMcpServer,
} from "@/agent-hooks"
import { ClaxedoDB } from "@/storage/claxedo-db"
import { migrateTabContext } from "@/storage/claxedo-migrate-legacy"
import z from "zod"

const log = Log.create({ service: "agent-hook" })
const DEBUG = process.env.CLAXEDO_DEBUG === "1"

/**
 * Agent lifecycle event types
 */
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
])

const normalizeAgentEventType = (value: unknown) => {
  const parsed = AgentEventInputType.safeParse(value)
  if (!parsed.success) return
  if (parsed.data === "Start") return "Busy" as AgentEventType
  if (parsed.data === "Stop") return "Idle" as AgentEventType
  if (parsed.data === "PermissionRequest" || parsed.data === "QuestionRequest") {
    return "UserActionRequired" as AgentEventType
  }
  if (parsed.data === "Failed") return "Error" as AgentEventType
  return parsed.data as AgentEventType
}

/**
 * Agent lifecycle event payload
 */
export const AgentLifecyclePayload = z.object({
  tabId: z.string().describe("Tab ID in Claxedo UI"),
  terminalId: z.string().optional().describe("PTY terminal ID"),
  workspaceId: z.string().optional().describe("Workspace/project ID"),
  provider: z.string().optional().describe("CLI/provider name (claude, codex, opencode, etc)."),
  sessionId: z.string().optional().describe("Current session/conversation id for this terminal, if provided."),
  transcriptPath: z.string().optional().describe("Transcript path from hook payload, if available."),
  refName: z.string().optional().describe("Stable @reference name for this terminal session."),
  prompt: z.string().optional().describe("Latest user prompt text captured from hook payload."),
  lastAssistantMessage: z.string().optional().describe("Latest assistant reply text captured from hook payload."),
  eventType: AgentEventType.describe("Lifecycle event type"),
})
export type AgentLifecyclePayload = z.infer<typeof AgentLifecyclePayload>

const AgentLifecycleInputPayload = AgentLifecyclePayload.extend({
  eventType: AgentEventInputType.describe("Lifecycle event type"),
})

/**
 * Bus event definition for agent lifecycle
 */
export const AgentLifecycleEvent = BusEvent.define("agent.lifecycle", AgentLifecyclePayload)

const clean = (value: unknown) => (typeof value === "string" ? value.trim() : "")

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
  tabId: z.string().describe("Tab id in Claxedo UI."),
  groupId: z.string().optional().describe("Focused group id when this snapshot was published."),
  tabType: z.string().describe("Current tab type (session/page/terminal/etc)."),
  directory: z.string().optional().describe("Workspace directory for this tab."),
  title: z.string().optional().describe("Tab title."),
  sessionId: z.string().optional().describe("Session id if this tab is session-like."),
  reviewMode: z.string().optional().describe("Review mode for review-style tabs."),
  reviewFromRef: z.string().optional().describe("Base ref for review comparisons, if set."),
  reviewToRef: z.string().optional().describe("Target ref for review comparisons, if set."),
  pageId: z.string().optional().describe("Page id if this tab is page-like."),
  terminalId: z.string().optional().describe("Primary terminal id if this tab is terminal-like."),
  activeLeafId: z.string().optional().describe("Active multi-pane leaf id if available."),
  focusedLeafId: z.string().optional().describe("Focused multi-pane leaf id if available."),
  terminalIds: z.array(z.string()).optional().describe("All terminal ids present in this tab's pane tree."),
  panes: z.array(TabPaneContextPayload).optional().describe("Named pane contexts for the current tab layout."),
  updatedAt: z.number().optional().describe("Snapshot timestamp in milliseconds since epoch."),
})
type TabContextPayload = z.infer<typeof TabContextPayload>

const TerminalSessionPayload = z.object({
  terminalId: z.string().describe("Terminal/PTY id."),
  tabId: z.string().optional().describe("Owning tab id if known."),
  workspaceId: z.string().optional().describe("Workspace/project id if known."),
  provider: z.string().optional().describe("CLI/provider name (claude, codex, opencode, etc)."),
  sessionId: z.string().nullable().optional().describe("Current session/conversation id. Null means terminal exited."),
  transcriptPath: z.string().nullable().optional().describe("Transcript path from hooks, if provided."),
  refName: z.string().optional().describe("Stable @reference name for this terminal session."),
  prompt: z.string().optional().describe("Latest user prompt text captured from hook payload."),
  lastAssistantMessage: z.string().optional().describe("Latest assistant reply text captured from hook payload."),
  eventType: AgentEventType.optional().describe("Last lifecycle event seen for this terminal."),
  updatedAt: z.number().describe("Last update timestamp (ms since epoch)."),
})
type TerminalSessionPayload = z.infer<typeof TerminalSessionPayload>

const positive = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.round(parsed)
}

const TAB_CONTEXT_TTL_MS = positive(process.env.CLAXEDO_TAB_CONTEXT_TTL_MS, 30 * 24 * 60 * 60 * 1000)
const TAB_CONTEXT_MAX = positive(process.env.CLAXEDO_TAB_CONTEXT_MAX, 600)
const TERMINAL_SESSION_TTL_MS = positive(process.env.CLAXEDO_TERMINAL_SESSION_TTL_MS, TAB_CONTEXT_TTL_MS)

function db() {
  migrateTabContext() // runs once, idempotent
  return ClaxedoDB.raw()
}

const tabContexts = new Map<string, TabContextPayload & { updatedAt: number }>()
const terminalToTab = new Map<string, string>()
const terminalSessions = new Map<string, TerminalSessionPayload>()
let terminalSessionBusReady = false

const tabHasTerminal = (context: TabContextPayload, terminalId: string) => {
  if (context.terminalId === terminalId) return true
  if (context.terminalIds?.includes(terminalId)) return true
  if (context.panes?.some((pane) => pane.terminalId === terminalId)) return true
  return false
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

const prunePersistentTabContexts = (now = Date.now()) => {
  const cutoff = now - TAB_CONTEXT_TTL_MS
  const raw = db()
  raw.query("DELETE FROM claxedo_tab_context WHERE updated_at < ?").run(cutoff)
  raw.query("DELETE FROM claxedo_tab_context_terminal WHERE updated_at < ?").run(cutoff)
  raw.query(
    "DELETE FROM claxedo_tab_context WHERE tab_id IN (SELECT tab_id FROM claxedo_tab_context ORDER BY updated_at DESC LIMIT -1 OFFSET ?)",
  ).run(TAB_CONTEXT_MAX)
  raw.query("DELETE FROM claxedo_tab_context_terminal WHERE tab_id NOT IN (SELECT tab_id FROM claxedo_tab_context)").run()
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

const parseContextPayload = (payload: string) => {
  try {
    const parsed = JSON.parse(payload) as unknown
    const checked = TabContextPayload.safeParse(parsed)
    if (!checked.success) return
    return checked.data
  } catch {
    return
  }
}

const persistContext = (context: TabContextPayload & { updatedAt: number }) => {
  const raw = db()
  raw.query(
    "INSERT INTO claxedo_tab_context (tab_id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(tab_id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at",
  ).run(context.tabId, JSON.stringify(context), context.updatedAt)
  raw.query("DELETE FROM claxedo_tab_context_terminal WHERE tab_id = ?").run(context.tabId)
  for (const terminalId of terminalIdsForContext(context)) {
    raw.query(
      "INSERT INTO claxedo_tab_context_terminal (terminal_id, tab_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(terminal_id) DO UPDATE SET tab_id=excluded.tab_id, updated_at=excluded.updated_at",
    ).run(terminalId, context.tabId, context.updatedAt)
  }
  prunePersistentTabContexts(context.updatedAt)
}

const loadContextByTab = (tabId: string) => {
  const row = db().query("SELECT payload FROM claxedo_tab_context WHERE tab_id = ?").get(tabId) as
    | { payload?: string }
    | undefined
  const payload = clean(row?.payload)
  if (!payload) return
  return parseContextPayload(payload)
}

const loadContextByTerminal = (terminalId: string) => {
  const row = db()
    .query(
      "SELECT t.payload FROM claxedo_tab_context_terminal m JOIN claxedo_tab_context t ON t.tab_id = m.tab_id WHERE m.terminal_id = ? LIMIT 1",
    )
    .get(terminalId) as { payload?: string } | undefined
  const payload = clean(row?.payload)
  if (!payload) return
  return parseContextPayload(payload)
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
  const context = {
    ...payload,
    tabId,
    updatedAt,
  }
  rememberContext(context)
  persistContext(context)
  return context
}

const readTabContext = (input: { tabId?: string; terminalId?: string }) => {
  pruneTabContexts()
  const tabId = clean(input.tabId)
  if (tabId) {
    const context = tabContexts.get(tabId)
    if (context) return { source: "tab" as const, context }
    const loaded = loadContextByTab(tabId)
    if (!loaded) return
    const hydrated = {
      ...loaded,
      updatedAt: typeof loaded.updatedAt === "number" ? loaded.updatedAt : Date.now(),
    }
    rememberContext(hydrated)
    return { source: "tab-db" as const, context: hydrated }
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

  const loaded = loadContextByTerminal(terminalId)
  if (!loaded) return
  const hydrated = {
    ...loaded,
    updatedAt: typeof loaded.updatedAt === "number" ? loaded.updatedAt : Date.now(),
  }
  rememberContext(hydrated)
  return { source: "terminal-db" as const, context: hydrated }
}

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

const refWords = (value: string) => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => word.length >= 2)
    .filter((word) => !REF_STOP.has(word))
}

const refNameFrom = (input: { prompt?: string; assistant?: string; provider?: string; sessionId?: string }) => {
  const prompt = clean(input.prompt)
  const assistant = clean(input.assistant)
  const provider = normalizeProvider(input.provider) || "agent"
  const sessionId = clean(input.sessionId)
  const tokens = refWords(prompt || assistant).slice(0, 3)
  const base = (tokens.join("-") || provider || "agent").slice(0, 26).replace(/^-+|-+$/g, "") || "agent"
  const suffix = sessionId
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(-4)
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

const toNullableText = (value: unknown) => {
  if (value === null) return null
  const next = clean(value)
  if (!next) return undefined
  return next
}

const toOptionalEventType = (value: unknown) => {
  const parsed = AgentEventType.safeParse(value)
  if (!parsed.success) return undefined
  return parsed.data
}

const hydrateTerminalSession = (row: {
  terminal_id?: unknown
  tab_id?: unknown
  workspace_id?: unknown
  provider?: unknown
  session_id?: unknown
  transcript_path?: unknown
  ref_name?: unknown
  prompt?: unknown
  last_assistant_message?: unknown
  event_type?: unknown
  updated_at?: unknown
}) => {
  const terminalId = clean(row.terminal_id)
  if (!terminalId) return
  const updatedAt = Number(row.updated_at)
  return {
    terminalId,
    tabId: toOptionalText(row.tab_id),
    workspaceId: toOptionalText(row.workspace_id),
    provider: toOptionalText(row.provider),
    sessionId: toNullableText(row.session_id),
    transcriptPath: toNullableText(row.transcript_path),
    refName: toOptionalText(row.ref_name),
    prompt: toOptionalText(row.prompt),
    lastAssistantMessage: toOptionalText(row.last_assistant_message),
    eventType: toOptionalEventType(row.event_type),
    updatedAt: Number.isFinite(updatedAt) ? Math.round(updatedAt) : Date.now(),
  } satisfies TerminalSessionPayload
}

const pruneTerminalSessions = () => {
  const now = Date.now()
  for (const [terminalId, session] of terminalSessions.entries()) {
    if (now - session.updatedAt <= TERMINAL_SESSION_TTL_MS) continue
    terminalSessions.delete(terminalId)
  }
}

const prunePersistentTerminalSessions = (now = Date.now()) => {
  const cutoff = now - TERMINAL_SESSION_TTL_MS
  db().query("DELETE FROM claxedo_terminal_session WHERE updated_at < ?").run(cutoff)
}

const rememberTerminalSession = (session: TerminalSessionPayload) => {
  terminalSessions.set(session.terminalId, session)
}

const persistTerminalSession = (session: TerminalSessionPayload) => {
  db()
    .query(`
      INSERT INTO claxedo_terminal_session
        (terminal_id, tab_id, workspace_id, provider, session_id,
         transcript_path, ref_name, prompt, last_assistant_message,
         event_type, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(terminal_id) DO UPDATE SET
        tab_id = excluded.tab_id,
        workspace_id = excluded.workspace_id,
        provider = excluded.provider,
        session_id = excluded.session_id,
        transcript_path = excluded.transcript_path,
        ref_name = excluded.ref_name,
        prompt = excluded.prompt,
        last_assistant_message = excluded.last_assistant_message,
        event_type = excluded.event_type,
        updated_at = excluded.updated_at`,
    )
    .run(
      session.terminalId,
      session.tabId || null,
      session.workspaceId || null,
      session.provider || null,
      session.sessionId ?? null,
      session.transcriptPath ?? null,
      session.refName || null,
      session.prompt || null,
      session.lastAssistantMessage || null,
      session.eventType || null,
      session.updatedAt,
    )
  prunePersistentTerminalSessions(session.updatedAt)
}

const loadTerminalSession = (terminalId: string) => {
  const row = db()
    .query(
      "SELECT terminal_id, tab_id, workspace_id, provider, session_id, transcript_path, ref_name, prompt, last_assistant_message, event_type, updated_at FROM claxedo_terminal_session WHERE terminal_id = ? LIMIT 1",
    )
    .get(terminalId) as
    | {
        terminal_id?: unknown
        tab_id?: unknown
        workspace_id?: unknown
        provider?: unknown
        session_id?: unknown
        transcript_path?: unknown
        ref_name?: unknown
        prompt?: unknown
        last_assistant_message?: unknown
        event_type?: unknown
        updated_at?: unknown
      }
    | undefined
  if (!row) return
  return hydrateTerminalSession(row)
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
  const previous = terminalSessions.get(terminalId) || loadTerminalSession(terminalId)
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
  const next = {
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
  } satisfies TerminalSessionPayload
  rememberTerminalSession(next)
  persistTerminalSession(next)
  return next
}

const clearTerminalSession = (terminalId: string) => {
  pruneTerminalSessions()
  const id = clean(terminalId)
  if (!id) return
  const previous = terminalSessions.get(id) || loadTerminalSession(id)
  const next = {
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
  } satisfies TerminalSessionPayload
  rememberTerminalSession(next)
  persistTerminalSession(next)

  // Emit Idle event to frontend so the status indicator clears.
  // Only emit if the previous session was tracked and non-idle.
  if (previous && previous.eventType && previous.eventType !== "Idle") {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: AgentLifecycleEvent.type,
        properties: {
          tabId: next.tabId || id,
          terminalId: id,
          workspaceId: next.workspaceId,
          eventType: "Idle" as AgentEventType,
        },
      },
    })
  }

  return next
}

const readTerminalSession = (input: { terminalId?: string; tabId?: string }) => {
  pruneTerminalSessions()
  const terminalId = resolveTerminalId(input)
  if (!terminalId) {
    if (DEBUG) {
      log.info("terminal-session resolve miss", {
        tabId: clean(input.tabId),
        terminalId: clean(input.terminalId),
      })
    }
    return
  }
  const mapped = terminalSessions.get(terminalId)
  if (mapped) {
    if (DEBUG) {
      log.info("terminal-session hit", {
        source: "memory",
        terminalId,
        sessionId: mapped.sessionId,
        workspaceId: mapped.workspaceId,
        provider: mapped.provider,
        refName: mapped.refName,
        prompt: mapped.prompt,
        lastAssistantMessage: mapped.lastAssistantMessage,
      })
    }
    return { source: "memory" as const, terminalId, session: mapped }
  }
  const loaded = loadTerminalSession(terminalId)
  if (!loaded) {
    if (DEBUG) {
      log.info("terminal-session miss", {
        terminalId,
      })
    }
    return
  }
  rememberTerminalSession(loaded)
  if (DEBUG) {
    log.info("terminal-session hit", {
      source: "db",
      terminalId,
      sessionId: loaded.sessionId,
      workspaceId: loaded.workspaceId,
      provider: loaded.provider,
      refName: loaded.refName,
      prompt: loaded.prompt,
      lastAssistantMessage: loaded.lastAssistantMessage,
    })
  }
  return { source: "db" as const, terminalId, session: loaded }
}

const ensureTerminalSessionBus = () => {
  if (terminalSessionBusReady) return
  terminalSessionBusReady = true
  // Use GlobalBus instead of Bus.subscribe because Bus requires an Instance
  // context (keyed by Instance.directory), but this runs at app construction
  // time before any request establishes a context. Bus.publish already forwards
  // all events to GlobalBus, so we can listen there for pty lifecycle events.
  GlobalBus.on("event", (event) => {
    if (event.payload.type === Pty.Event.Exited.type) {
      clearTerminalSession(event.payload.properties.id)
    } else if (event.payload.type === Pty.Event.Deleted.type) {
      clearTerminalSession(event.payload.properties.id)
    }
  })
}

export const AgentHookRoutes = lazy(() => {
  ensureTerminalSessionBus()
  return (
    new Hono()
      // GET endpoint for curl from notify.sh (uses query params)
      .get(
        "/agent-lifecycle",
        describeRoute({
          summary: "Agent lifecycle hook callback",
          description:
            "Receives lifecycle events from CLI agents running in terminals. " +
            "Called by the notify.sh script when agents start, stop, or need permission.",
          operationId: "agentHook.lifecycle",
          responses: {
            200: {
              description: "Event received successfully",
              content: {
                "application/json": {
                  schema: resolver(
                    z.object({
                      success: z.boolean(),
                      tabId: z.string().optional(),
                      terminalId: z.string().optional(),
                      provider: z.string().optional(),
                      sessionId: z.string().optional(),
                      refName: z.string().optional(),
                      eventType: z.string().optional(),
                    }),
                  ),
                },
              },
            },
            400: {
              description: "Invalid request",
              content: {
                "application/json": {
                  schema: resolver(
                    z.object({
                      success: z.boolean(),
                      error: z.string(),
                    }),
                  ),
                },
              },
            },
          },
        }),
        async (c) => {
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

          if (DEBUG) {
            log.info("agent-lifecycle GET received", {
              tabId,
              terminalId,
              workspaceId,
              provider,
              sessionId,
              transcriptPath,
              refName,
              prompt,
              lastAssistantMessage,
              eventType,
              url: c.req.url,
            })
          }

          // Validate required params
          if (!tabId) {
            if (DEBUG) log.warn("Missing tabId in request")
            return c.json({ success: false, error: "Missing tabId" }, 400)
          }
          if (!eventType) {
            if (DEBUG) log.warn("Missing eventType in request")
            return c.json({ success: false, error: "Missing eventType" }, 400)
          }

          // Validate + normalize eventType
          const normalizedEventType = normalizeAgentEventType(eventType)
          if (!normalizedEventType) {
            log.warn("Invalid eventType", { eventType, tabId })
            return c.json({ success: false, error: `Invalid eventType: ${eventType}` }, 400)
          }

          const resolvedTerminalId = resolveTerminalId({ tabId, terminalId })
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

          log.info("agent lifecycle", {
            ...normalized,
          })

          // Publish event for frontend to consume via SSE
          // Use "global" directory so the frontend listener receives it
          const busPayload = {
            directory: "global",
            payload: {
              type: AgentLifecycleEvent.type,
              properties: normalized,
            },
          }

          if (DEBUG) {
            log.info("Emitting to GlobalBus", busPayload)
          }

          GlobalBus.emit("event", busPayload)

          return c.json({
            success: true,
            tabId,
            terminalId: normalized.terminalId,
            provider: normalized.provider,
            sessionId: normalized.sessionId,
            refName: normalized.refName,
            eventType: normalizedEventType,
          })
        },
      )
      // POST endpoint for direct API calls
      .post(
        "/agent-lifecycle",
        describeRoute({
          summary: "Agent lifecycle hook callback (POST)",
          description: "Receives lifecycle events from CLI agents via POST with JSON body.",
          operationId: "agentHook.lifecyclePost",
          responses: {
            200: {
              description: "Event received successfully",
              content: {
                "application/json": {
                  schema: resolver(z.object({ success: z.boolean() })),
                },
              },
            },
            400: {
              description: "Invalid request",
              content: {
                "application/json": {
                  schema: resolver(
                    z.object({
                      success: z.boolean(),
                      error: z.string(),
                    }),
                  ),
                },
              },
            },
          },
        }),
        validator("json", AgentLifecycleInputPayload),
        async (c) => {
          const payload = c.req.valid("json")
          const eventType = normalizeAgentEventType(payload.eventType)
          if (!eventType) {
            return c.json({ success: false, error: `Invalid eventType: ${payload.eventType}` }, 400)
          }

          const resolvedTerminalId = resolveTerminalId({
            tabId: payload.tabId,
            terminalId: payload.terminalId,
          })

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

          // Publish event for frontend to consume via SSE
          GlobalBus.emit("event", {
            directory: "global",
            payload: {
              type: AgentLifecycleEvent.type,
              properties: normalized,
            },
          })

          return c.json({ success: true })
        },
      )
      // Tab context snapshot published by the frontend so terminal agents can
      // resolve current tab + named pane metadata through MCP.
      .post(
        "/tab-context",
        describeRoute({
          summary: "Publish current tab context",
          description:
            "Stores the latest UI tab snapshot (tab, panes, named intent metadata) " +
            "for terminal agents and MCP tools.",
          operationId: "agentHook.tabContextPublish",
          responses: {
            200: {
              description: "Snapshot accepted",
              content: {
                "application/json": {
                  schema: resolver(
                    z.object({
                      success: z.boolean(),
                      tabId: z.string(),
                      updatedAt: z.number(),
                    }),
                  ),
                },
              },
            },
            400: {
              description: "Invalid request",
              content: {
                "application/json": {
                  schema: resolver(
                    z.object({
                      success: z.boolean(),
                      error: z.string(),
                    }),
                  ),
                },
              },
            },
          },
        }),
        validator("json", TabContextPayload),
        async (c) => {
          const payload = c.req.valid("json")
          const context = storeTabContext(payload)
          if (!context) return c.json({ success: false, error: "tabId is required" }, 400)
          return c.json({ success: true, tabId: context.tabId, updatedAt: context.updatedAt })
        },
      )
      .get(
        "/tab-context",
        describeRoute({
          summary: "Resolve latest tab context",
          description:
            "Reads the latest published tab snapshot by tabId or terminalId. " +
            "Used by MCP tools for prompt context extraction.",
          operationId: "agentHook.tabContextRead",
          responses: {
            200: {
              description: "Context found",
              content: {
                "application/json": {
                  schema: resolver(
                    z.object({
                      success: z.boolean(),
                      source: z.string(),
                      context: TabContextPayload,
                    }),
                  ),
                },
              },
            },
            404: {
              description: "No context found",
              content: {
                "application/json": {
                  schema: resolver(
                    z.object({
                      success: z.boolean(),
                      error: z.string(),
                    }),
                  ),
                },
              },
            },
          },
        }),
        validator(
          "query",
          z.object({
            tabId: z.string().optional().describe("Resolve by tab id."),
            terminalId: z.string().optional().describe("Resolve by terminal id."),
          }),
        ),
        async (c) => {
          const query = c.req.valid("query")
          const result = readTabContext({ tabId: query.tabId, terminalId: query.terminalId })
          if (!result) {
            return c.json({ success: false, error: "No tab context found for given identifiers" }, 404)
          }
          return c.json({ success: true, source: result.source, context: result.context })
        },
      )
      .get(
        "/terminal-session",
        describeRoute({
          summary: "Resolve current terminal session",
          description:
            "Reads the latest tracked terminal session metadata by terminalId or tabId. " +
            "sessionId is cleared when the terminal exits.",
          operationId: "agentHook.terminalSessionRead",
          responses: {
            200: {
              description: "Terminal session found",
              content: {
                "application/json": {
                  schema: resolver(
                    z.object({
                      success: z.boolean(),
                      source: z.string(),
                      terminalId: z.string(),
                      session: TerminalSessionPayload,
                    }),
                  ),
                },
              },
            },
            400: {
              description: "Missing identifiers",
              content: {
                "application/json": {
                  schema: resolver(
                    z.object({
                      success: z.boolean(),
                      error: z.string(),
                    }),
                  ),
                },
              },
            },
            404: {
              description: "No terminal session found",
              content: {
                "application/json": {
                  schema: resolver(
                    z.object({
                      success: z.boolean(),
                      error: z.string(),
                    }),
                  ),
                },
              },
            },
          },
        }),
        validator(
          "query",
          z.object({
            tabId: z.string().optional().describe("Resolve by tab id."),
            terminalId: z.string().optional().describe("Resolve by terminal id."),
          }),
        ),
        async (c) => {
          const query = c.req.valid("query")
          if (DEBUG) {
            log.info("terminal-session request", {
              tabId: clean(query.tabId),
              terminalId: clean(query.terminalId),
            })
          }
          if (!clean(query.tabId) && !clean(query.terminalId)) {
            return c.json({ success: false, error: "tabId or terminalId is required" }, 400)
          }
          const result = readTerminalSession({ tabId: query.tabId, terminalId: query.terminalId })
          if (!result) {
            if (DEBUG) {
              log.info("terminal-session response", {
                status: 404,
                tabId: clean(query.tabId),
                terminalId: clean(query.terminalId),
              })
            }
            return c.json({ success: false, error: "No terminal session found for given identifiers" }, 404)
          }
          if (DEBUG) {
            log.info("terminal-session response", {
              status: 200,
              source: result.source,
              terminalId: result.terminalId,
              sessionId: result.session.sessionId,
              workspaceId: result.session.workspaceId,
              provider: result.session.provider,
              refName: result.session.refName,
              prompt: result.session.prompt,
              lastAssistantMessage: result.session.lastAssistantMessage,
              eventType: result.session.eventType,
            })
          }
          return c.json({
            success: true,
            source: result.source,
            terminalId: result.terminalId,
            session: result.session,
          })
        },
      )
      // Setup endpoint - initializes agent hooks infrastructure
      .post(
        "/setup",
        describeRoute({
          summary: "Initialize agent hooks",
          description:
            "Creates wrapper scripts and shell integration files in ~/.claxedo " +
            "for intercepting CLI agent binaries (Claude, Codex, etc.)",
          operationId: "agentHook.setup",
          responses: {
            200: {
              description: "Setup completed successfully",
              content: {
                "application/json": {
                  schema: resolver(
                    z.object({
                      success: z.boolean(),
                      message: z.string(),
                      wrappers: z.array(z.string()).optional(),
                      customWrappers: z.array(z.string()).optional(),
                    }),
                  ),
                },
              },
            },
            500: {
              description: "Setup failed",
              content: {
                "application/json": {
                  schema: resolver(
                    z.object({
                      success: z.boolean(),
                      error: z.string(),
                    }),
                  ),
                },
              },
            },
          },
        }),
        validator(
          "json",
          z.object({
            port: z.number().optional().describe("Server port for callbacks"),
            force: z.boolean().optional().describe("Force overwrite existing files"),
            wrappers: z
              .array(z.string())
              .optional()
              .describe("Extra generic wrappers to create (e.g. aider, goose, pi)."),
            replaceWrappers: z
              .boolean()
              .optional()
              .describe("Replace custom wrappers instead of merging with existing list."),
          }),
        ),
        async (c) => {
          try {
            const body = c.req.valid("json")
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
              {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
              },
              500,
            )
          }
        },
      )
      // Get status of agent hooks setup
      .get(
        "/setup/status",
        describeRoute({
          summary: "Get agent hooks status",
          description: "Check if agent hooks infrastructure is properly set up",
          operationId: "agentHook.setupStatus",
          responses: {
            200: {
              description: "Status retrieved",
              content: {
                "application/json": {
                  schema: resolver(
                    z.object({
                      ready: z.boolean(),
                      wrappers: z.array(z.string()),
                      customWrappers: z.array(z.string()),
                    }),
                  ),
                },
              },
            },
          },
        }),
        async (c) => {
          const wrappers = await listWrapperAgents()
          return c.json({
            ready: isSetupComplete(),
            wrappers: wrappers.all,
            customWrappers: wrappers.custom,
          })
        },
      )
      // Get terminal environment variables for agent hooks
      .get(
        "/terminal-env",
        describeRoute({
          summary: "Get terminal environment variables",
          description:
            "Returns environment variables to pass when creating PTY sessions " + "for agent hook integration",
          operationId: "agentHook.terminalEnv",
          responses: {
            200: {
              description: "Environment variables",
              content: {
                "application/json": {
                  schema: resolver(z.record(z.string(), z.string())),
                },
              },
            },
            400: {
              description: "Missing required parameters",
              content: {
                "application/json": {
                  schema: resolver(
                    z.object({
                      success: z.boolean(),
                      error: z.string(),
                    }),
                  ),
                },
              },
            },
          },
        }),
        validator(
          "query",
          z.object({
            tabId: z.string().describe("Tab ID for tracking"),
            terminalId: z.string().describe("Terminal/PTY ID"),
            workspaceId: z.string().optional().describe("Workspace ID"),
            port: z.coerce.number().describe("Server port"),
            shell: z.string().optional().describe("Shell path (e.g., /bin/zsh)"),
          }),
        ),
        async (c) => {
          const query = c.req.valid("query")
          const env = getTerminalEnvVars({
            tabId: query.tabId,
            terminalId: query.terminalId,
            workspaceId: query.workspaceId || "",
            port: query.port,
            shell: query.shell,
          })
          return c.json(env)
        },
      )
      // Get MCP per-agent toggle state
      .get(
        "/mcp-agents",
        describeRoute({
          summary: "Get MCP per-agent status",
          description: "Returns which agents have each managed MCP server enabled/disabled",
          operationId: "agentHook.mcpAgents",
          responses: {
            200: {
              description: "MCP agent status",
              content: {
                "application/json": {
                  schema: resolver(
                    z.object({
                      servers: z.record(z.string(), z.record(z.string(), z.boolean())),
                      managed: z.array(z.string()),
                      capable: z.array(z.string()),
                    }),
                  ),
                },
              },
            },
          },
        }),
        async (c) => {
          const config = await loadMcpAgentConfig()
          return c.json({
            servers: config.servers,
            managed: [...MANAGED_MCP_SERVERS],
            capable: [...MCP_CAPABLE_AGENTS],
          })
        },
      )
      // Toggle MCP for a specific agent
      .post(
        "/mcp-agents",
        describeRoute({
          summary: "Toggle MCP for an agent",
          description: "Enable or disable a managed MCP server for a specific CLI agent",
          operationId: "agentHook.toggleMcpAgent",
          responses: {
            200: {
              description: "Toggle successful",
              content: {
                "application/json": {
                  schema: resolver(
                    z.object({
                      success: z.boolean(),
                      server: z.string(),
                      agent: z.string(),
                      enabled: z.boolean(),
                    }),
                  ),
                },
              },
            },
            400: {
              description: "Invalid agent",
              content: {
                "application/json": {
                  schema: resolver(z.object({ success: z.boolean(), error: z.string() })),
                },
              },
            },
          },
        }),
        validator(
          "json",
          z.object({
            server: z.string().describe("Managed MCP server name"),
            agent: z.string().describe("Agent name (e.g. claude, gemini, cursor, opencode)"),
            enabled: z.boolean().describe("Enable or disable this MCP server for the agent"),
          }),
        ),
        async (c) => {
          const { server, agent, enabled } = c.req.valid("json")
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
        },
      )
  )
})
