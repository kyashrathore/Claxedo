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
 *   OPENCODE_API_DIR   - Default project directory for requests
 *   CLAXEDO_WORKSPACE_ID - Default workspace id for Docker/cloud workspace requests
 *   CLAXEDO_REPOSITORY_URL - Optional repository URL override for a cloud workspace
 *   CLAXEDO_AUTH_TOKEN - Optional signed remote server auth token
 *   CLAXEDO_SESSION_ID - Optional current session id for documents_open and the documents CLI
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import fsPromises from "node:fs/promises"
import { z } from "zod"
import { registerBrowserTools } from "./browser-tools"
import { mcpHttpError } from "./http-error"
import { handleProcess, type LaunchResult, type ListResponse, type ProcessClient } from "./process-handler"
import { formatSessionMessages, resolveResponseText, type SessionMessage } from "./message-text"
import { claxedoRequestScope } from "./request-scope"
import { claxedoMcpReadOnly } from "./tool-policy"
import { registerWorkGraphTools } from "./workgraph-tools"
import { registerDocumentTools } from "./documents-tools"
import { runDocumentsCli } from "./documents-cli"
import { registerCloudWorkspaceTools } from "./cloud-workspace-tools"

const clean = (value: unknown) => {
  if (typeof value !== "string") return ""
  return value.trim()
}

const workspaceRef = (id: string) => `workspace:${id}`
const workspaceIdFromDirectory = (directory: string) => /^workspace:([^/]+)$/.exec(directory)?.[1]
const requestDirectory = (args: { directory?: string; workspace_id?: string }) =>
  clean(args.directory) || (clean(args.workspace_id) ? workspaceRef(clean(args.workspace_id)) : DEFAULT_DIR)

const ORIGIN = clean(process.env.CLAXEDO_SERVER_URL) || "http://127.0.0.1:3001"
const DEFAULT_WORKSPACE_ID = clean(process.env.CLAXEDO_WORKSPACE_ID)
const DEFAULT_DIR = clean(process.env.OPENCODE_API_DIR) || (DEFAULT_WORKSPACE_ID ? workspaceRef(DEFAULT_WORKSPACE_ID) : process.cwd())
const DEFAULT_REPOSITORY_URL = clean(process.env.CLAXEDO_REPOSITORY_URL)
const DEFAULT_SESSION_ID = clean(process.env.CLAXEDO_SESSION_ID)
const TOKEN = clean(process.env.CLAXEDO_AUTH_TOKEN)
const READ_ONLY = claxedoMcpReadOnly()

const PROCESS_PATH = "/api/wr/process"
const PTY_PATH = "/api/wr/pty"

const httpRequest = async <T>(
  requestPath: string,
  init?: RequestInit,
  mode: "json" | "text" = "json",
  directory?: string,
  scope: "workspace" | "owner" = "workspace",
): Promise<T> => {
  const dir = directory || DEFAULT_DIR
  const workspaceId = scope === "workspace" ? workspaceIdFromDirectory(dir) || DEFAULT_WORKSPACE_ID : ""
  const target = claxedoRequestScope(ORIGIN, requestPath, scope === "owner"
    ? { type: "owner" }
    : { type: "workspace", directory: dir, ...(workspaceId ? { workspaceId } : {}) })
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...target.headers,
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  }
  const res = await fetch(target.url, { ...init, headers })
  const text = await res.text()
  if (!res.ok) {
    const data = mode === "json" && text.trim() ? parseHttpErrorBody(text) : undefined
    throw mcpHttpError(res.status, data)
  }
  return (mode === "text" ? text : text.trim() ? JSON.parse(text) : null) as T
}

