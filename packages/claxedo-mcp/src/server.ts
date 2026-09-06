#!/usr/bin/env node
/**
 * Claxedo MCP Server
 *
 * Small MCP surface for Claxedo runtime operations:
 *   - process config and process lifecycle management
 *   - process/terminal log retrieval
 *   - session message retrieval for chats and terminal-tracked agents
 *   - log summarization
 *   - browser pane tools through the Claxedo desktop bridge
 *
 * Environment variables:
 *   CLAXEDO_SERVER_URL - Base URL of the Claxedo local control plane
 *   CLAXEDO_API_DIR    - Default project directory for requests
 *   CLAXEDO_WORKSPACE_ID - Default workspace id for Docker/cloud workspace requests
 *   CLAXEDO_AUTH_TOKEN - Optional signed remote server auth token
 *   CLAXEDO_SESSION_ID - Optional current session id for documents_open and the documents CLI
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import fsPromises from "node:fs/promises"
import { z } from "zod"
import { registerBrowserTools } from "./browser-tools"
import { bool, num, oneOf, record, records, strings, text } from "./json"
import { createControlPlaneClient } from "./control-plane-request"
import { toCallToolResult, type McpToolConfig, type McpToolExtra, type McpToolResult, type McpToolShape } from "./mcp-tool"
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js"
import { handleProcess, parseLaunchResult, parseListResponse, type ProcessClient } from "./process-handler"
import { formatSessionMessages, parseSessionMessage, parseSessionMessages, resolveResponseText } from "./message-text"
import { claxedoMcpReadOnly } from "./tool-policy"
import { resolveTranscriptPath } from "./transcript-path"
import { registerDocumentTools } from "./documents-tools"
import { runDocumentsCli } from "./documents-cli"
import { registerCloudWorkspaceTools } from "./cloud-workspace-tools"

const clean = (value: unknown) => {
  if (typeof value !== "string") return ""
  return value.trim()
}

const workspaceRef = (id: string) => `workspace:${id}`
const requestDirectory = (args: { directory?: string; workspace_id?: string }) =>
  clean(args.directory) || (clean(args.workspace_id) ? workspaceRef(clean(args.workspace_id)) : DEFAULT_DIR)

const ORIGIN = clean(process.env.CLAXEDO_SERVER_URL) || "http://127.0.0.1:2593"
const DEFAULT_WORKSPACE_ID = clean(process.env.CLAXEDO_WORKSPACE_ID)
const DEFAULT_DIR = clean(process.env.CLAXEDO_API_DIR) || (DEFAULT_WORKSPACE_ID ? workspaceRef(DEFAULT_WORKSPACE_ID) : process.cwd())
const DEFAULT_SESSION_ID = clean(process.env.CLAXEDO_SESSION_ID)
const TOKEN = clean(process.env.CLAXEDO_AUTH_TOKEN)
const READ_ONLY = claxedoMcpReadOnly()

const PROCESS_PATH = "/api/wr/process"
const PTY_PATH = "/api/wr/pty"

const controlPlane = {
  origin: ORIGIN,
  token: TOKEN || undefined,
  defaultDirectory: DEFAULT_DIR,
  defaultWorkspaceId: DEFAULT_WORKSPACE_ID || undefined,
}

/** Workspace-scoped: every call carries the directory the tool was asked about. */
const control = createControlPlaneClient(controlPlane)
/** Owner-scoped: addresses the signed-in user, so it carries no directory. */
const ownerControl = createControlPlaneClient({ ...controlPlane, scope: "owner" })

