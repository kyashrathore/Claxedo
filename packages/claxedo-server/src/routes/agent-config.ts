/**
 * Agent Config Routes
 *
 * HTTP API for managing centralized opencode/agent configuration stored in
 * ~/.claxedo/.  Changes here are picked up by the next opencode startup via
 * OPENCODE_CONFIG_DIR=~/.claxedo/opencode-config/.
 *
 * Endpoints:
 *   GET  /api/claxedo/agent-config              — full merged config (for OPENCODE_CONFIG_CONTENT)
 *   GET  /api/claxedo/agent-config/mcp          — list user-defined MCP servers
 *   POST /api/claxedo/agent-config/mcp/:name    — add / update user MCP server
 *   DELETE /api/claxedo/agent-config/mcp/:name  — remove user MCP server
 *   GET  /api/claxedo/agent-config/commands     — list central slash commands
 *   GET  /api/claxedo/agent-config/commands/:name — get single command
 *   POST /api/claxedo/agent-config/commands     — upsert command (body: {name, content})
 *   DELETE /api/claxedo/agent-config/commands/:name — delete command
 */

import { Hono } from "hono"
import { lazy } from "../lazy"
import {
  loadUserConfig,
  saveUserConfig,
  getEffectiveConfig,
  listCommands,
  getCommand,
  saveCommand,
  deleteCommand,
  defaultRunner,
} from "../agent-config"
import { rebuildOpencodeJsonc } from "../agent-hooks"
import { fanOutConfig } from "../config-fanout"
import {
  getLocalAgentAdapter,
  getLocalRunnerOptions,
  getLocalSessionAdapter,
  getLocalSessionRunner,
  localAgentStatus,
  setLocalRunnerOptions,
  setLocalSessionModel,
} from "../local-agent-engine"
import { getSessionRunner, normalize, setSessionRunner } from "../session-runner"
import { resolveWorkspace } from "../workspace-store"

type AcpConfigOption = {
  id: string
  name: string
  category?: string | null
  type: "select" | "boolean"
  currentValue: unknown
  options?: Array<{ value: string; name: string; description?: string }>
  selectOptions?: Array<{ id: string; name: string }>
}

type OptionsResponse = {
  options: AcpConfigOption[]
  source: "live" | "cache" | "static" | "empty"
  stale: boolean
}

const CLAUDE_MODELS = [
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
]
const refreshing = new Map<string, Promise<AcpConfigOption[]>>()

function runnerKey(runner: { type: string; binary?: string | null }) {
  return JSON.stringify({
    type: runner.type,
    binary: runner.binary ?? "",
  })
}

function staticOptions(runner: { type: string; model?: string }): AcpConfigOption[] {
  if (runner.type !== "claude-acp") return []
  return [{
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: runner.model ?? CLAUDE_MODELS[0]!.id,
    selectOptions: CLAUDE_MODELS,
  }]
}

async function refreshOptions(ws: NonNullable<Awaited<ReturnType<typeof resolveWorkspace>>>, runner: ReturnType<typeof normalize>) {
  if (runner.type === "opencode") return []
  const key = runnerKey(runner)
  const hit = refreshing.get(key)
  if (hit) return hit
  const task = (async () => {
    const adapter = await getLocalAgentAdapter(ws, runner)
    const options = await adapter.probeConfigOptions(ws.directory).catch(() => [])
    if (Array.isArray(options) && options.length > 0) {
      setLocalRunnerOptions(runner, options)
      return options as AcpConfigOption[]
    }
    return []
  })()
  refreshing.set(key, task)
  return task.finally(() => {
    if (refreshing.get(key) === task) refreshing.delete(key)
  })
}

