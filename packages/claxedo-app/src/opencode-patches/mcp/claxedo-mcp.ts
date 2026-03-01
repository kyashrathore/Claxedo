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
import { z } from "zod"

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

type TabPaneContext = {
  leafId: string
  name: string
  type: string
  directory?: string
  title?: string
  sessionId?: string
  terminalId?: string
  pageId?: string
  filePath?: string
  intent?: Record<string, unknown>
  meta?: Record<string, string>
}

type TabContext = {
  tabId: string
  groupId?: string
  tabType: string
  directory?: string
  title?: string
  sessionId?: string
  pageId?: string
  terminalId?: string
  activeLeafId?: string
  focusedLeafId?: string
  terminalIds?: string[]
  panes?: TabPaneContext[]
  updatedAt?: number
}

type TabContextResponse = {
  success: boolean
  source?: string
  context?: TabContext
  error?: string
}

const normalizePaneName = (value: string) => clean(value).replace(/^#/, "").toLowerCase()

const paneMeta = (meta: Record<string, string> | undefined) => {
  if (!meta) return ""
  const entries = Object.entries(meta)
    .filter((entry) => clean(entry[1]))
    .map((entry) => `${entry[0]}=${JSON.stringify(entry[1])}`)
  if (!entries.length) return ""
  return ` [${entries.join(", ")}]`
}

const paneLine = (pane: TabPaneContext) => {
  const info = [
    pane.type,
    clean(pane.pageId) ? `page=${pane.pageId}` : "",
    clean(pane.sessionId) ? `session=${pane.sessionId}` : "",
    clean(pane.terminalId) ? `terminal=${pane.terminalId}` : "",
    clean(pane.filePath) ? `file=${pane.filePath}` : "",
  ]
    .filter(Boolean)
    .join(", ")
  const role = pane.intent && typeof pane.intent.role === "string" ? ` role=${clean(pane.intent.role)}` : ""
  return `- #${pane.name} (${info || pane.type})${role}${paneMeta(pane.meta)}`
}

const tabContextPrompt = (context: TabContext, source: string, pane?: TabPaneContext) => {
  const lines = [
    `Tab context source: ${source}`,
    `Tab: ${context.tabId} (${context.tabType})`,
    clean(context.directory) ? `Directory: ${context.directory}` : "",
    clean(context.title) ? `Title: ${context.title}` : "",
    clean(context.sessionId) ? `Session: ${context.sessionId}` : "",
    clean(context.pageId) ? `Page: ${context.pageId}` : "",
    clean(context.terminalId) ? `Terminal: ${context.terminalId}` : "",
  ].filter(Boolean)

  if (pane) {
    lines.push("", "Named pane context:", paneLine(pane))
    return lines.join("\n")
  }

  const panes = context.panes ?? []
  if (panes.length) {
    lines.push("", "Named panes:", ...panes.map(paneLine))
  }
  return lines.join("\n")
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

type ProcessConfig = {
  id: string
  name: string
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  autoStart: boolean
  restartPolicy: "never" | "on-failure" | "always"
  maxRestarts: number
  color?: string
  portless?: { hostname: string; portMode: "env" | "flag"; portValue: string }
}

type ManagedProcess = {
  configId: string
  ptyId?: string
  status: "idle" | "starting" | "running" | "stopping" | "stopped" | "crashed" | "restarting"
  restartCount: number
  exitCode?: number
  startedAt?: number
  exitedAt?: number
}

type ProcessListResponse = { configs: ProcessConfig[]; processes: ManagedProcess[] }

const formatProcess = (config: ProcessConfig, proc?: ManagedProcess): string => {
  const status = proc?.status || "idle"
  const restart = proc && proc.restartCount > 0 ? ` (restarts: ${proc.restartCount})` : ""
  const exit = proc?.exitCode !== undefined ? ` exit=${proc.exitCode}` : ""
  const portless = config.portless ? ` [portless: ${config.portless.hostname}]` : ""
  return `${config.name} (${config.id}): ${status}${exit}${restart}${portless}\n  command: ${config.command}${config.args.length ? " " + config.args.join(" ") : ""}\n  restart: ${config.restartPolicy}, autoStart: ${config.autoStart}`
}

// ===========================================================================
// MCP Server
// ===========================================================================

const server = new McpServer({
  name: "claxedo-mcp",
  version: "1.0.0",
})

// ---------------------------------------------------------------------------
// Council tools
// ---------------------------------------------------------------------------

server.registerTool(
  "council",
  {
    description:
      "Run page-scoped multi-agent analysis (Council) and return a synthesized result. " +
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
// Process management tools
// ---------------------------------------------------------------------------

server.registerTool(
  "list_processes",
  {
    description:
      "List all configured processes and their runtime state (status, exit code, restart count). " +
      "Use this to see what dev servers, watchers, or other long-running processes are defined and whether they are running.",
    inputSchema: {
      directory: z.string().optional().describe("Project directory. Uses default if omitted."),
    },
  },
  async (args) => {
    const data = await httpRequest<ProcessListResponse>("/process", { method: "GET" }, "json", args.directory)
    if (!data.configs.length) {
      return { content: [{ type: "text" as const, text: "No processes configured." }] }
    }
    const lines = data.configs.map((config) => {
      const proc = data.processes.find((p) => p.configId === config.id)
      return formatProcess(config, proc)
    })
    return { content: [{ type: "text" as const, text: lines.join("\n\n") }] }
  },
)

server.registerTool(
  "start_process",
  {
    description:
      "Start a process by its config ID. Creates a PTY and begins execution. " +
      "If already running, returns the current state.",
    inputSchema: {
      id: z.string().describe("Process config ID (e.g. proc_...)."),
      directory: z.string().optional().describe("Project directory."),
    },
  },
  async (args) => {
    const proc = await httpRequest<ManagedProcess>(
      `/process/${encodeURIComponent(args.id)}/start`,
      { method: "POST" },
      "json",
      args.directory,
    )
    return {
      content: [{ type: "text" as const, text: `Process ${args.id} started. Status: ${proc.status}` }],
    }
  },
)

server.registerTool(
  "stop_process",
  {
    description: "Stop a running process by its config ID. Sends SIGTERM first, then SIGKILL after timeout.",
    inputSchema: {
      id: z.string().describe("Process config ID."),
      directory: z.string().optional().describe("Project directory."),
    },
  },
  async (args) => {
    await httpRequest<boolean>(
      `/process/${encodeURIComponent(args.id)}/stop`,
      { method: "POST" },
      "json",
      args.directory,
    )
    return { content: [{ type: "text" as const, text: `Process ${args.id} stopped.` }] }
  },
)

server.registerTool(
  "restart_process",
  {
    description: "Stop and restart a process by its config ID. Resets the restart counter.",
    inputSchema: {
      id: z.string().describe("Process config ID."),
      directory: z.string().optional().describe("Project directory."),
    },
  },
  async (args) => {
    const proc = await httpRequest<ManagedProcess>(
      `/process/${encodeURIComponent(args.id)}/restart`,
      { method: "POST" },
      "json",
      args.directory,
    )
    return {
      content: [{ type: "text" as const, text: `Process ${args.id} restarted. Status: ${proc.status}` }],
    }
  },
)

server.registerTool(
  "add_process",
  {
    description:
      "Add a new process configuration. Persists to .opencode/processes.jsonc. " +
      "The process is created in idle state — call start_process to run it.",
    inputSchema: {
      name: z.string().describe("Human-readable process name (e.g. 'dev-server', 'tailwind')."),
      command: z.string().describe("Command to run (e.g. 'npm run dev', 'bun run start')."),
      args: z.array(z.string()).optional().describe("Command arguments."),
      cwd: z.string().optional().describe("Working directory (relative to project root)."),
      env: z.record(z.string(), z.string()).optional().describe("Extra environment variables."),
      autoStart: z.boolean().optional().describe("Auto-start when project opens. Default: false."),
      restartPolicy: z.enum(["never", "on-failure", "always"]).optional().describe("Restart policy. Default: never."),
      maxRestarts: z.number().int().min(0).optional().describe("Max restart attempts. Default: 3."),
      directory: z.string().optional().describe("Project directory."),
    },
  },
  async (args) => {
    const { directory, ...body } = args
    const config = await httpRequest<ProcessConfig>(
      "/process",
      { method: "POST", body: JSON.stringify(body) },
      "json",
      directory,
    )
    return {
      content: [{ type: "text" as const, text: `Process config created: ${config.name} (${config.id})` }],
    }
  },
)

server.registerTool(
  "update_process",
  {
    description:
      "Update an existing process configuration. If the process is running, it will be restarted with the new config.",
    inputSchema: {
      id: z.string().describe("Process config ID to update."),
      name: z.string().optional().describe("New name."),
      command: z.string().optional().describe("New command."),
      args: z.array(z.string()).optional().describe("New arguments."),
      cwd: z.string().optional().describe("New working directory."),
      env: z.record(z.string(), z.string()).optional().describe("New environment variables."),
      autoStart: z.boolean().optional().describe("Auto-start flag."),
      restartPolicy: z.enum(["never", "on-failure", "always"]).optional().describe("Restart policy."),
      maxRestarts: z.number().int().min(0).optional().describe("Max restart attempts."),
      directory: z.string().optional().describe("Project directory."),
    },
  },
  async (args) => {
    const { id, directory, ...body } = args
    const config = await httpRequest<ProcessConfig>(
      `/process/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(body) },
      "json",
      directory,
    )
    return {
      content: [{ type: "text" as const, text: `Process config updated: ${config.name} (${config.id})` }],
    }
  },
)

server.registerTool(
  "remove_process",
  {
    description: "Remove a process configuration. Stops the process if running. Persists to .opencode/processes.jsonc.",
    inputSchema: {
      id: z.string().describe("Process config ID to remove."),
      directory: z.string().optional().describe("Project directory."),
    },
  },
  async (args) => {
    await httpRequest<boolean>(`/process/${encodeURIComponent(args.id)}`, { method: "DELETE" }, "json", args.directory)
    return { content: [{ type: "text" as const, text: `Process config ${args.id} removed.` }] }
  },
)

server.registerTool(
  "start_all_processes",
  {
    description: "Start all processes that have autoStart=true and are not already running.",
    inputSchema: {
      directory: z.string().optional().describe("Project directory."),
    },
  },
  async (args) => {
    await httpRequest<boolean>("/process/start-all", { method: "POST" }, "json", args.directory)
    return { content: [{ type: "text" as const, text: "All autoStart processes started." }] }
  },
)

server.registerTool(
  "stop_all_processes",
  {
    description: "Stop all currently running processes.",
    inputSchema: {
      directory: z.string().optional().describe("Project directory."),
    },
  },
  async (args) => {
    await httpRequest<boolean>("/process/stop-all", { method: "POST" }, "json", args.directory)
    return { content: [{ type: "text" as const, text: "All processes stopped." }] }
  },
)

// ---------------------------------------------------------------------------
// Page tools
// ---------------------------------------------------------------------------

server.registerTool(
  "tab_context",
  {
    description:
      "Resolve the latest Claxedo tab snapshot and named pane metadata. " +
      "Use this in terminal agents to fetch current tab state and extract pane context by name.",
    inputSchema: {
      tab_id: z.string().optional().describe("Target tab id. Defaults to CLAXEDO_TAB_ID env."),
      terminal_id: z.string().optional().describe("Target terminal id. Defaults to CLAXEDO_TERMINAL_ID env."),
      pane_name: z.string().optional().describe("Optional named pane to extract (for example: doc or #doc)."),
      format: z
        .enum(["prompt", "json"])
        .optional()
        .describe("Response format. prompt=human summary (default), json=raw structured context."),
      directory: z.string().optional().describe("Project directory."),
    },
  },
  async (args) => {
    const tabID = clean(args.tab_id) || clean(process.env.CLAXEDO_TAB_ID)
    const terminalID = clean(args.terminal_id) || clean(process.env.CLAXEDO_TERMINAL_ID)
    if (!tabID && !terminalID) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              "tab_context needs `tab_id` or `terminal_id`. " +
              "When running inside a Claxedo terminal, CLAXEDO_TAB_ID/CLAXEDO_TERMINAL_ID should be set automatically.",
          },
        ],
        isError: true,
      }
    }

    const query = new URLSearchParams()
    if (tabID) query.set("tabId", tabID)
    if (terminalID) query.set("terminalId", terminalID)

    const resolved = await httpRequest<TabContextResponse>(
      `/hook/tab-context?${query.toString()}`,
      { method: "GET" },
      "json",
      args.directory,
    ).catch(() => undefined)

    if (!resolved?.success || !resolved.context) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              "No tab context is available yet for this tab/terminal. " +
              "Focus the tab in Claxedo so it can publish a fresh snapshot, then try again.",
          },
        ],
        isError: true,
      }
    }

    const context = resolved.context
    const paneName = normalizePaneName(clean(args.pane_name))
    const pane = paneName ? context.panes?.find((item) => normalizePaneName(item.name) === paneName) : undefined

    if (paneName && !pane) {
      const names = (context.panes ?? []).map((item) => `#${item.name}`).join(", ")
      return {
        content: [
          {
            type: "text" as const,
            text: names
              ? `Pane #${paneName} was not found. Available panes: ${names}`
              : `Pane #${paneName} was not found. This tab has no named panes.`,
          },
        ],
        isError: true,
      }
    }

    const format = args.format || "prompt"
    if (format === "json") {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(pane || context, null, 2),
          },
        ],
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: tabContextPrompt(context, clean(resolved.source) || "unknown", pane),
        },
      ],
    }
  },
)

server.registerTool(
  "update_page_markdown",
  {
    description:
      "Update a page's content by importing markdown. This converts the markdown to the editor's " +
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
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport()
await server.connect(transport)