type TerminalSessionState = {
  terminalId: string
  tabId?: string
  workspaceId?: string
  provider?: string
  providerSessionId?: string | null
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

type PtyInfo = {
  id: string
  title: string
  command: string
  args: string[]
  cwd: string
  status: string
  pid: number
}

/** Only id, title and status are rendered; a row without them cannot be listed. */
function parsePtyInfos(value: unknown): PtyInfo[] {
  return records(value).flatMap((row) => {
    const id = text(row.id)
    if (!id) return []
    return [{
      id,
      title: text(row.title) ?? id,
      command: text(row.command) ?? "",
      args: strings(row.args),
      cwd: text(row.cwd) ?? "",
      status: text(row.status) ?? "unknown",
      pid: num(row.pid) ?? 0,
    }]
  })
}

/**
 * `providerSessionId` and `sessionId` keep their null/undefined distinction:
 * the caller tests `!== null` to tell "the harness has no session" from "the
 * hook did not report one".
 */
function nullableText(value: unknown): string | null | undefined {
  if (value === null) return null
  return typeof value === "string" ? value : undefined
}

function parseTerminalSessionResponse(value: unknown): TerminalSessionResponse | undefined {
  const row = record(value)
  if (!row) return undefined
  const session = record(row.session)
  return {
    success: bool(row.success) ?? false,
    source: text(row.source),
    terminalId: text(row.terminalId),
    error: text(row.error),
    ...(session ? {
      session: {
        terminalId: text(session.terminalId) ?? "",
        tabId: text(session.tabId),
        workspaceId: text(session.workspaceId),
        provider: text(session.provider),
        providerSessionId: nullableText(session.providerSessionId),
        sessionId: nullableText(session.sessionId),
        transcriptPath: nullableText(session.transcriptPath),
        refName: text(session.refName),
        prompt: text(session.prompt),
        lastAssistantMessage: text(session.lastAssistantMessage),
        eventType: oneOf(session.eventType, ["Busy", "Idle", "UserActionRequired", "Error"] as const),
        updatedAt: num(session.updatedAt) ?? 0,
      },
    } : {}),
  }
}

/** The wake routes answer `{ ok, text }`; anything else reads as a failure. */
function parseWakeResult(value: unknown): { ok: boolean; text: string } {
  const row = record(value)
  return { ok: bool(row?.ok) ?? false, text: text(row?.text) ?? "" }
}

const launchFailure = (err: unknown) => ({
  kind: "failed" as const,
  error: err instanceof Error ? err.message : String(err),
})

const proc = (directory?: string): ProcessClient => ({
  list: async (init?: RequestInit) =>
    parseListResponse(await control.json(PROCESS_PATH, { method: "GET", ...init }, directory)),
  start: async (id: string) =>
    control.json(`${PROCESS_PATH}/${encodeURIComponent(id)}/start`, { method: "POST" }, directory)
      .then(parseLaunchResult)
      .catch(launchFailure),
  // The three void routes still swallow their errors: the handler has always
  // reported the action as done. Surfacing the failure is a product change, not
  // a parse change, so it stays as it was.
  stop: async (id: string) => {
    await control.json(`${PROCESS_PATH}/${encodeURIComponent(id)}/stop`, { method: "POST" }, directory).catch(() => {})
  },
  restart: async (id: string) =>
    control.json(`${PROCESS_PATH}/${encodeURIComponent(id)}/restart`, { method: "POST" }, directory)
      .then(parseLaunchResult)
      .catch(launchFailure),
  startAll: async () => {
    await control.json(`${PROCESS_PATH}/start-all`, { method: "POST" }, directory).catch(() => {})
  },
  stopAll: async () => {
    await control.json(`${PROCESS_PATH}/stop-all`, { method: "POST" }, directory).catch(() => {})
  },
})

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
    query.set("pty_id", clean(args.terminal_id) || clean(process.env.CLAXEDO_TERMINAL_ID))
  } else if (clean(args.process_id)) {
    query.set("process_id", clean(args.process_id))
  } else if (clean(args.name)) {
    query.set("name", clean(args.name))
  } else {
    return undefined
  }
  return query
}

const fetchLogText = async (args: {
  pty_id?: string
  terminal_id?: string
  process_id?: string
  name?: string
  lines?: number
  directory?: string
  workspace_id?: string
}) => {
  const query = resolveLogQuery(args)
  if (!query) return undefined
  return control.text(`${PROCESS_PATH}/logs?${query.toString()}`, { method: "GET" }, requestDirectory(args))
}

const server = new McpServer({
  name: "claxedo-mcp",
  version: "1.0.0",
})

/**
 * Every tool in this package is declared through here.
 *
 * The SDK's `registerTool` is generic in both its input and output schema, so
 * `Parameters<typeof server.registerTool>[2]` collapses to `never` — the cast
 * that used to sit here asserted a handler into a type nothing can inhabit.
 * Instantiating the SDK's generic with this tool's own `Shape` and converting
 * the result at `toCallToolResult` says the same thing with a check behind it.
 */
