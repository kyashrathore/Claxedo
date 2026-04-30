/**
 * Claxedo MCP Server
 *
 * Single MCP server exposing all claxedo-specific tools:
 *   - Tab context (current tab + named pane metadata)
 *   - Council (multi-agent arena orchestration)
 *   - Process management (dev servers, watchers, etc.)
 *
 * Runs as a local stdio subprocess, preconfigured in opencode.jsonc.
 *
 * Environment variables:
 *   OPENCODE_API_URL  - Base URL of the opencode server (e.g. http://localhost:4096)
 *   OPENCODE_API_DIR  - Default project directory for requests
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { registerWorkGraphTools } from "@opencode-ai/workgraph"
import { z } from "zod"
import fsPromises from "node:fs/promises"
import { Process } from "../process/process"
import { createProcessClient } from "../process/client"
import { registerBrowserTools } from "./browser-tools"
import { handleProcess } from "./process-handler"

// ---------------------------------------------------------------------------
// Shared HTTP helpers
// ---------------------------------------------------------------------------

const ORIGIN = process.env.OPENCODE_API_URL || "http://localhost:4096"
const DEFAULT_DIR = process.env.OPENCODE_API_DIR || process.cwd()

const httpRequest = async <T>(
  path: string,
  init?: RequestInit,
  mode: "json" | "text" = "json",
  directory?: string,
): Promise<T> => {
  const dir = directory || DEFAULT_DIR
  const q = `directory=${encodeURIComponent(dir)}`
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-opencode-directory": dir,
    ...(init?.headers as Record<string, string> | undefined),
  }
  const url = `${ORIGIN}${path}${path.includes("?") ? "&" : "?"}${q}`
  const res = await fetch(url, { ...init, headers })
  const text = await res.text()
  const data = mode === "text" ? text : text.trim() ? JSON.parse(text) : null
  if (res.ok) return data as T
  const detail =
    mode === "json" && data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
      ? (data as { error: string }).error
      : text || `HTTP ${res.status}`
  throw new Error(detail)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const clean = (value: unknown) => {
  if (typeof value !== "string") return ""
  return value.trim()
}

type AgentHooksStatus = {
  ready: boolean
  wrappers: string[]
  customWrappers: string[]
}

type TerminalSessionState = {
  terminalId: string
  tabId?: string
  workspaceId?: string
  provider?: string
  sessionId?: string | null
  transcriptPath?: string | null
  refName?: string
  prompt?: string
  lastAssistantMessage?: string
  eventType?: "Busy" | "Idle" | "UserActionRequired" | "Error"
  updatedAt: number
}

type TerminalSessionResponse = {
  success: boolean
  source?: string
  terminalId?: string
  session?: TerminalSessionState
  error?: string
}

type SessionMessage = {
  info?: { id?: string; role?: string }
  parts?: Array<{ type?: string; text?: string; ignored?: boolean }>
}

type AgentHooksSetup = {
  success: boolean
  message?: string
  error?: string
  wrappers?: string[]
  customWrappers?: string[]
}

// ===========================================================================
// Council (Arena) tools
// ===========================================================================

const cleanModelToken = (value: string) =>
  clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")

const extractModelsFromPrompt = (value: string) =>
  [...value.matchAll(/\b([a-z0-9._-]+\/[a-z0-9._:-]+)\b/gi)].map((item) => clean(item[1]).toLowerCase()).filter(Boolean)

const splitModel = (value: string) => {
  const source = clean(value)
  const idx = source.indexOf("/")
  if (idx < 1 || idx >= source.length - 1) return undefined
  return {
    providerID: clean(source.slice(0, idx)),
    modelID: clean(source.slice(idx + 1)),
  }
}

const arenaRoles = [
  { name: "reviewer", role: "reviewer", duty: "Review the page content and provide concrete findings." },
  { name: "critic", role: "challenger", duty: "Challenge assumptions, identify risks, and spot gaps." },
  { name: "editor", role: "synthesizer", duty: "Synthesize consensus and propose actionable next steps." },
  { name: "researcher", role: "researcher", duty: "Bring supporting evidence and alternative approaches." },
  { name: "planner", role: "planner", duty: "Turn conclusions into a prioritized execution plan." },
] as const

const deriveAgents = (models: string[]) =>
  models.slice(0, 5).map((model, index) => {
    const shape = arenaRoles[index] ?? arenaRoles[arenaRoles.length - 1] ?? arenaRoles[0]
    return { name: shape.name, role: shape.role, duty: shape.duty, model }
  })

type ArenaState = {
  arena: null | { id: string; status: string; stop_reason?: string }
  agents?: Array<{ model?: string }>
  waves: Array<{ id: string; status: string; round: number; termination?: string }>
  messages: Array<{ id: string; wave_id: string; kind: string; source: string; text: string }>
}

const summarize = (state: ArenaState, wave_id: string) => {
  const wave = state.waves.find((item) => item.id === wave_id)
  const rows = state.messages
    .filter((item) => item.wave_id === wave_id && item.kind !== "user" && item.source !== "user")
    .filter((item) => clean(item.text).length > 0)
  const lead =
    rows
      .slice()
      .reverse()
      .find((item) => item.source === "editor" || item.source === "synthesizer") || rows.at(-1)
  const rest = rows
    .filter((item) => item.id !== lead?.id)
    .slice(-4)
    .map((item) => `@${item.source}: ${clean(item.text)}`)
  const head = lead ? `@${lead.source}: ${clean(lead.text)}` : "No synthesis message was produced."
  const status = wave ? `${wave.status}${clean(wave.termination) ? ` (${clean(wave.termination)})` : ""}` : "unknown"
  return `Council run ${wave_id} status: ${status}\n\nPrimary synthesis:\n${head}${rest.length ? `\n\nAdditional viewpoints:\n${rest.join("\n\n")}` : ""}`
}

// Model validation via provider HTTP API (cached)

type ProviderListResponse = {
  all: Array<{ id: string; models: Record<string, { id: string }> }>
}

let _providerCache: ProviderListResponse | undefined

const getProviders = async (): Promise<ProviderListResponse> => {
  if (_providerCache) return _providerCache
  _providerCache = await httpRequest<ProviderListResponse>("/provider", { method: "GET" }).catch(
    () => ({ all: [] }) as ProviderListResponse,
  )
  return _providerCache
}

const validateModel = async (value: string) => {
  const parsed = splitModel(value)
  if (!parsed) return ""
  const providerID = clean(parsed.providerID)
  const modelID = clean(parsed.modelID)
  if (!providerID || !modelID) return ""
  const providers = await getProviders()
  const provider = providers.all.find((p) => p.id === providerID)
  if (!provider) return ""
  if (provider.models[modelID]) return `${providerID}/${provider.models[modelID].id}`
  for (const key of Object.keys(provider.models)) {
    if (key.includes(modelID) || modelID.includes(key)) {
      const hit = provider.models[key]
      if (!hit) continue
      return `${providerID}/${hit.id}`
    }
  }
  return ""
}

// ===========================================================================
// Process management types
// ===========================================================================

type ProcessConfig = Process.ProcessConfig
type ManagedProcess = Process.ManagedProcess

const proc = (directory?: string) =>
  createProcessClient({
    baseUrl: ORIGIN,
    directory: clean(directory) || DEFAULT_DIR,
  })

// ===========================================================================
// MCP Server
// ===========================================================================

const server = new McpServer({
  name: "claxedo-mcp",
  version: "1.0.0",
})

registerWorkGraphTools(server, httpRequest, {
  origin: `${ORIGIN}/api/workgraph`,
  directory: DEFAULT_DIR,
  mode: "prefixed",
})

// ---------------------------------------------------------------------------
// Council tools
// ---------------------------------------------------------------------------

server.registerTool(
  "council",
  {
    description:
      "[Council] Run page-scoped multi-agent analysis and return a synthesized result. " +
      "Use this for debates, reviews, and non-overlapping multi-model analysis.",
    inputSchema: {
      prompt: z.string().min(1).describe("User objective for the multi-agent run."),
      page_id: z.string().describe("Target page id (e.g. page_...). Always pass this."),
      session_id: z.string().optional().describe("Current session id, if available."),
      directory: z.string().optional().describe("Project directory, if available."),
      targets: z.array(z.string()).optional().describe("Optional @agent targets for this run."),
      models: z
        .array(z.string())
        .max(5)
        .optional()
        .describe("Optional list of provider/model ids (e.g. openai/gpt-5, anthropic/claude-sonnet-4)."),
      agents: z
        .array(
          z.object({
            name: z.string(),
            role: z.string(),
            duty: z.string(),
            model: z.string(),
            style: z.string().optional(),
            temperature: z.number().optional(),
          }),
        )
        .max(5)
        .optional()
        .describe("Optional explicit council member config."),
      timeout_ms: z
        .number()
        .int()
        .min(20_000)
        .max(10 * 60 * 1000)
        .optional()
        .describe("Optional wait timeout for wave completion."),
    },
  },
  async (args) => {
    const pageID = clean(args.page_id)
    if (!pageID) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Council needs a page id. Re-run with `page_id` (e.g. page_...) or include it in your request.",
          },
        ],
        isError: true,
      }
    }

    const directory = clean(args.directory) || DEFAULT_DIR

    // Validate models
    const candidates = [
      ...new Set(
        [...(args.models || []), ...extractModelsFromPrompt(args.prompt)]
          .map((item) => clean(item).toLowerCase())
          .filter((item) => cleanModelToken(item).length > 0),
      ),
    ]
    const checked = await Promise.all(candidates.map((item) => validateModel(item)))
    const models = [...new Set(checked.filter(Boolean))]
    const agentsFromModels = models.length ? deriveAgents(models) : undefined
    const agentsFromInput = args.agents?.length
      ? (
          await Promise.all(
            args.agents.map(async (item) => {
              const model = await validateModel(item.model)
              if (!model) return undefined
              return {
                name: clean(item.name) || "agent",
                role: clean(item.role) || "participant",
                duty: clean(item.duty) || "Contribute toward the user goal.",
                model,
                ...(clean(item.style) ? { style: clean(item.style) } : {}),
                ...(typeof item.temperature === "number" ? { temperature: item.temperature } : {}),
              }
            }),
          )
        ).filter((item): item is NonNullable<typeof item> => !!item)
      : undefined
    let agents =
      agentsFromInput && agentsFromInput.length > 0
        ? agentsFromInput
        : agentsFromModels && agentsFromModels.length > 0
          ? agentsFromModels
          : undefined
    const timeout = args.timeout_ms ?? 180_000

    const markdown = await httpRequest<string>(
      `/api/pages/${encodeURIComponent(pageID)}/export/markdown?raw=1`,
      { method: "GET" },
      "text",
      directory,
    ).catch(() => "")
    const page_context = clean(markdown).slice(0, 6000)

    const state = await httpRequest<ArenaState>(
      `/api/pages/${encodeURIComponent(pageID)}/arena/state`,
      { method: "GET" },
      "json",
      directory,
    ).catch(() => ({ arena: null, waves: [], messages: [] }) as ArenaState)

    const existingModels = (state.agents || []).map((item) => clean(item?.model)).filter(Boolean)
    const existingChecked = await Promise.all(existingModels.map((item) => validateModel(item)))
    const existingInvalid = existingModels.length > 0 && existingChecked.some((item) => !item)
    if (existingInvalid && !agents?.length) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Existing council members are configured with invalid models. Re-run with explicit valid `models` or `agents`.",
          },
        ],
        isError: true,
      }
    }

    if (!state.arena || !!agents?.length) {
      await httpRequest(
        `/api/pages/${encodeURIComponent(pageID)}/arena/start`,
        {
          method: "POST",
          body: JSON.stringify({
            directory,
            parent_session_id: clean(args.session_id),
            ...(agents?.length ? { config: { agents } } : {}),
          }),
        },
        "json",
        directory,
      )
    }

    const sent = await httpRequest<{ wave_id: string; state: ArenaState }>(
      `/api/pages/${encodeURIComponent(pageID)}/arena/message`,
      {
        method: "POST",
        body: JSON.stringify({
          text: args.prompt,
          ...(args.targets?.length ? { targets: args.targets } : {}),
          ...(page_context ? { page_context } : {}),
        }),
      },
      "json",
      directory,
    )
    const waveID = clean(sent.wave_id)

    const started = Date.now()
    let latest = sent.state
    while (Date.now() - started < timeout) {
      const wave = latest.waves.find((item) => item.id === waveID)
      if (wave && wave.status !== "running") break
      await sleep(1200)
      latest = await httpRequest<ArenaState>(
        `/api/pages/${encodeURIComponent(pageID)}/arena/state`,
        { method: "GET" },
        "json",
        directory,
      )
      const next = latest.waves.find((item) => item.id === waveID)
      if (next && next.status !== "running") break
    }

    const wave = latest.waves.find((item) => item.id === waveID)
    const done = !!wave && wave.status !== "running"
    const output = done
      ? summarize(latest, waveID)
      : `Council run ${waveID} is still running. Open Council for live progress.`

    return { content: [{ type: "text" as const, text: output }] }
  },
)

// ---------------------------------------------------------------------------
// Process management (consolidated)
// ---------------------------------------------------------------------------

server.registerTool(
  "process",
  {
    description:
      "[Process] Manage dev servers, watchers, and long-running processes. " +
      "Actions: list, start, stop, restart, add, update, remove, start_all, stop_all. " +
      "Use action='list' to see configured processes and their state. " +
      "Use action='add' with name+command to create a stable config in .claxedo/processes.jsonc, then action='start' with id to run it. " +
      "When the command binds to a network port (any dev server: vite, next, rails, etc.), include a 'port' block with " +
      "'name' (template key, e.g. 'web') and 'inject' (env var name like 'PORT', or flag like '--port'). " +
      "Without 'port.inject', port-conflict resolution can't reassign — clicking 'Use another port' will just re-run the same command.",
    inputSchema: {
      action: z
        .enum(["list", "start", "stop", "restart", "add", "update", "remove", "start_all", "stop_all"])
        .describe("Operation to perform."),
      id: z.string().optional().describe("Process config ID (e.g. proc_...). Optional for add, required for start/stop/restart/update/remove."),
      name: z.string().optional().describe("Human-readable process name. Required for add."),
      command: z.string().optional().describe("Command to run (e.g. 'npm run dev'). Required for add."),
      args: z.array(z.string()).optional().describe("Command arguments."),
      cwd: z.string().optional().describe("Working directory (relative to project root)."),
      env: z.record(z.string(), z.string()).optional().describe("Extra environment variables."),
      autoStart: z.boolean().optional().describe("Auto-start when project opens. Default: false."),
      restartPolicy: z.enum(["never", "on-failure", "always"]).optional().describe("Restart policy. Default: never."),
      maxRestarts: z.number().int().min(0).optional().describe("Max restart attempts. Default: 3."),
      color: z.string().optional().describe("Hex color for the status dot in the UI (e.g. '#3b82f6')."),
      dependsOn: z.array(z.string()).optional().describe("Names of processes that must start first. Claxedo waits for each to become ready before starting this one."),
      port: z
        .object({
          name: z
            .string()
            .regex(/^[a-z0-9._-]+$/)
            .describe("Template key for env substitution and named URLs. Other processes refer to this via {{port:<name>}} in their env."),
          inject: z
            .string()
            .describe("How Claxedo passes the chosen port to the command. Use an env var name like 'PORT' or 'CLAXEDO_SERVER_PORT', or a flag like '--port'. Required for port-conflict auto-resolution to work."),
          preferred: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Preferred port number. Claxedo tries this first, then scans upward for a free port if taken."),
          onConflict: z
            .enum(["pick-new", "kill-existing"])
            .optional()
            .describe("Auto-resolve a port conflict without prompting the user. Omit to surface a 409 and let the UI prompt."),
        })
        .optional()
        .describe("Port management config. Add this for any process that binds to a port — it enables conflict detection, env-template injection (PORT, CLAXEDO_PORT), and named-URL routing via Portless when installed."),
      directory: z.string().optional().describe("Project directory."),
    },
  },
  async (args) => {
    return handleProcess(args, httpRequest, proc, DEFAULT_DIR)
  },
)

// ---------------------------------------------------------------------------
// Log retrieval tools
// ---------------------------------------------------------------------------

type PtyInfo = { id: string; title: string; command: string; args: string[]; cwd: string; status: string; pid: number }

const messageText = (message: SessionMessage) =>
  (message.parts || [])
    .filter((part) => part.type === "text" && !part.ignored)
    .map((part) => clean(part.text))
    .filter(Boolean)
    .join("\n")

const formatSessionMessages = (messages: SessionMessage[]) =>
  messages
    .map((message, idx) => {
      const role = clean(message.info?.role) || "unknown"
      const id = clean(message.info?.id)
      const text = messageText(message)
      const body = text.length > 1200 ? `${text.slice(0, 1200)}...` : text
      return `${idx + 1}. ${role}${id ? ` [${id}]` : ""}\n${body || "(no text content)"}`
    })
    .join("\n\n")

/**
 * Resolve log-target identifiers into a URLSearchParams for the /process/logs endpoint.
 * Returns undefined when no identifier is provided.
 */
