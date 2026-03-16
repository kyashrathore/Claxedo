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
import { Process } from "../process/process"
import { createProcessClient } from "../process/client"
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

type ProcessConfig = Process.ProcessConfig
type ManagedProcess = Process.ManagedProcess
type ProcessListResponse = Process.ListResponse
type LaunchResult = Process.LaunchResult

const formatProcess = (config: ProcessConfig, proc?: ManagedProcess): string => {
  const status = proc?.status || "idle"
  const restart = proc && proc.restartCount > 0 ? ` (restarts: ${proc.restartCount})` : ""
  const exit = proc?.exitCode !== undefined ? ` exit=${proc.exitCode}` : ""
  const port = config.port ? ` [port: ${config.port.name}${proc?.assignedPort ? `=${proc.assignedPort}` : ""}]` : ""
  return `${config.name} (${config.id}): ${status}${exit}${restart}${port}\n  command: ${config.command}${config.args.length ? " " + config.args.join(" ") : ""}\n  restart: ${config.restartPolicy}, autoStart: ${config.autoStart}`
}

const findConfigByPortName = (
  name: string,
  data: ProcessListResponse,
): { config: ProcessConfig; proc?: ManagedProcess } | undefined => {
  const config = data.configs.find((c) => c.port?.name === name)
  if (!config) return undefined
  const proc = data.processes.find((p) => p.configId === config.id)
  return { config, proc }
}

const proc = (directory?: string) =>
  createProcessClient({
    baseUrl: ORIGIN,
    directory: clean(directory) || DEFAULT_DIR,
  })

const detail = (proc: ManagedProcess) => {
  const port = proc.assignedPort ? ` on port ${proc.assignedPort}` : ""
  return `${proc.status}${port}`
}

const launch = (id: string, out: LaunchResult, ok: string, fail: string) => {
  if (out.kind === "started") {
    return { text: `Process ${id} ${ok}. Status: ${detail(out.process)}` }
  }
  if (out.kind === "already_running") {
    return { text: `Process ${id} is already running. Status: ${detail(out.process)}` }
  }
  if (out.kind === "port_conflict") {
    const owner = out.conflict.processName ? ` (${out.conflict.processName})` : ""
    return {
      text: `Process ${id} could not ${fail}: preferred port ${out.conflict.port} is in use${owner}.`,
      isError: true as const,
    }
  }
  return {
    text: `Process ${id} could not ${fail}: ${out.error}`,
    isError: true as const,
  }
}

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
  mode: "both",
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
      "Use action='add' with name+command to create a new config, then action='start' with id to run it.",
    inputSchema: {
      action: z
        .enum(["list", "start", "stop", "restart", "add", "update", "remove", "start_all", "stop_all"])
        .describe("Operation to perform."),
      id: z.string().optional().describe("Process config ID (e.g. proc_...). Required for start/stop/restart/update/remove."),
      name: z.string().optional().describe("Human-readable process name. Required for add."),
      command: z.string().optional().describe("Command to run (e.g. 'npm run dev'). Required for add."),
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
    return handleProcess(args, httpRequest, proc, DEFAULT_DIR)
  },
)

// ---------------------------------------------------------------------------
// Portpick tools (port-based process management)
// ---------------------------------------------------------------------------