function registerTool<Shape extends McpToolShape>(
  name: string,
  config: McpToolConfig<Shape>,
  handler: (args: z.infer<z.ZodObject<Shape>>, extra: McpToolExtra) => Promise<McpToolResult>,
) {
  // The SDK's callback type is a conditional on its own `InputArgs`, so passing
  // a type parameter leaves it unresolved and nothing can be written that
  // satisfies it — which is why this line used to end in a cast that the
  // checker reported as `never`. Instantiating the SDK generic at its
  // constraint gives the callback a concrete argument type, and re-reading
  // those arguments through the very schema we handed the SDK is what connects
  // them back to `Shape`. It is the same check, done where it can be seen; the
  // schemas here are plain field validators with no transforms, so reading them
  // twice yields the same value.
  const schema = z.object(config.inputSchema)
  server.registerTool<ZodRawShapeCompat, ZodRawShapeCompat>(name, config, async (args, extra) =>
    toCallToolResult(await handler(schema.parse(args), { requestId: extra.requestId })),
  )
}

const toolConnectionId = crypto.randomUUID()

if (!READ_ONLY) {
registerTool("schedule_followup", {
  description: "Schedule a follow-up in this existing machine session. Requires CLAXEDO_WAKES on the server.",
  inputSchema: { when: z.string(), intent: z.unknown().optional() },
}, async (args, extra) => {
  if (!DEFAULT_SESSION_ID || !DEFAULT_DIR) return { isError: true, content: [{ type: "text" as const, text: "A machine session and workspace are required" }] }
  const result = parseWakeResult(await control.json(`/api/control/sessions/${encodeURIComponent(DEFAULT_SESSION_ID)}/wakes`, { method: "POST", body: JSON.stringify({ name: "schedule_followup", toolCallId: `${toolConnectionId}:${extra.requestId}`, input: args }) }))
  return { isError: !result.ok, content: [{ type: "text" as const, text: result.text }] }
})
registerTool("cancel_wake", {
  description: "Cancel a pending follow-up belonging to this machine session.",
  inputSchema: { wake_id: z.string() },
}, async (args, extra) => {
  if (!DEFAULT_SESSION_ID || !DEFAULT_DIR) return { isError: true, content: [{ type: "text" as const, text: "A machine session and workspace are required" }] }
  const result = parseWakeResult(await control.json(`/api/control/sessions/${encodeURIComponent(DEFAULT_SESSION_ID)}/wakes`, { method: "POST", body: JSON.stringify({ name: "cancel_wake", toolCallId: `${toolConnectionId}:${extra.requestId}`, input: args }) }))
  return { isError: !result.ok, content: [{ type: "text" as const, text: result.text }] }
})

}

registerDocumentTools(registerTool, control.json, {
  directory: DEFAULT_DIR,
  sessionId: DEFAULT_SESSION_ID,
})

registerCloudWorkspaceTools(
  registerTool,
  ownerControl.json,
  READ_ONLY,
)

if (!READ_ONLY) {
  registerTool(
    "process",
    {
      description:
        "[Process] Manage dev servers, watchers, and long-running processes. " +
        "Actions: list, start, stop, restart, add, update, remove, start_all, stop_all. " +
        "Use action='list' to see configured processes and their state. " +
        "Use action='add' with name+command to create a stable config in .workspace-runtime/processes.jsonc, then action='start' with id to run it. " +
        "When the command binds to a network port, include a port block with name and inject so Claxedo can resolve conflicts.",
      inputSchema: {
        action: z
          .enum(["list", "start", "stop", "restart", "add", "update", "remove", "start_all", "stop_all"])
          .describe("Operation to perform."),
        id: z.string().optional().describe("Process config ID. Optional for add, required for start/stop/restart/update/remove."),
        name: z.string().optional().describe("Human-readable process name. Required for add."),
        command: z.string().optional().describe("Command to run. Required for add."),
        args: z.array(z.string()).optional().describe("Command arguments."),
        cwd: z.string().optional().describe("Working directory, relative to project root."),
        env: z.record(z.string(), z.string()).optional().describe("Extra environment variables."),
        autoStart: z.boolean().optional().describe("Auto-start when project opens. Default: false."),
        restartPolicy: z.enum(["never", "on-failure", "always"]).optional().describe("Restart policy. Default: never."),
        maxRestarts: z.number().int().min(0).optional().describe("Max restart runs. Default: 3."),
        color: z.string().optional().describe("Hex color for the process status dot."),
        dependsOn: z.array(z.string()).optional().describe("Names of processes that must start first."),
        port: z
          .object({
            name: z.string().regex(/^[a-z0-9._-]+$/).describe("Template key for env substitution and named URLs."),
            inject: z.string().describe("Env var name like PORT, or a flag like --port."),
            preferred: z.number().int().positive().optional().describe("Preferred port number."),
            onConflict: z.enum(["pick-new", "kill-existing"]).optional().describe("Auto-resolve a port conflict."),
          })
          .optional()
          .describe("Port management config for commands that bind to a port."),
        directory: z.string().optional().describe("Project directory."),
        workspace_id: z.string().optional().describe("Workspace id for Docker/cloud workspace requests."),
      },
    },
    async (args) => handleProcess(args, control.json, proc, DEFAULT_DIR),
  )
}

