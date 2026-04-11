import fs from "fs"
import os from "os"
import path from "path"
import type { Hono } from "hono"
import { ACPAdapter } from "../adapters/acp"
import type { AgentAdapter } from "../adapters/index"
import { OpenCodeAdapter } from "../adapters/opencode"
import { workspaceCapabilities } from "../capabilities"
import { subscribeGlobalEvents } from "../global-event-bus"
import { assertTarget } from "../target"
import { ConfigRoutes, type RuntimeRunner, type RuntimeSnapshot } from "../routes/config"
import { OpenCodeCompatRoutes } from "../routes/opencode-compat"
import { SessionRoutes } from "../routes/session"
import { sessionStatusSnapshot } from "../routes/session-status-snapshot"
import type { WorkspaceHost } from "./host"

function acp(type: string) {
  return type === "claude-acp" || type === "codex-acp" || type === "cursor-acp" || type === "acp"
}

function initialRunner(): RuntimeRunner {
  const type = (process.env.CLAXEDO_AGENT_TYPE ?? "opencode") as RuntimeRunner["type"] | "acp"
  return {
    type: type === "acp" ? "claude-acp" : type,
    ...(process.env.CLAXEDO_ACP_BINARY ? { binary: process.env.CLAXEDO_ACP_BINARY } : {}),
    ...(process.env.CLAXEDO_ACP_MODEL ? { model: process.env.CLAXEDO_ACP_MODEL } : {}),
  }
}

function fallback(type: RuntimeRunner["type"]) {
  if (type === "cursor-acp") return "agent"
  if (type === "codex-acp") return path.resolve(import.meta.dirname, "../../../.bin/codex-acp")
  return path.resolve(import.meta.dirname, "../../../.bin/claude-agent-acp")
}

function binary(runner: RuntimeRunner) {
  const raw = runner.binary ?? process.env.CLAXEDO_ACP_BINARY
  if (!raw) return fallback(runner.type)
  if (!raw.includes(path.sep)) return raw
  if (fs.existsSync(raw)) return raw
  return fallback(runner.type)
}

function json(input: string | undefined) {
  if (!input) return
  try {
    const value = JSON.parse(input) as Record<string, unknown>
    return value && typeof value === "object" ? value : undefined
  } catch {}
}

function env(input: string | undefined) {
  const value = json(input)
  if (!value) return input || undefined
  if (value.type !== "codex_auth") return input || undefined
  return typeof value.OPENAI_API_KEY === "string" ? value.OPENAI_API_KEY : undefined
}

async function codex(input: string | undefined) {
  const value = json(input)
  if (!value || value.type !== "codex_auth") return
  const oauth = value.oauth && typeof value.oauth === "object" ? value.oauth as Record<string, unknown> : undefined
  const row = value.tokens && typeof value.tokens === "object" ? value.tokens as Record<string, unknown> : undefined
  const access = typeof row?.access_token === "string" ? row.access_token : typeof oauth?.access === "string" ? oauth.access : undefined
  const refresh = typeof row?.refresh_token === "string" ? row.refresh_token : typeof oauth?.refresh === "string" ? oauth.refresh : undefined
  const account = typeof row?.account_id === "string" ? row.account_id : typeof oauth?.account_id === "string" ? oauth.account_id : undefined
  if (!access || !refresh || !account) return
  const dir = path.join(os.homedir(), ".codex")
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.promises.writeFile(
    path.join(dir, "auth.json"),
    JSON.stringify({
      auth_mode: typeof value.auth_mode === "string" ? value.auth_mode : "chatgpt",
      OPENAI_API_KEY: typeof value.OPENAI_API_KEY === "string" ? value.OPENAI_API_KEY : null,
      tokens: {
        ...(typeof row?.id_token === "string" ? { id_token: row.id_token } : {}),
        access_token: access,
        refresh_token: refresh,
        account_id: account,
      },
      last_refresh: typeof value.last_refresh === "string" ? value.last_refresh : new Date().toISOString(),
    }, null, 2) + "\n",
    { mode: 0o600 },
  )
}

async function materialize(auth: Record<string, string>) {
  await codex(auth["codex-acp"])
}

function createAdapter(runner: RuntimeRunner): AgentAdapter {
  if (runner.type === "pi") throw new Error("pi runner is central-backed and cannot be hosted in workspace-runtime")
  if (acp(runner.type)) {
    const adapter = new ACPAdapter({ binary: binary(runner), type: runner.type })
    if (runner.model) adapter.setModel(runner.model)
    return adapter
  }
  return new OpenCodeAdapter(process.env.OPENCODE_URL)
}

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  }
}

function closedSse() {
  return new Response(new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.close()
    },
  }), {
    headers: sseHeaders(),
  })
}

