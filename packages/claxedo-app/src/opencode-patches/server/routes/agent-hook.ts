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
import { Log } from "@/util/log"
import { lazy } from "@/util/lazy"
import { setupAgentHooks, getTerminalEnvVars, isSetupComplete } from "@/agent-hooks"
import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import path from "node:path"
import { mkdirSync } from "node:fs"
import z from "zod"

const log = Log.create({ service: "agent-hook" })
const DEBUG = process.env.CLAXEDO_DEBUG === "1"

/**
 * Agent lifecycle event types
 */
export const AgentEventType = z.enum(["Start", "Stop", "PermissionRequest"])
export type AgentEventType = z.infer<typeof AgentEventType>

/**
 * Agent lifecycle event payload
 */
export const AgentLifecyclePayload = z.object({
  tabId: z.string().describe("Tab ID in Claxedo UI"),
  terminalId: z.string().optional().describe("PTY terminal ID"),
  workspaceId: z.string().optional().describe("Workspace/project ID"),
  eventType: AgentEventType.describe("Lifecycle event type"),
})
export type AgentLifecyclePayload = z.infer<typeof AgentLifecyclePayload>

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
  pageId: z.string().optional().describe("Page id if this tab is page-like."),
  terminalId: z.string().optional().describe("Primary terminal id if this tab is terminal-like."),
  activeLeafId: z.string().optional().describe("Active multi-pane leaf id if available."),
  focusedLeafId: z.string().optional().describe("Focused multi-pane leaf id if available."),
  terminalIds: z.array(z.string()).optional().describe("All terminal ids present in this tab's pane tree."),
  panes: z.array(TabPaneContextPayload).optional().describe("Named pane contexts for the current tab layout."),
  updatedAt: z.number().optional().describe("Snapshot timestamp in milliseconds since epoch."),
})
type TabContextPayload = z.infer<typeof TabContextPayload>

const positive = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.round(parsed)
}

const TAB_CONTEXT_TTL_MS = positive(process.env.CLAXEDO_TAB_CONTEXT_TTL_MS, 30 * 24 * 60 * 60 * 1000)
const TAB_CONTEXT_MAX = positive(process.env.CLAXEDO_TAB_CONTEXT_MAX, 600)

const dataDir = process.env.CLAXEDO_DATA_DIR || path.join(homedir(), ".claxedo")

const tabContextDB = lazy(() => {
  mkdirSync(dataDir, { recursive: true })
  const db = new Database(path.join(dataDir, "tab-context.db"))
  db.exec("PRAGMA journal_mode=WAL")
  db.exec(`
    CREATE TABLE IF NOT EXISTS tab_context (
      tab_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tab_context_updated ON tab_context(updated_at DESC);
    CREATE TABLE IF NOT EXISTS tab_context_terminal (
      terminal_id TEXT PRIMARY KEY,
      tab_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tab_context_terminal_tab ON tab_context_terminal(tab_id);
  `)
  return db
})

const tabContexts = new Map<string, TabContextPayload & { updatedAt: number }>()
const terminalToTab = new Map<string, string>()

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
  const db = tabContextDB()
  db.query("DELETE FROM tab_context WHERE updated_at < ?").run(cutoff)
  db.query("DELETE FROM tab_context_terminal WHERE updated_at < ?").run(cutoff)
  db.query(
    "DELETE FROM tab_context WHERE tab_id IN (SELECT tab_id FROM tab_context ORDER BY updated_at DESC LIMIT -1 OFFSET ?)",
  ).run(TAB_CONTEXT_MAX)
  db.query("DELETE FROM tab_context_terminal WHERE tab_id NOT IN (SELECT tab_id FROM tab_context)").run()
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
  const db = tabContextDB()
  db.query(
    "INSERT INTO tab_context (tab_id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(tab_id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at",
  ).run(context.tabId, JSON.stringify(context), context.updatedAt)
  db.query("DELETE FROM tab_context_terminal WHERE tab_id = ?").run(context.tabId)
  for (const terminalId of terminalIdsForContext(context)) {
    db.query(
      "INSERT INTO tab_context_terminal (terminal_id, tab_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(terminal_id) DO UPDATE SET tab_id=excluded.tab_id, updated_at=excluded.updated_at",
    ).run(terminalId, context.tabId, context.updatedAt)
  }
  prunePersistentTabContexts(context.updatedAt)
}

const loadContextByTab = (tabId: string) => {
  const row = tabContextDB().query("SELECT payload FROM tab_context WHERE tab_id = ?").get(tabId) as
    | { payload?: string }
    | undefined
  const payload = clean(row?.payload)
  if (!payload) return
  return parseContextPayload(payload)
}

const loadContextByTerminal = (terminalId: string) => {
  const row = tabContextDB()
    .query(
      "SELECT t.payload FROM tab_context_terminal m JOIN tab_context t ON t.tab_id = m.tab_id WHERE m.terminal_id = ? LIMIT 1",
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

export const AgentHookRoutes = lazy(() =>
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
        const tabId = c.req.query("tabId")
        const terminalId = c.req.query("terminalId")
        const workspaceId = c.req.query("workspaceId")
        const eventType = c.req.query("eventType")

        if (DEBUG) {
          log.info("agent-lifecycle GET received", {
            tabId,
            terminalId,
            workspaceId,
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

        // Validate eventType
        const parsed = AgentEventType.safeParse(eventType)
        if (!parsed.success) {
          log.warn("Invalid eventType", { eventType, tabId })
          return c.json({ success: false, error: `Invalid eventType: ${eventType}` }, 400)
        }

        log.info("agent lifecycle", {
          tabId,
          terminalId,
          workspaceId,
          eventType: parsed.data,
        })

        // Publish event for frontend to consume via SSE
        // Use "global" directory so the frontend listener receives it
        const busPayload = {
          directory: "global",
          payload: {
            type: AgentLifecycleEvent.type,
            properties: {
              tabId,
              terminalId,
              workspaceId,
              eventType: parsed.data,
            },
          },
        }

        if (DEBUG) {
          log.info("Emitting to GlobalBus", busPayload)
        }

        GlobalBus.emit("event", busPayload)

        return c.json({
          success: true,
          tabId,
          eventType: parsed.data,
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
      validator("json", AgentLifecyclePayload),
      async (c) => {
        const payload = c.req.valid("json")

        log.info("agent lifecycle (POST)", payload)

        // Publish event for frontend to consume via SSE
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: AgentLifecycleEvent.type,
            properties: payload,
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
        }),
      ),
      async (c) => {
        try {
          const body = c.req.valid("json")
          await setupAgentHooks({
            port: body.port,
            force: body.force,
          })
          return c.json({
            success: true,
            message: "Agent hooks initialized successfully",
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
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({ ready: isSetupComplete() })
      },
    )
    // Get terminal environment variables for agent hooks
    .get(
      "/terminal-env",
      describeRoute({
        summary: "Get terminal environment variables",
        description: "Returns environment variables to pass when creating PTY sessions " + "for agent hook integration",
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
    ),
)