registerTool(
  "get_logs",
  {
    description:
      "[Logs] Get terminal output from a managed process or PTY session. " +
      "Accepts process_id, name, pty_id, or terminal_id. Use lines to return only the tail.",
    inputSchema: {
      process_id: z.string().optional().describe("Process config ID."),
      name: z.string().optional().describe("Process name."),
      pty_id: z.string().optional().describe("PTY session ID."),
      terminal_id: z.string().optional().describe("Terminal ID. Defaults to CLAXEDO_TERMINAL_ID env when omitted."),
      lines: z.number().int().min(1).max(10000).optional().describe("Return only the last N lines."),
      directory: z.string().optional().describe("Project directory."),
      workspace_id: z.string().optional().describe("Workspace id for Docker/cloud workspace requests."),
    },
  },
  async (args) => {
    const directory = requestDirectory(args)
    const query = resolveLogQuery(args)
    if (!query) {
      const data = await proc(directory).list().catch(
        () => ({ configs: [] as Array<{ id: string; name: string }>, processes: [] as Array<{ configId: string; status?: string; ptyId?: string }> }),
      )
      const ptys = await control.json(PTY_PATH, { method: "GET" }, directory).then(parsePtyInfos).catch(
        (): PtyInfo[] => [],
      )
      const processLines = data.configs.map((config) => {
        const process = data.processes.find((item) => item.configId === config.id)
        return `- ${config.name} (${config.id}) [${process?.status || "idle"}]${process?.ptyId ? ` pty=${process.ptyId}` : ""}`
      })
      const ptyLines = ptys
        .filter((pty) => !data.processes.some((process) => process.ptyId === pty.id))
        .map((pty) => `- ${pty.title} (${pty.id}) [${pty.status}]`)
      return {
        content: [
          {
            type: "text" as const,
            text: [
              "No identifier provided. Specify one of: process_id, name, pty_id, or terminal_id.",
              "",
              ...(processLines.length ? ["Managed processes:", ...processLines] : ["No managed processes."]),
              ...(ptyLines.length ? ["", "Other terminal sessions:", ...ptyLines] : []),
            ].join("\n"),
          },
        ],
        isError: true,
      }
    }

    try {
      const output = await control.text(`${PROCESS_PATH}/logs?${query.toString()}`, { method: "GET" }, directory)
      if (!output.trim()) return { content: [{ type: "text" as const, text: "Session found but no output captured yet." }] }
      return { content: [{ type: "text" as const, text: output }] }
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to get logs: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      }
    }
  },
)