const resolveLogQuery = (args: {
  pty_id?: string
  terminal_id?: string
  process_id?: string
  name?: string
  lines?: number
}) => {
  const query = new URLSearchParams()
  if (args.lines) query.set("lines", String(args.lines))

  if (clean(args.pty_id)) {
    query.set("pty_id", clean(args.pty_id))
  } else if (clean(args.terminal_id) || clean(process.env.CLAXEDO_TERMINAL_ID)) {
    const termId = clean(args.terminal_id) || clean(process.env.CLAXEDO_TERMINAL_ID)
    if (termId) query.set("pty_id", termId)
  } else if (clean(args.process_id)) {
    query.set("process_id", clean(args.process_id))
  } else if (clean(args.name)) {
    query.set("name", clean(args.name))
  } else {
    return undefined
  }
  return query
}

server.registerTool(
  "get_logs",
  {
    description:
      "[Logs] Get terminal output (logs) from a managed process or any PTY session (terminal tab/pane). " +
      "Accepts a process config ID, process name, PTY ID, or terminal ID. " +
      "Returns the captured output from the disk-backed history (up to 16 MiB). " +
      "Use `lines` to get only the last N lines of output.",
    inputSchema: {
      process_id: z
        .string()
        .optional()
        .describe("Process config ID (e.g. proc_...). Use process(action='list') to find available IDs."),
      name: z
        .string()
        .optional()
        .describe("Process name (e.g. 'dev-server'). Case-insensitive match against configured process names."),
      pty_id: z
        .string()
        .optional()
        .describe("PTY session ID (e.g. pty_...). Use this for terminal tabs/panes that are not managed processes."),
      terminal_id: z
        .string()
        .optional()
        .describe(
          "Terminal ID from tab context. Resolves to the matching PTY session. " +
            "Defaults to CLAXEDO_TERMINAL_ID env if not provided.",
        ),
      lines: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .optional()
        .describe(
          "Return only the last N lines of output. Useful for checking recent logs without fetching everything.",
        ),
      directory: z.string().optional().describe("Project directory."),
    },
  },
  async (args) => {
    const directory = clean(args.directory) || DEFAULT_DIR

    const query = resolveLogQuery(args)
    if (!query) {
      // No identifier provided — try to list what's available
      const data = await proc(directory).list().catch(
        () => ({ configs: [] as Array<{ id: string; name: string }>, processes: [] as Array<{ configId: string; status?: string; ptyId?: string }> }),
      )
      const ptys = await httpRequest<PtyInfo[]>("/pty", { method: "GET" }, "json", directory).catch(
        () => [] as PtyInfo[],
      )

      const processLines = data.configs.map((config) => {
        const proc = data.processes.find((p) => p.configId === config.id)
        return `- ${config.name} (${config.id}) [${proc?.status || "idle"}]${proc?.ptyId ? ` pty=${proc.ptyId}` : ""}`
      })
      const ptyLines = ptys
        .filter((p) => !data.processes.some((proc) => proc.ptyId === p.id))
        .map((p) => `- ${p.title} (${p.id}) [${p.status}]`)

      const lines = [
        "No identifier provided. Specify one of: process_id, name, pty_id, or terminal_id.",
        "",
        ...(processLines.length ? ["Managed processes:", ...processLines] : ["No managed processes."]),
        ...(ptyLines.length ? ["", "Other terminal sessions:", ...ptyLines] : []),
      ]
      return { content: [{ type: "text" as const, text: lines.join("\n") }], isError: true }
    }

    try {
      const output = await httpRequest<string>(
        `/process/logs?${query.toString()}`,
        { method: "GET" },
        "text",
        directory,
      )

      if (!output || !output.trim()) {
        return { content: [{ type: "text" as const, text: "Session found but no output captured yet." }] }
      }

      return { content: [{ type: "text" as const, text: output }] }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: "text" as const, text: `Failed to get logs: ${msg}` }], isError: true }
    }
  },
)