function parseHttpErrorBody(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
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

type PtyInfo = {
  id: string
  title: string
  command: string
  args: string[]
  cwd: string
  status: string
  pid: number
}

const launchFailure = (err: unknown) => ({
  kind: "failed" as const,
  error: err instanceof Error ? err.message : String(err),
})

const proc = (directory?: string): ProcessClient => ({
  list: async (init?: RequestInit) =>
    httpRequest<ListResponse>(PROCESS_PATH, { method: "GET", ...init }, "json", directory),
  start: async (id: string) =>
    httpRequest<LaunchResult>(`${PROCESS_PATH}/${encodeURIComponent(id)}/start`, { method: "POST" }, "json", directory).catch(launchFailure),
  stop: async (id: string) =>
    httpRequest(`${PROCESS_PATH}/${encodeURIComponent(id)}/stop`, { method: "POST" }, "json", directory)
      .then((value) => value === undefined || value === true)
      .catch(() => false),
  restart: async (id: string) =>
    httpRequest<LaunchResult>(`${PROCESS_PATH}/${encodeURIComponent(id)}/restart`, { method: "POST" }, "json", directory).catch(launchFailure),
  startAll: async () =>
    httpRequest(`${PROCESS_PATH}/start-all`, { method: "POST" }, "json", directory)
      .then((value) => value === undefined || value === true)
      .catch(() => false),
  stopAll: async () =>
    httpRequest(`${PROCESS_PATH}/stop-all`, { method: "POST" }, "json", directory)
      .then((value) => value === undefined || value === true)
      .catch(() => false),
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
  return httpRequest<string>(`${PROCESS_PATH}/logs?${query.toString()}`, { method: "GET" }, "text", requestDirectory(args))
}

const server = new McpServer({
  name: "claxedo-mcp",
  version: "1.0.0",
})

function registerTool(
  name: string,
  config: {
    description: string
    inputSchema: Record<string, unknown>
    _meta?: Record<string, unknown>
  },
  handler: (args: any) => Promise<unknown>,
) {
  server.registerTool(name, config as any, handler as any)
}

registerWorkGraphTools(
  registerTool,
  (path, init) => httpRequest(path, init, "json", undefined, "owner"),
  READ_ONLY,
  async () => {
    if (!DEFAULT_WORKSPACE_ID) return {
      execution: {
        environment: { kind: "local_worktree", directory: DEFAULT_DIR },
        repository: { baseRevision: "HEAD" },
      },
    }
    const resolved = DEFAULT_REPOSITORY_URL
      ? undefined
      : await httpRequest<{
          git?: { remote?: string | null }
          backing?: { repoUrl?: string | null }
        }>(`/api/workspace/resolve?workspaceId=${encodeURIComponent(DEFAULT_WORKSPACE_ID)}`, { method: "GET" }, "json", undefined, "owner")
    const repositoryUrl = DEFAULT_REPOSITORY_URL || clean(resolved?.git?.remote) || clean(resolved?.backing?.repoUrl)
    if (!repositoryUrl) throw new Error(`Workspace ${DEFAULT_WORKSPACE_ID} has no Git repository URL for the new Stream`)
    return {
      execution: {
        environment: { kind: "hosted_workspace", repositoryUrl },
        repository: { baseRevision: "HEAD" },
      },
    }
  },
)

registerDocumentTools(registerTool, (path, init) => httpRequest(path, init, "json"), {
  directory: DEFAULT_DIR,
  sessionId: DEFAULT_SESSION_ID,
})

registerCloudWorkspaceTools(
  registerTool,
  (path, init) => httpRequest(path, init, "json", undefined, "owner"),
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
        "Use action='add' with name+command to create a stable config in .claxedo/processes.jsonc, then action='start' with id to run it. " +
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
    async (args) => handleProcess(args, httpRequest, proc, DEFAULT_DIR),
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
      const ptys = await httpRequest<PtyInfo[]>(PTY_PATH, { method: "GET" }, "json", directory).catch(
        () => [] as PtyInfo[],
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
      const output = await httpRequest<string>(`${PROCESS_PATH}/logs?${query.toString()}`, { method: "GET" }, "text", directory)
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
      const tracked = await httpRequest<TerminalSessionResponse>(
        `/api/wr/hook/terminal-session?${query.toString()}`,
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
      if (tracked.session.sessionId !== null) sessionID = clean(tracked.session.sessionId)
    }

    if (sessionID) {
      try {
        const messages = await httpRequest<SessionMessage[]>(
          `/session/${encodeURIComponent(sessionID)}/message?limit=${encodeURIComponent(String(limit))}`,
          { method: "GET" },
          "json",
          directory,
        )
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
        return {
          content: [
            {
              type: "text" as const,
              text: `Session ${sessionID} (${provider || "opencode"}) messages: ${messages.length}\n\n${formatSessionMessages(messages) || "(no messages found)"}`,
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
            text: "No structured messages available. This provider may not expose OpenCode session routes and no transcript path was recorded.",
          },
        ],
        isError: true,
      }
    }

    try {
      const raw = await fsPromises.readFile(transcriptPath, "utf-8")
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
      description:
        "[Dispatch] Spawn a background Claxedo session on the control plane. Creates a hybrid central session " +
        "(model turns run centrally; tool side-effects run in the target workspace runtime or a virtual sandbox) " +
        "and optionally fires an initial prompt without waiting for the turn to finish. " +
        "Returns the new session id and app URL. Use session_messages later to check progress.",
      inputSchema: {
        title: z.string().optional().describe("Session title shown in the app."),
        prompt: z.string().optional().describe("Initial prompt to send to the new session (fire-and-forget)."),
        workspace_id: z.string().optional().describe("Workspace whose runtime hosts the session's tools. Omit for a virtual (tools-only) sandbox."),
        harness: z.enum(["pi"]).optional().describe("Harness for the session. Only 'pi' (central model-backed) is dispatchable today; codex/opencode sandbox harnesses land with sandbox dispatch."),
      },
    },
    async (args) => {
      const workspaceId = clean(args.workspace_id)
      const sessionTitle = clean(args.title) || "Background Session"
      const prompt = clean(args.prompt)
      try {
        const created = await httpRequest<{ session?: { id?: string }; placement?: unknown }>(
          "/api/control/sessions",
          {
            method: "POST",
            body: JSON.stringify({
              mode: "hybrid",
              title: sessionTitle,
              ...(workspaceId ? {
                workspaceId,
                toolSandbox: { kind: "workspace-runtime", workspaceId },
              } : {}),
            }),
          },
          "json",
          workspaceId ? workspaceRef(workspaceId) : undefined,
        )
        const sessionId = created.session?.id
        if (!sessionId) {
          return { content: [{ type: "text" as const, text: "Session creation returned no id." }], isError: true }
        }
        if (prompt) {
          // Fire-and-forget: the message route runs the WHOLE turn before
          // responding; the spawner must not block on the background session.
          void httpRequest(
            `/api/control/session/${encodeURIComponent(sessionId)}/message`,
            {
              method: "POST",
              body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
            },
            "json",
            workspaceId ? workspaceRef(workspaceId) : undefined,
          ).catch((err) => {
            console.error(`[claxedo-mcp] spawn_session initial prompt failed for ${sessionId}:`, err)
          })
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              session_id: sessionId,
              app_url: `/s/${encodeURIComponent(sessionId)}`,
              workspace_id: workspaceId || null,
              prompt_dispatched: !!prompt,
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
        const data = await httpRequest<{ id?: string; data?: { id?: string } }>(
          "/session",
          { method: "POST", body: JSON.stringify({ title: "Log Summary" }) },
          "json",
          directory,
        )
        sessionID = clean(data?.id || data?.data?.id)
        if (!sessionID) throw new Error("No session id returned")
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to create session: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        }
      }

      const deleteSession = () => {
        httpRequest(`/session/${encodeURIComponent(sessionID)}`, { method: "DELETE" }, "json", directory).catch(() => {})
      }

      const system = [
        "You are a log analysis assistant. Analyze the provided terminal/process output and return a JSON object with exactly two fields:",
        '- "title": A concise title (max 80 characters) describing what the logs show.',
        '- "summary": A 2-5 sentence summary of the key information, errors, warnings, or status shown in the logs.',
        "Return ONLY valid JSON, no markdown fences, no extra text.",
      ].join("\n")

      try {
        const result = await httpRequest<SessionMessage>(
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
        )
        const responseText = await resolveResponseText(result, () =>
          httpRequest<SessionMessage[]>(
            `/session/${encodeURIComponent(sessionID)}/message`,
            { method: "GET" },
            "json",
            directory,
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
          const parsed = JSON.parse(responseText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "")) as {
            title?: string
            summary?: string
          }
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

registerBrowserTools(server as any, { readOnly: READ_ONLY })

const transport = new StdioServerTransport()
if (process.argv[2] === "documents") {
  process.exitCode = await runDocumentsCli(
    process.argv.slice(3),
    (path, init) => httpRequest(path, init, "json"),
    { stdout: console.log, stderr: console.error },
    { directory: DEFAULT_DIR, sessionId: DEFAULT_SESSION_ID },
  )
} else {
  await server.connect(transport)
}