export const AgentConfigRoutes = lazy(
  () =>
    new Hono()
      .get("/runner", async (c) => {
        const directory = c.req.query("directory") || c.req.header("x-opencode-directory")
        const workspaceId = c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id")
        const sessionId = c.req.query("sessionId") || c.req.query("session") || c.req.header("x-session-id")
        const config = await loadUserConfig()
        const runner = defaultRunner(config)
        const ws = await resolveWorkspace({
          workspaceId,
          directory,
          create: !!directory,
        })

        if (!ws) {
          return c.json({
            ...runner,
            activeType: runner.type,
            activeBinary: runner.binary ?? null,
            status: "configured",
          })
        }

        try {
          const body = await localAgentStatus(ws, sessionId)
          const bound = sessionId ? getSessionRunner(ws.id, sessionId) : undefined
          return c.json({
            ...(bound ?? runner),
            workspaceId: ws.id,
            directory: ws.directory,
            ...(sessionId ? { sessionId } : {}),
            status: body.ready ? "ready" : "error",
            ready: body.ready,
            agentType: body.active.type,
            activeType: body.active.type,
            activeBinary: body.active.binary ?? null,
            error: body.error ?? undefined,
          })
        } catch (err) {
          return c.json({
            ...runner,
            workspaceId: ws.id,
            directory: ws.directory,
            activeType: runner.type,
            activeBinary: runner.binary ?? null,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })
      // ── Runner ────────────────────────────────────────────────────────────

      .post("/runner", async (c) => {
        const body = await c.req.json<{ type?: string; binary?: string; sessionId?: string; directory?: string; workspaceId?: string }>().catch(() => null)
        if (!body?.type) return c.json({ error: "type is required" }, 400)
        const validTypes = ["claude-acp", "codex-acp", "cursor-acp", "opencode"]
        if (!validTypes.includes(body.type)) return c.json({ error: "Invalid runner type" }, 400)
        const sessionId = body.sessionId || c.req.query("sessionId") || c.req.header("x-session-id")
        const workspaceId = body.workspaceId || c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id")
        const directory = body.directory || c.req.query("directory") || c.req.header("x-opencode-directory")
        const ws = sessionId
          ? await resolveWorkspace({
              workspaceId,
              directory,
              create: !!directory,
            })
          : undefined

        if (ws && sessionId) {
          const next = normalize({
            type: body.type as "claude-acp" | "codex-acp" | "cursor-acp" | "opencode",
            ...(body.type === "opencode" ? {} : { ...(body.binary ? { binary: body.binary } : {}) }),
          })
          const prev = await getLocalSessionRunner(ws, sessionId)
          const same = prev.type === next.type && (prev.binary ?? "") === (next.binary ?? "")
          if (!same) {
            const adapter = await getLocalSessionAdapter(ws, sessionId, prev)
            const session = await adapter.getSession(sessionId, ws.directory).catch(() => null)
            if (session) {
              return c.json({ error: "Runner changes are only supported before a session is created" }, 409)
            }
          }
          setSessionRunner(ws.id, sessionId, next)
          return c.json({ ok: true })
        }

        const config = await loadUserConfig()
        const same = config.runner?.type === body.type
        config.runner = {
          type: body.type as "claude-acp" | "codex-acp" | "cursor-acp" | "opencode",
          ...(body.binary ? { binary: body.binary } : {}),
          ...(same && config.runner?.model ? { model: config.runner.model } : {}),
        }
        await saveUserConfig(config)
        await fanOutConfig().catch(() => {})

        return c.json({ ok: true })
      })

      .post("/runner/model", async (c) => {
        const body = await c.req.json<{ model?: string; sessionId?: string; directory?: string; workspaceId?: string }>().catch(() => null)
        if (!body?.model) return c.json({ error: "model is required" }, 400)
        const sessionId = body.sessionId || c.req.query("sessionId") || c.req.header("x-session-id")
        const workspaceId = body.workspaceId || c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id")
        const directory = body.directory || c.req.query("directory") || c.req.header("x-opencode-directory")
        const ws = sessionId
          ? await resolveWorkspace({
              workspaceId,
              directory,
              create: !!directory,
            })
          : undefined
        if (ws && sessionId) {
          await setLocalSessionModel(ws, sessionId, body.model)
          return c.json({ ok: true })
        }
        const config = await loadUserConfig()
        config.runner = {
          ...defaultRunner(config),
          model: body.model,
        }
        await saveUserConfig(config)
        await fanOutConfig().catch(() => {})
        return c.json({ ok: true })
      })

      .get("/runner/options", async (c) => {
        const directory = c.req.query("directory") || c.req.header("x-opencode-directory")
        const workspaceId = c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id")
        const sessionId = c.req.query("sessionId") || c.req.query("session") || c.req.header("x-session-id")
        const type = c.req.query("type")
        const ws = await resolveWorkspace({
          workspaceId,
          directory,
          create: !!directory,
        })
        if (!ws) return c.json({ error: "workspaceId or directory is required" }, 400)
        const runner = type === "claude-acp" || type === "codex-acp" || type === "cursor-acp" || type === "opencode"
          ? normalize({ type })
          : await getLocalSessionRunner(ws, sessionId)
        if (runner.type === "opencode") {
          return c.json({
            options: [],
            source: "empty",
            stale: false,
          } satisfies OptionsResponse)
        }
        const adapter = await getLocalAgentAdapter(ws, runner)
        const live = await adapter.peekConfigOptions?.(ws.directory)
        if (Array.isArray(live) && live.length > 0) {
          setLocalRunnerOptions(runner, live)
          return c.json({
            options: live as AcpConfigOption[],
            source: "live",
            stale: false,
          } satisfies OptionsResponse)
        }
        const cache = getLocalRunnerOptions(runner)
        if (Array.isArray(cache) && cache.length > 0) {
          void refreshOptions(ws, runner)
          return c.json({
            options: cache as AcpConfigOption[],
            source: "cache",
            stale: true,
          } satisfies OptionsResponse)
        }
        const fallback = staticOptions(runner)
        if (fallback.length > 0) {
          void refreshOptions(ws, runner)
          return c.json({
            options: fallback,
            source: "static",
            stale: true,
          } satisfies OptionsResponse)
        }
        void refreshOptions(ws, runner)
        return c.json({
          options: [],
          source: "empty",
          stale: true,
        } satisfies OptionsResponse)
      })

      // ── Full effective config ──────────────────────────────────────────────
      .get("/", async (c) => {
        const config = await getEffectiveConfig()
        return c.json(config)
      })

      // ── MCP servers ────────────────────────────────────────────────────────
      .get("/mcp", async (c) => {
        const { mcp } = await loadUserConfig()
        return c.json(mcp)
      })

      .post("/mcp/:name", async (c) => {
        const name = c.req.param("name")
        if (!name || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
          return c.json({ error: "Invalid server name (alphanumeric, dash, underscore only)" }, 400)
        }

        const body = await c.req.json().catch(() => null)
        if (!body || typeof body !== "object") return c.json({ error: "Invalid JSON body" }, 400)

        const { type, command, args, env, url, headers, disabled } = body as Record<string, unknown>

        if (type !== "stdio" && type !== "remote") {
          return c.json({ error: "type must be 'stdio' or 'remote'" }, 400)
        }
        if (type === "stdio" && typeof command !== "string") {
          return c.json({ error: "command is required for stdio servers" }, 400)
        }
        if (type === "remote" && typeof url !== "string") {
          return c.json({ error: "url is required for remote servers" }, 400)
        }

        const config = await loadUserConfig()
        config.mcp[name] = {
          type: type as "stdio" | "remote",
          ...(type === "stdio"
            ? {
                command: command as string,
                args: Array.isArray(args) ? (args as string[]) : [],
                env: (env as Record<string, string>) ?? {},
              }
            : {
                url: url as string,
                headers: (headers as Record<string, string>) ?? {},
              }),
          ...(typeof disabled === "boolean" ? { disabled } : {}),
        }
        await saveUserConfig(config)
        await rebuildOpencodeJsonc()
        fanOutConfig().catch(() => {})
        return c.json({ ok: true, name })
      })

      .delete("/mcp/:name", async (c) => {
        const name = c.req.param("name")
        const config = await loadUserConfig()
        if (!(name in config.mcp)) return c.json({ error: "Not found" }, 404)
        delete config.mcp[name]
        await saveUserConfig(config)
        await rebuildOpencodeJsonc()
        fanOutConfig().catch(() => {})
        return c.json({ ok: true })
      })

      // ── Commands ───────────────────────────────────────────────────────────
      .get("/commands", async (c) => {
        const commands = await listCommands()
        return c.json(commands)
      })

      .get("/commands/:name", async (c) => {
        const cmd = await getCommand(c.req.param("name"))
        if (!cmd) return c.json({ error: "Not found" }, 404)
        return c.json(cmd)
      })

      .post("/commands", async (c) => {
        const body = await c.req.json<{ name?: string; content?: string }>().catch(() => null)
        if (!body || !body.name || !body.content) {
          return c.json({ error: "name and content are required" }, 400)
        }
        const saved = await saveCommand(body.name, body.content)
        return c.json({ ok: true, name: saved }, 201)
      })

      .delete("/commands/:name", async (c) => {
        const deleted = await deleteCommand(c.req.param("name"))
        if (!deleted) return c.json({ error: "Not found" }, 404)
        return c.json({ ok: true })
      }),
)