server.registerTool(
  "get_current_session",
  {
    description:
      "[Context] Resolve the currently tracked agent session for a terminal. " +
      "This uses lifecycle hook metadata (provider/session id), not PTY log scraping.",
    inputSchema: {
      terminal_id: z.string().optional().describe("Target terminal id. Defaults to CLAXEDO_TERMINAL_ID env."),
      tab_id: z.string().optional().describe("Optional tab id fallback when terminal id is unknown."),
      format: z.enum(["prompt", "json"]).optional().describe("Response format. prompt=human summary (default)."),
      directory: z.string().optional().describe("Project directory."),
    },
  },
  async (args) => {
    const terminalID = clean(args.terminal_id) || clean(process.env.CLAXEDO_TERMINAL_ID)
    const tabID = clean(args.tab_id) || clean(process.env.CLAXEDO_TAB_ID)
    if (!terminalID && !tabID) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              "get_current_session needs `terminal_id` or `tab_id`. " +
              "When running inside a Claxedo terminal, CLAXEDO_TERMINAL_ID should be set automatically.",
          },
        ],
        isError: true,
      }
    }

    const query = new URLSearchParams()
    if (terminalID) query.set("terminalId", terminalID)
    if (tabID) query.set("tabId", tabID)

    const result = await httpRequest<TerminalSessionResponse>(
      `/api/claxedo/hook/terminal-session?${query.toString()}`,
      { method: "GET" },
      "json",
      args.directory,
    ).catch(() => undefined)

    if (!result?.success || !result.session) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No tracked terminal session found yet. Start an agent run in this terminal and try again.",
          },
        ],
        isError: true,
      }
    }

    const format = args.format || "prompt"
    if (format === "json") {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      }
    }

    const session = result.session
    const lines = [
      `Source: ${clean(result.source) || "unknown"}`,
      `Terminal: ${session.terminalId}`,
      clean(session.tabId) ? `Tab: ${session.tabId}` : "",
      clean(session.provider) ? `Provider: ${session.provider}` : "",
      session.sessionId === null
        ? "Session: null (terminal exited)"
        : clean(session.sessionId)
          ? `Session: ${session.sessionId}`
          : "Session: (none)",
      clean(session.refName) ? `Ref: ${session.refName}` : "",
      clean(session.prompt) ? `Prompt: ${session.prompt}` : "",
      clean(session.lastAssistantMessage) ? `Assistant: ${session.lastAssistantMessage}` : "",
      session.transcriptPath === null
        ? "Transcript: null"
        : clean(session.transcriptPath)
          ? `Transcript: ${session.transcriptPath}`
          : "",
      clean(session.eventType) ? `Last event: ${session.eventType}` : "",
      Number.isFinite(session.updatedAt) ? `Updated: ${new Date(session.updatedAt).toISOString()}` : "",
    ].filter(Boolean)

    return { content: [{ type: "text" as const, text: lines.join("\n") }] }
  },
)