registerTool(
  "session_messages",
  {
    description:
      "[Context] Get structured messages for an agent session. " +
      "Pass session_id for a normal chat, or terminal_id/tab_id to resolve the currently running terminal agent.",
    inputSchema: {
      session_id: z.string().optional().describe("Explicit session id for a normal chat or agent session."),
      terminal_id: z.string().optional().describe("Terminal id to resolve current agent session. Defaults to CLAXEDO_TERMINAL_ID."),
      tab_id: z.string().optional().describe("Optional tab id fallback when terminal id is unavailable."),
      provider: z.string().optional().describe("Optional provider override."),
      limit: z.number().int().min(1).max(500).optional().describe("Maximum messages to fetch. Default: 50."),
      format: z.enum(["prompt", "json"]).optional().describe("Response format. prompt=human summary (default)."),
      directory: z.string().optional().describe("Project directory."),
      workspace_id: z.string().optional().describe("Workspace id for Docker/cloud workspace requests."),
    },
  },
  async (args) => {
    const directory = requestDirectory(args)
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
                "session_messages needs session_id, or terminal_id/tab_id to resolve a current terminal agent. " +
                "Inside a Claxedo terminal, CLAXEDO_TERMINAL_ID should be set automatically.",
            },
          ],
          isError: true,
        }
      }
      const query = new URLSearchParams()
      if (terminalID) query.set("terminalId", terminalID)
      if (tabID) query.set("tabId", tabID)
      const tracked = await control
        .json(`/api/wr/hook/terminal-session?${query.toString()}`, { method: "GET" }, directory)
        .then(parseTerminalSessionResponse)
        .catch(() => undefined)
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
      if (tracked.session.providerSessionId !== null) sessionID = clean(tracked.session.providerSessionId)
      if (!sessionID && tracked.session.sessionId !== null) sessionID = clean(tracked.session.sessionId)
    }

    if (sessionID) {
      try {
        const messages = parseSessionMessages(await control.json(
          `/session/${encodeURIComponent(sessionID)}/message?limit=${encodeURIComponent(String(limit))}`,
          { method: "GET" },
          directory,
        ))
        if (format === "json") {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    source,
                    provider: provider || "unknown",
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
        return {
          content: [
            {
              type: "text" as const,
              text: `Session ${sessionID} (${provider || "unknown"}) messages: ${messages.length}\n\n${formatSessionMessages(messages) || "(no messages found)"}`,
            },
          ],
        }
      } catch (err) {
        if (!transcriptPath) {
          return {
            content: [{ type: "text" as const, text: `Failed to fetch session messages: ${err instanceof Error ? err.message : String(err)}` }],
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
            text: "No structured messages available. This provider may not expose structured session routes and no transcript path was recorded.",
          },
        ],
        isError: true,
      }
    }

    // The path came from a harness hook payload and was only trimmed on the way
    // in, so it is attacker-choosable; contain it before opening the file.
    const contained = resolveTranscriptPath(transcriptPath, { workspaceDirectory: directory })
    if (!contained.ok) {
      return {
        content: [{ type: "text" as const, text: `Refusing to read transcript at ${transcriptPath}: ${contained.reason}` }],
        isError: true,
      }
    }

    try {
      // Re-check after following symlinks: the string check above cannot see a
      // link inside an allowed root that points at /etc/shadow.
      const realPath = await fsPromises.realpath(contained.path)
      if (realPath !== contained.path) {
        const containedReal = resolveTranscriptPath(realPath, { workspaceDirectory: directory })
        if (!containedReal.ok) {
          return {
            content: [{ type: "text" as const, text: `Refusing to read transcript at ${transcriptPath}: symlink target ${containedReal.reason}` }],
            isError: true,
          }
        }
      }
      const raw = await fsPromises.readFile(realPath, "utf-8")
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
      return { content: [{ type: "text" as const, text: `Transcript fallback (${provider || "unknown"})\nPath: ${transcriptPath}\n\n${text}` }] }
    } catch {
      return {
        content: [{ type: "text" as const, text: `Transcript file not found: ${transcriptPath}` }],
        isError: true,
      }
    }
  },
)