async function proxyOpenCode(c: any, adapter: AgentAdapter) {
  if (!("getServerUrl" in adapter)) return
  const url = await (adapter as OpenCodeAdapter).getServerUrl()
  const reqUrl = new URL(c.req.url)
  const target = new URL(reqUrl.pathname + reqUrl.search, url)
  const headers = new Headers(c.req.raw.headers)
  const directory = c.req.query("directory") || c.req.header("x-opencode-directory")
  if (directory) headers.set("x-opencode-directory", assertTarget(directory))
  headers.delete("host")
  headers.delete("connection")
  const req = new Request(target.toString(), {
    method: c.req.method,
    headers,
    body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
    // @ts-ignore
    duplex: "half",
  })
  const res = await fetch(req)
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

export function createWorkspaceFullHost(): WorkspaceHost {
  let runner = initialRunner()
  let state: "ready" | "applying" | "error" = "ready"
  let err = ""
  let enabled = false
  let adapter: AgentAdapter | undefined

  function ensure() {
    if (adapter) return adapter
    adapter = createAdapter(runner)
    enabled = true
    return adapter
  }

  function clear() {
    adapter?.dispose()
    adapter = undefined
  }

  return {
    mount(app: Hono) {
      app.get("/api/wr/acp-config-options", async (c) => {
        const adapter = ensure()
        if (!acp(runner.type)) return c.json([])
        const directory = assertTarget(c.req.query("directory") || c.req.header("x-opencode-directory"))
        try {
          return c.json(await adapter.probeConfigOptions(directory))
        } catch {
          return c.json([])
        }
      })

      app.get("/session/status", async (c) => {
        const adapter = ensure()
        if (runner.type !== "opencode") {
          const directory = assertTarget(c.req.query("directory") || c.req.header("x-opencode-directory"))
          return c.json(sessionStatusSnapshot(await adapter.listSessions(directory)))
        }
        return (await proxyOpenCode(c, adapter))!
      })

      app.get("/mcp", async (c) => {
        const adapter = ensure()
        if (runner.type !== "opencode") return c.json({})
        return (await proxyOpenCode(c, adapter))!
      })

      app.post("/mcp/:name/connect", async (c) => {
        const adapter = ensure()
        if (runner.type !== "opencode") return c.json(true)
        return (await proxyOpenCode(c, adapter))!
      })

      app.post("/mcp/:name/disconnect", async (c) => {
        const adapter = ensure()
        if (runner.type !== "opencode") return c.json(true)
        return (await proxyOpenCode(c, adapter))!
      })

      app.get("/lsp", async (c) => {
        const adapter = ensure()
        if (runner.type !== "opencode") return c.json([])
        return (await proxyOpenCode(c, adapter))!
      })

      app.get("/vcs", async (c) => {
        const adapter = ensure()
        if (runner.type !== "opencode") return c.json({})
        return (await proxyOpenCode(c, adapter))!
      })

      app.get("/global/event", async (c) => {
        const adapter = runner.type === "opencode" ? ensure() : undefined
        if (adapter && "getServerUrl" in adapter) {
          try {
            const url = await (adapter as OpenCodeAdapter).getServerUrl()
            const res = await fetch(`${url}/global/event`, {
              headers: { Accept: "text/event-stream" },
              signal: c.req.raw.signal,
            })
            if (!res.ok || !res.body) return closedSse()
            return new Response(res.body, { status: res.status, headers: res.headers })
          } catch {
            return closedSse()
          }
        }

        const enc = new TextEncoder()
        const chunk = (payload: unknown) => enc.encode(`data: ${JSON.stringify(payload)}\n\n`)

        let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null
        const body = new ReadableStream<Uint8Array>({
          start(next) {
            ctrl = next
            next.enqueue(chunk({ payload: { type: "server.connected", properties: {} } }))
          },
        })

        const unsub = subscribeGlobalEvents((event) => ctrl?.enqueue(chunk(event)))
        const hb = setInterval(() => {
          ctrl?.enqueue(chunk({ payload: { type: "server.heartbeat", properties: {} } }))
        }, 10_000)

        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(hb)
          unsub()
          try {
            ctrl?.close()
          } catch {}
        })

        return new Response(body, { headers: sseHeaders() })
      })

      app.route("/", SessionRoutes(() => ensure()))
      app.route("/", ConfigRoutes((snapshot) => this.apply(snapshot)))
      app.route("/", OpenCodeCompatRoutes())
    },
    async apply(next) {
      state = "applying"
      enabled = next.workspaceHarnessEnabled ?? enabled
      const replacing = next.runner.type !== runner.type || next.runner.binary !== runner.binary

      try {
        await materialize(next.auth)

        if (replacing) {
          clear()
          runner = next.runner
        }

        if (!replacing && adapter && acp(next.runner.type) && "setModel" in adapter && next.runner.model !== runner.model) {
          ;(adapter as ACPAdapter).setModel(next.runner.model ?? "")
        }

        if (adapter && acp(next.runner.type) && "setAuth" in adapter) {
          ;(adapter as ACPAdapter).setAuth({
            anthropic: env(next.auth["claude-acp"]),
            openai: env(next.auth["codex-acp"]),
            cursor: env(next.auth["cursor-acp"]),
          })
        }

        if (!replacing) runner = next.runner
        if (adapter) {
          await adapter.applyConfig({
            mcp: next.mcp,
            auth: next.auth,
            runner: next.runner,
          })
        }
        state = "ready"
        err = ""
      } catch (cause) {
        state = "error"
        err = cause instanceof Error ? cause.message : String(cause)
        throw cause
      }
    },
    detail() {
      return {
        state,
        runner,
        error: err,
        workspaceHarnessEnabled: enabled,
      }
    },
    capabilities() {
      return workspaceCapabilities(enabled)
    },
    dispose() {
      clear()
    },
  }
}