server.registerTool(
  "session_messages",
  {
    description:
      "[Context] Get structured messages for an agent session. " +
      "Resolves current session by terminal first, then fetches `/session/:id/message` when available.",
    inputSchema: {
      session_id: z
        .string()
        .optional()
        .describe("Explicit session id. If omitted, resolve from terminal session tracking."),
      terminal_id: z
        .string()
        .optional()
        .describe("Terminal id to resolve current session. Defaults to CLAXEDO_TERMINAL_ID."),
      tab_id: z.string().optional().describe("Optional tab id fallback when terminal id is unavailable."),
      provider: z.string().optional().describe("Optional provider override (opencode, claude, codex, etc)."),
      limit: z.number().int().min(1).max(500).optional().describe("Maximum messages to fetch. Default: 50."),
      format: z.enum(["prompt", "json"]).optional().describe("Response format. prompt=human summary (default)."),
      directory: z.string().optional().describe("Project directory."),
    },
  },
  async (args) => {
    const directory = clean(args.directory) || DEFAULT_DIR
    const limit = args.limit || 50
    const format = args.format || "prompt"
    let provider = clean(args.provider).toLowerCase()
    let sessionID = clean(args.session_id)
    let transcriptPath = ""
    let source = "explicit"
    let terminalID = clean(args.terminal_id) || clean(process.env.CLAXEDO_TERMINAL_ID)
    let tabID = clean(args.tab_id) || clean(process.env.CLAXEDO_TAB_ID)

    if (!sessionID) {
      if (!terminalID && !tabID) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "session_messages needs `session_id`, or a `terminal_id`/`tab_id` to resolve current session. " +
                "When running inside a Claxedo terminal, CLAXEDO_TERMINAL_ID should be set automatically.",
            },
          ],
          isError: true,
        }
      }
      const query = new URLSearchParams()
      if (terminalID) query.set("terminalId", terminalID)
      if (tabID) query.set("tabId", tabID)
      const tracked = await httpRequest<TerminalSessionResponse>(
        `/api/claxedo/hook/terminal-session?${query.toString()}`,
        { method: "GET" },
        "json",
        directory,
      ).catch(() => undefined)
      if (!tracked?.success || !tracked.session) {
        return {
          content: [{ type: "text" as const, text: "No tracked session found for this terminal/tab yet." }],
          isError: true,
        }
      }
      source = clean(tracked.source) || "tracked"
      terminalID = clean(tracked.terminalId) || terminalID
      provider = provider || clean(tracked.session.provider).toLowerCase()
      transcriptPath = clean(tracked.session.transcriptPath)
      if (tracked.session.sessionId !== null) {
        sessionID = clean(tracked.session.sessionId)
      }
    }

    const fetchMessages = async (id: string) => {
      const query = new URLSearchParams({ limit: String(limit) })
      return httpRequest<SessionMessage[]>(
        `/session/${encodeURIComponent(id)}/message?${query.toString()}`,
        { method: "GET" },
        "json",
        directory,
      )
    }

    if (sessionID) {
      try {
        const messages = await fetchMessages(sessionID)
        if (format === "json") {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    source,
                    provider: provider || "opencode",
                    terminal_id: terminalID || undefined,
                    tab_id: tabID || undefined,
                    session_id: sessionID,
                    count: messages.length,
                    messages,
                  },
                  null,
                  2,
                ),
              },
            ],
          }
        }

        const heading = `Session ${sessionID} (${provider || "opencode"}) messages: ${messages.length}`
        const body = formatSessionMessages(messages)
        return {
          content: [{ type: "text" as const, text: `${heading}\n\n${body || "(no messages found)"}` }],
        }
      } catch (err) {
        if (!transcriptPath) {
          const msg = err instanceof Error ? err.message : String(err)
          return {
            content: [{ type: "text" as const, text: `Failed to fetch session messages: ${msg}` }],
            isError: true,
          }
        }
      }
    }

    if (!transcriptPath) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              "No structured messages available. " +
              "This provider may not expose OpenCode session routes and no transcript path was recorded.",
          },
        ],
        isError: true,
      }
    }

    let raw: string
    try {
      raw = await fsPromises.readFile(transcriptPath, "utf-8")
    } catch {
      return {
        content: [{ type: "text" as const, text: `Transcript file not found: ${transcriptPath}` }],
        isError: true,
      }
    }
    const text = raw.length > 60_000 ? raw.slice(-60_000) : raw
    if (format === "json") {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                source,
                provider: provider || undefined,
                terminal_id: terminalID || undefined,
                tab_id: tabID || undefined,
                session_id: sessionID || null,
                transcript_path: transcriptPath,
                text,
              },
              null,
              2,
            ),
          },
        ],
      }
    }

    const heading = `Transcript fallback (${provider || "unknown"})`
    return {
      content: [{ type: "text" as const, text: `${heading}\nPath: ${transcriptPath}\n\n${text}` }],
    }
  },
)