server.registerTool(
  "portpick_register",
  {
    description:
      "Register a new dev server or long-running process with automatic port assignment. " +
      "This creates a process config in .opencode/processes.jsonc. The process starts idle — " +
      "call portpick_start afterward to launch it. " +
      "Each process gets a unique port name (e.g. 'api', 'frontend') that other processes can reference " +
      "using {{port:name}} templates in their env vars. " +
      "Example: register a Vite frontend with env VITE_API_URL=http://localhost:{{port:api}} " +
      "so it automatically discovers the API server's port.",
    inputSchema: {
      name: z.string().regex(/^[a-z0-9._-]+$/).describe(
        "Unique port name for this process (lowercase alphanumeric, dots, hyphens). " +
        "Used as the identifier in {{port:name}} templates. Example: 'api', 'frontend', 'opencode'.",
      ),
      command: z.string().describe("Shell command to run (e.g. 'bun run dev', 'npm start', 'cargo watch -x run')."),
      cwd: z.string().optional().describe("Working directory relative to project root. Defaults to project root."),
      port_via: z
        .string()
        .describe(
          "How to pass the assigned port to the process. " +
          "Env var name (e.g. 'PORT', 'VITE_PORT') sets that env var. " +
          "CLI flag (e.g. '--port', '-p') appends the flag and port number to the command.",
        ),
      env: z.record(z.string(), z.string()).optional().describe(
        "Extra environment variables. Use {{port:name}} to reference another process's port. " +
        "Example: { \"BACKEND_URL\": \"http://localhost:{{port:api}}\" }",
      ),
      depends_on: z.array(z.string()).optional().describe(
        "Process names that must be running before this one starts. " +
        "Dependencies are auto-started when this process starts. " +
        "Port template dependencies ({{port:name}}) are auto-detected — you only need this for non-port dependencies.",
      ),
      preferred_port: z.number().int().positive().optional().describe(
        "Preferred port number. Tries this port first; if occupied, applies on_conflict strategy.",
      ),
      on_conflict: z.enum(["pick-new", "kill-existing"]).optional().describe(
        "What to do when the preferred port is occupied. " +
        "'pick-new' (default): scan upward to the next free port for this workspace. " +
        "'kill-existing': kill the process on that port and take it.",
      ),
      auto_start: z.boolean().optional().describe("Automatically start when the project opens. Default: false."),
      restart_policy: z.enum(["never", "on-failure", "always"]).optional().describe("When to restart after exit. Default: never."),
      directory: z.string().optional().describe("Project directory."),
    },
  },
  async (args) => {
    const { directory, name, command, cwd, port_via, env, depends_on, preferred_port, on_conflict, auto_start, restart_policy } = args
    const body = {
      name,
      command,
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
      ...(depends_on?.length ? { dependsOn: depends_on } : {}),
      autoStart: auto_start ?? false,
      restartPolicy: restart_policy ?? "never",
      port: {
        name,
        inject: port_via,
        ...(preferred_port ? { preferred: preferred_port } : {}),
        ...(on_conflict ? { onConflict: on_conflict } : {}),
      },
    }
    const config = await httpRequest<ProcessConfig>(
      "/process",
      { method: "POST", body: JSON.stringify(body) },
      "json",
      directory,
    )
    return {
      content: [
        {
          type: "text" as const,
          text: `Registered portpick process: ${config.name} (${config.id})\n  port.name=${name}, port.inject=${port_via}`,
        },
      ],
    }
  },
)

server.registerTool(
  "portpick_start",
  {
    description:
      "Start a registered portpick process by its port name. " +
      "Finds a free OS port, injects it into the process (via env var or CLI flag as configured), " +
      "and resolves any {{port:name}} templates in its env vars using ports from already-running processes. " +
      'Pass "*" to start all portpick processes in config order (dependencies first). ' +
      "Important: if process B depends on process A's port (via {{port:A}}), start A first " +
      "so its port is available for template resolution.",
    inputSchema: {
      name: z.string().describe(
        'Port name of the process to start (e.g. "api", "frontend"). ' +
        'Pass "*" to start all portpick processes sequentially in config order.',
      ),
      directory: z.string().optional().describe("Project directory."),
    },
  },
  async (args) => {
    const directory = clean(args.directory) || DEFAULT_DIR
    const client = proc(directory)
    const data = await client.list()

    if (args.name === "*") {
      const portConfigs = data.configs.filter((c) => c.port)
      if (!portConfigs.length) {
        return { content: [{ type: "text" as const, text: "No portpick processes configured." }] }
      }
      const results: string[] = []
      for (const config of portConfigs) {
        const running = data.processes.find((p) => p.configId === config.id)
        if (running && (running.status === "running" || running.status === "starting")) {
          results.push(`${config.port!.name}: already running`)
          continue
        }
        const out = await client.start(config.id, { interactive: false })
        if (out.kind === "started" || out.kind === "already_running") {
          results.push(`${config.port!.name}: ${out.process.status}${out.process.assignedPort ? ` (port ${out.process.assignedPort})` : ""}`)
          continue
        }
        if (out.kind === "port_conflict") {
          results.push(`${config.port!.name}: port conflict on ${out.conflict.port}`)
          continue
        }
        results.push(`${config.port!.name}: failed (${out.error})`)
      }
      return { content: [{ type: "text" as const, text: results.join("\n") }] }
    }

    const found = findConfigByPortName(args.name, data)
    if (!found) {
      return {
        content: [{ type: "text" as const, text: `No portpick process with name "${args.name}" found.` }],
        isError: true,
      }
    }
    const out = await client.start(found.config.id, { interactive: false })
    if (out.kind !== "started" && out.kind !== "already_running") {
      if (out.kind === "port_conflict") {
        return {
          content: [{ type: "text" as const, text: `Could not start ${args.name}: preferred port ${out.conflict.port} is in use.` }],
          isError: true,
        }
      }
      return {
        content: [{ type: "text" as const, text: `Could not start ${args.name}: ${out.error}` }],
        isError: true,
      }
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `Started ${args.name} (${found.config.id}): ${out.process.status}${out.process.assignedPort ? ` on port ${out.process.assignedPort}` : ""}`,
        },
      ],
    }
  },
)