if (!READ_ONLY) {
  registerTool(
    "spawn_session",
    {
      description: "[Dispatch] Create a native agent session in an explicit machine workspace. An initial prompt waits for the workspace runtime's admission receipt. Read session_messages to follow its progress.",
      inputSchema: {
        title: z.string().optional(),
        prompt: z.string().optional(),
        workspace_id: z.string().min(1).describe("Registered machine workspace to run the complete harness in."),
        harness: z.enum(["pi", "claude", "codex", "cursor", "opencode"]),
      },
    },
    async (args, extra) => {
      const workspaceId = clean(args.workspace_id)
      const sessionTitle = clean(args.title) || "Background Session"
      const prompt = clean(args.prompt)
      try {
        const created = record(await control.json(
          "/api/control/sessions",
          {
            method: "POST",
            body: JSON.stringify({
              harness: args.harness,
              title: sessionTitle,
              workspaceId,
            }),
          },
          workspaceId ? workspaceRef(workspaceId) : undefined,
        ))
        const sessionId = text(record(created?.session)?.id)
        if (!sessionId) {
          return { content: [{ type: "text" as const, text: "Session creation returned no id." }], isError: true }
        }
        let delivery: unknown
        if (prompt) {
          delivery = await control.json(
            `/session/${encodeURIComponent(sessionId)}/prompt_async`,
            { method: "POST", body: JSON.stringify({ messageID: `mcp:${toolConnectionId}:${extra.requestId}`, parts: [{ type: "text", text: prompt }] }) },
            workspaceRef(workspaceId),
          )
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              session_id: sessionId,
              app_url: `/s/${encodeURIComponent(sessionId)}`,
              workspace_id: workspaceId || null,
              delivery: prompt ? delivery : { status: "not_requested" },
            }, null, 2),
          }],
        }
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `spawn_session failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        }
      }
    },
  )

  registerTool(
    "summarize_logs",
    {
      description:
        "[Logs] Summarize terminal output into a short title and 2-5 sentence summary using the configured agent model. " +
        "Pass raw text directly or specify process_id, name, pty_id, or terminal_id to fetch logs first.",
      inputSchema: {
        text: z.string().optional().describe("Raw log text. If provided, skips log fetching."),
        process_id: z.string().optional().describe("Process config ID."),
        name: z.string().optional().describe("Process name."),
        pty_id: z.string().optional().describe("PTY session ID."),
        terminal_id: z.string().optional().describe("Terminal ID."),
        lines: z.number().int().min(1).max(10000).optional().describe("Limit fetched logs to last N lines."),
        directory: z.string().optional().describe("Project directory."),
        workspace_id: z.string().optional().describe("Workspace id for Docker/cloud workspace requests."),
      },
    },
    async (args) => {
      const directory = requestDirectory(args)
      const MAX_LOG_CHARS = 50_000
      let logText = clean(args.text)

      if (!logText) {
        try {
          logText = clean(await fetchLogText({ ...args, directory }))
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Failed to fetch logs: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          }
        }
      }

      if (!logText) {
        return {
          content: [
            {
              type: "text" as const,
              text: "summarize_logs needs log text. Provide text directly, or specify one of: process_id, name, pty_id, terminal_id.",
            },
          ],
          isError: true,
        }
      }

      const truncated = logText.length > MAX_LOG_CHARS ? logText.slice(-MAX_LOG_CHARS) : logText
      let sessionID: string
      try {
        const data = record(await control.json(
          "/session",
          { method: "POST", body: JSON.stringify({ title: "Log Summary" }) },
          directory,
        ))
        sessionID = text(data?.id) ?? text(record(data?.data)?.id) ?? ""
        if (!sessionID) throw new Error("No session id returned")
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to create session: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        }
      }

      const deleteSession = () => {
        control.json(`/session/${encodeURIComponent(sessionID)}`, { method: "DELETE" }, directory).catch(() => {})
      }

      const system = [
        "You are a log analysis assistant. Analyze the provided terminal/process output and return a JSON object with exactly two fields:",
        '- "title": A concise title (max 80 characters) describing what the logs show.',
        '- "summary": A 2-5 sentence summary of the key information, errors, warnings, or status shown in the logs.',
        "Return ONLY valid JSON, no markdown fences, no extra text.",
      ].join("\n")

      try {
        const result = parseSessionMessage(await control.json(
          `/session/${encodeURIComponent(sessionID)}/message`,
          {
            method: "POST",
            body: JSON.stringify({
              system,
              parts: [{ type: "text", text: truncated }],
            }),
          },
          directory,
        ))
        const responseText = await resolveResponseText(result, async () =>
          parseSessionMessages(
            await control.json(`/session/${encodeURIComponent(sessionID)}/message`, { method: "GET" }, directory),
          ),
        )
        if (!responseText) {
          const errMsg = result.info?.error?.data?.message || result.info?.error?.message
          return {
            content: [{ type: "text" as const, text: errMsg ? `LLM error: ${errMsg}` : "LLM returned empty response." }],
            isError: true,
          }
        }

        try {
          const parsed = record(
            JSON.parse(responseText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "")),
          ) ?? {}
          return {
            content: [
              {
                type: "text" as const,
                text: `**${clean(parsed.title).slice(0, 80) || "Log Summary"}**\n\n${clean(parsed.summary) || responseText}`,
              },
            ],
          }
        } catch {
          return { content: [{ type: "text" as const, text: responseText }] }
        }
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to summarize logs: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        }
      } finally {
        deleteSession()
      }
    },
  )
}

registerBrowserTools(registerTool, { readOnly: READ_ONLY })

const transport = new StdioServerTransport()
if (process.argv[2] === "documents") {
  process.exitCode = await runDocumentsCli(
    process.argv.slice(3),
    control.json,
    { stdout: console.log, stderr: console.error },
    { directory: DEFAULT_DIR, sessionId: DEFAULT_SESSION_ID },
  )
} else {
  await server.connect(transport)
}