server.registerTool(
  "summarize_logs",
  {
    description:
      "[Logs] Summarize terminal output (logs) into a short title and 2-5 sentence summary using an LLM. " +
      "Pass raw log text directly via `text`, or use identifiers (process_id, name, pty_id, terminal_id) " +
      "to fetch logs first. Returns a structured title + summary.",
    inputSchema: {
      text: z
        .string()
        .optional()
        .describe("Raw log text to summarize. If provided, skips fetching logs from a process/PTY."),
      process_id: z
        .string()
        .optional()
        .describe("Process config ID (e.g. proc_...). Fetches logs from this process before summarizing."),
      name: z
        .string()
        .optional()
        .describe("Process name (e.g. 'dev-server'). Fetches logs from this process before summarizing."),
      pty_id: z
        .string()
        .optional()
        .describe("PTY session ID (e.g. pty_...). Fetches logs from this PTY before summarizing."),
      terminal_id: z
        .string()
        .optional()
        .describe("Terminal ID from tab context. Fetches logs from this terminal before summarizing."),
      lines: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .optional()
        .describe("Limit log fetch to last N lines (only used when fetching, not with raw `text`)."),
      directory: z.string().optional().describe("Project directory."),
    },
  },
  async (args) => {
    const directory = clean(args.directory) || DEFAULT_DIR
    const MAX_LOG_CHARS = 50_000

    // Step 1: Resolve log text — either from `text` param or by fetching
    let logText = clean(args.text)

    if (!logText) {
      const query = resolveLogQuery(args)
      if (!query) {
        return {
          content: [
            {
              type: "text" as const,
              text: "summarize_logs needs log text. Provide `text` directly, or specify one of: process_id, name, pty_id, terminal_id.",
            },
          ],
          isError: true,
        }
      }

      try {
        logText = await httpRequest<string>(`/process/logs?${query.toString()}`, { method: "GET" }, "text", directory)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: "text" as const, text: `Failed to fetch logs: ${msg}` }], isError: true }
      }
    }

    if (!logText || !logText.trim()) {
      return { content: [{ type: "text" as const, text: "No log output to summarize." }] }
    }

    // Truncate to last ~50K chars for model context limits
    const truncated = logText.length > MAX_LOG_CHARS ? logText.slice(-MAX_LOG_CHARS) : logText

    // Step 2: Create a temporary session
    let sessionID: string
    try {
      const data = (await httpRequest(
        "/session",
        { method: "POST", body: JSON.stringify({ title: "Log Summary" }) },
        "json",
        directory,
      )) as { id?: string; data?: { id?: string } } | null
      sessionID = clean(data?.id || data?.data?.id)
      if (!sessionID) throw new Error("No session id returned")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: "text" as const, text: `Failed to create session: ${msg}` }], isError: true }
    }

    // Step 3: Send message with log analysis prompt
    const system = [
      "You are a log analysis assistant. Analyze the provided terminal/process output and return a JSON object with exactly two fields:",
      '- "title": A concise title (max 80 characters) describing what the logs show (e.g. "Next.js dev server startup with 3 TypeScript errors")',
      '- "summary": A 2-5 sentence summary of the key information, errors, warnings, or status shown in the logs.',
      "",
      "Return ONLY valid JSON, no markdown fences, no extra text.",
      'Example: {"title": "Vite build failed with missing module", "summary": "The Vite build process failed due to a missing module \'@utils/helpers\'. The error occurred during the transform phase at line 42 of src/index.ts. This is likely caused by a missing dependency or incorrect import path."}',
    ].join("\n")

    type MessageResult = {
      info?: { id?: string; error?: { message?: string; data?: { message?: string } } | null }
      parts?: Array<{ type: string; text?: string; ignored?: boolean }>
    }

    // Clean up the temporary session after use
    const deleteSession = () => {
      httpRequest(
        `/session/${encodeURIComponent(sessionID)}`,
        { method: "DELETE" },
        "json",
        directory,
      ).catch(() => {})
    }

    try {
      const result = (await httpRequest(
        `/session/${encodeURIComponent(sessionID)}/message`,
        {
          method: "POST",
          body: JSON.stringify({
            system,
            parts: [{ type: "text", text: truncated }],
          }),
        },
        "json",
        directory,
      )) as MessageResult | null

      // Try to get text from message detail if direct result is empty
      let responseText = (result?.parts || [])
        .filter((p) => p.type === "text" && !p.ignored)
        .map((p) => p.text || "")
        .join("")
        .trim()

      if (!responseText && result?.info?.id) {
        const detail = (await httpRequest(
          `/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(result.info.id)}`,
          { method: "GET" },
          "json",
          directory,
        )) as MessageResult | null
        responseText = (detail?.parts || [])
          .filter((p) => p.type === "text" && !p.ignored)
          .map((p) => p.text || "")
          .join("")
          .trim()
      }

      if (!responseText) {
        const errMsg = result?.info?.error?.data?.message || result?.info?.error?.message
        return {
          content: [{ type: "text" as const, text: errMsg ? `LLM error: ${errMsg}` : "LLM returned empty response." }],
          isError: true,
        }
      }

      // Step 4: Parse JSON from response
      try {
        // Strip markdown fences if present
        const jsonStr = responseText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "")
        const parsed = JSON.parse(jsonStr) as { title?: string; summary?: string }
        const title = clean(parsed.title).slice(0, 80) || "Log Summary"
        const summary = clean(parsed.summary) || responseText
        return {
          content: [{ type: "text" as const, text: `**${title}**\n\n${summary}` }],
        }
      } catch {
        // If JSON parsing fails, return the raw LLM response
        return {
          content: [{ type: "text" as const, text: responseText }],
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: "text" as const, text: `Failed to summarize logs: ${msg}` }], isError: true }
    } finally {
      deleteSession()
    }
  },
)