server.registerTool(
  "portpick_stop",
  {
    description:
      "Stop a running portpick process by its port name. " +
      "Sends Ctrl-C, then SIGTERM after 2s, then SIGKILL after 5s. " +
      "The assigned port is released and will not be reused on next start (a new port is picked). " +
      'Pass "*" to stop all portpick processes in reverse config order. ' +
      "Stop dependent processes first to avoid connection errors.",
    inputSchema: {
      name: z.string().describe(
        'Port name of the process to stop (e.g. "api"). ' +
        'Pass "*" to stop all portpick processes.',
      ),
      directory: z.string().optional().describe("Project directory."),
    },
  },
  async (args) => {
    const directory = clean(args.directory) || DEFAULT_DIR
    const client = proc(directory)
    const data = await client.list()

    if (args.name === "*") {
      const portConfigs = data.configs.filter((c) => c.port)
      if (!portConfigs.length) {
        return { content: [{ type: "text" as const, text: "No portpick processes configured." }] }
      }
      for (const config of [...portConfigs].reverse()) {
        const proc = data.processes.find((p) => p.configId === config.id)
        if (proc && (proc.status === "running" || proc.status === "starting" || proc.status === "restarting")) {
          await client.stop(config.id)
        }
      }
      return { content: [{ type: "text" as const, text: "All portpick processes stopped." }] }
    }

    const found = findConfigByPortName(args.name, data)
    if (!found) {
      return {
        content: [{ type: "text" as const, text: `No portpick process with name "${args.name}" found.` }],
        isError: true,
      }
    }
    await client.stop(found.config.id)
    return { content: [{ type: "text" as const, text: `Stopped ${args.name} (${found.config.id}).` }] }
  },
)

server.registerTool(
  "portpick_list",
  {
    description:
      "List all portpick-enabled processes with their current state. " +
      "Shows each process's port name, assigned port number (if running), status, command, and injection method. " +
      "Use this to discover available port names for {{port:name}} templates, " +
      "check which ports are currently assigned, or verify processes are running before making requests.",
    inputSchema: {
      directory: z.string().optional().describe("Project directory."),
    },
  },
  async (args) => {
    const data = await proc(args.directory).list()
    const portConfigs = data.configs.filter((c) => c.port)
    if (!portConfigs.length) {
      return { content: [{ type: "text" as const, text: "No portpick processes configured." }] }
    }
    const lines = portConfigs.map((config) => {
      const proc = data.processes.find((p) => p.configId === config.id)
      const status = proc?.status || "idle"
      const port = proc?.assignedPort ? `:${proc.assignedPort}` : ""
      return `${config.port!.name}${port} (${config.id}): ${status}\n  command: ${config.command}\n  inject: ${config.port!.inject}`
    })
    return { content: [{ type: "text" as const, text: lines.join("\n\n") }] }
  },
)

server.registerTool(
  "portpick_remove",
  {
    description:
      "Remove a portpick process configuration by its port name. " +
      "If the process is currently running, it is stopped first. " +
      "The config is deleted from .opencode/processes.jsonc. " +
      "Any other processes referencing this port name via {{port:name}} templates " +
      "will have unresolved templates on their next start.",
    inputSchema: {
      name: z.string().describe("Port name of the process to remove (e.g. 'api')."),
      directory: z.string().optional().describe("Project directory."),
    },
  },
  async (args) => {
    const directory = clean(args.directory) || DEFAULT_DIR
    const data = await proc(directory).list()
    const found = findConfigByPortName(args.name, data)
    if (!found) {
      return {
        content: [{ type: "text" as const, text: `No portpick process with name "${args.name}" found.` }],
        isError: true,
      }
    }
    await httpRequest<boolean>(
      `/process/${encodeURIComponent(found.config.id)}`,
      { method: "DELETE" },
      "json",
      directory,
    )
    return { content: [{ type: "text" as const, text: `Removed portpick process "${args.name}" (${found.config.id}).` }] }
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
        () => ({ configs: [], processes: [] } as { configs: any[]; processes: any[] }),
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
      `/hook/terminal-session?${query.toString()}`,
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
        `/hook/terminal-session?${query.toString()}`,
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

    const file = Bun.file(transcriptPath)
    if (!(await file.exists())) {
      return {
        content: [{ type: "text" as const, text: `Transcript file not found: ${transcriptPath}` }],
        isError: true,
      }
    }

    const raw = await file.text()
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

// ---------------------------------------------------------------------------
// Page tools
// ---------------------------------------------------------------------------

server.registerTool(
  "tab_context",
  {
    description:
      "[Context] Resolve the latest Claxedo tab snapshot and named pane metadata. " +
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
    const status = await httpRequest<AgentHooksStatus>("/hook/setup/status", { method: "GET" }, "json", args.directory)
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
      "/hook/setup",
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
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport()
await server.connect(transport)