server.registerTool(
  "agent_hooks_status",
  {
    description:
      "[Admin] Get Claxedo agent hook readiness and active wrapper binaries. " +
      "Use this to debug why CLI agent lifecycle status might be missing in panes.",
    inputSchema: {
      directory: z.string().optional().describe("Project directory."),
    },
  },
  async (args) => {
    const status = await httpRequest<AgentHooksStatus>("/api/claxedo/hook/setup/status", { method: "GET" }, "json", args.directory)
    const wrappers = status.wrappers?.length ? status.wrappers.join(", ") : "(none)"
    const custom = status.customWrappers?.length ? status.customWrappers.join(", ") : "(none)"
    return {
      content: [
        {
          type: "text" as const,
          text: `Agent hooks ready: ${status.ready ? "yes" : "no"}\nWrappers: ${wrappers}\nCustom wrappers: ${custom}`,
        },
      ],
    }
  },
)

server.registerTool(
  "configure_agent_wrappers",
  {
    description:
      "[Admin] Configure extra generic CLI wrappers for lifecycle tracking (for example aider, goose, pi), then re-run setup. " +
      "Wrapper names are sanitized and restricted to safe binary-like identifiers.",
    inputSchema: {
      wrappers: z
        .array(z.string())
        .optional()
        .describe("Wrapper names to add or replace (e.g. ['aider','goose','pi'])."),
      replace: z
        .boolean()
        .optional()
        .describe("Replace current custom wrapper list instead of merging. Default: false."),
      force: z.boolean().optional().describe("Force overwrite generated wrapper files. Default: false."),
      directory: z.string().optional().describe("Project directory."),
    },
  },
  async (args) => {
    const payload = {
      force: args.force ?? false,
      wrappers: args.wrappers,
      replaceWrappers: args.replace ?? false,
    }
    const result = await httpRequest<AgentHooksSetup>(
      "/api/claxedo/hook/setup",
      { method: "POST", body: JSON.stringify(payload) },
      "json",
      args.directory,
    )

    if (!result.success) {
      return {
        content: [{ type: "text" as const, text: result.error || "Failed to configure agent wrappers." }],
        isError: true,
      }
    }

    const wrappers = (result.wrappers ?? []).join(", ") || "(none)"
    const custom = (result.customWrappers ?? []).join(", ") || "(none)"
    return {
      content: [
        {
          type: "text" as const,
          text: `${result.message || "Agent hooks configured."}\nWrappers: ${wrappers}\nCustom wrappers: ${custom}`,
        },
      ],
    }
  },
)

server.registerTool(
  "update_page_markdown",
  {
    description:
      "[Pages] Update a page's content by importing markdown. This converts the markdown to the editor's " +
      "internal format and triggers a re-render. Use this instead of writing to the .md mirror file directly — " +
      "direct file edits cause sync conflicts and won't re-render until manually synced.",
    inputSchema: {
      page_id: z.string().describe("Page ID (e.g. page_...)."),
      markdown: z.string().min(1).describe("Full markdown content to import into the page."),
      directory: z.string().optional().describe("Project directory."),
    },
  },
  async (args) => {
    const pageID = clean(args.page_id)
    if (!pageID) {
      return {
        content: [{ type: "text" as const, text: "page_id is required." }],
        isError: true,
      }
    }
    const result = await httpRequest<{ imported: boolean; conflict: boolean }>(
      `/api/pages/${encodeURIComponent(pageID)}/import/markdown`,
      { method: "POST", body: JSON.stringify({ markdown: args.markdown, force: true }) },
      "json",
      args.directory,
    )
    return {
      content: [
        {
          type: "text" as const,
          text: result.imported
            ? `Page ${pageID} updated. Reload the page tab to see changes.`
            : `Page ${pageID} content unchanged (markdown matches current content).`,
        },
      ],
    }
  },
)

// ---------------------------------------------------------------------------
// Batch Issues — parallel worktree agent spawning
// ---------------------------------------------------------------------------

import { handleBatchIssues } from "./batch-issues"

server.registerTool(
  "batch_issues",
  {
    description:
      "[Batch] Spawn parallel worktree agents for multiple issues. " +
      "Creates a git worktree for each issue and starts an agent (opencode session or CLI agent in PTY). " +
      "Use this when a user wants to work on multiple issues simultaneously.",
    inputSchema: {
      issues: z
        .array(
          z.object({
            title: z.string().min(1).describe("Short title for the issue / worktree branch name."),
            prompt: z.string().min(1).describe("Full prompt text to send to the agent."),
          }),
        )
        .min(1)
        .max(10)
        .describe("List of issues to process (max 10)."),
      agent: z
        .enum(["opencode", "claude", "codex", "aider"])
        .default("opencode")
        .describe("Agent type. 'opencode' uses built-in session, others spawn a CLI agent in a PTY."),
      model: z
        .string()
        .optional()
        .describe("Optional model override (e.g. 'anthropic/claude-sonnet-4'). Only used for opencode agent."),
      directory: z.string().optional().describe("Project directory. Defaults to OPENCODE_API_DIR."),
    },
  },
  async (args) => {
    return handleBatchIssues(
      {
        issues: args.issues,
        agent: args.agent,
        model: args.model,
        directory: args.directory,
      },
      httpRequest,
      sleep,
    )
  },
)

// ---------------------------------------------------------------------------
// Browser tab tools (agentic <webview> via desktop main bridge)
// ---------------------------------------------------------------------------

registerBrowserTools(server)

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport()
await server.connect(transport)
