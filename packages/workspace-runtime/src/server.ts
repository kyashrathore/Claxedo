import path from "path"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { serve } from "@hono/node-server"
import { createNodeWebSocket } from "@hono/node-ws"
import { Pty } from "./pty/index"
import { PtyRoutes } from "./routes/pty"
import { eventsHandler } from "./routes/events"
import { AgentHookRoutes } from "./routes/agent-hook"
import { setupAgentHooks } from "./agent-hooks"
import { ProcessRoutes } from "./routes/process"
import * as ProcessManager from "./process/index"
import { TunnelRoutes } from "./routes/tunnel"
import { DiffRoutes } from "./routes/diff"
import { SessionRoutes } from "./routes/session"
import { ConfigRoutes, type RuntimeRunner, type RuntimeSnapshot } from "./routes/config"
import { OpenCodeCompatRoutes } from "./routes/opencode-compat"
import { OpenCodeAdapter } from "./adapters/opencode"
import { ACPAdapter } from "./adapters/acp"
import type { AgentAdapter } from "./adapters/index"
import { subscribeGlobalEvents } from "./global-event-bus"
import { assertTarget, workspaceDir, workspaceId } from "./target"
import { sessionStatusSnapshot } from "./routes/session-status-snapshot"

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

function createAdapter(runner: RuntimeRunner): AgentAdapter {
  if (acp(runner.type)) {
    const binary =
      runner.binary ??
      process.env.CLAXEDO_ACP_BINARY ??
      (runner.type === "cursor-acp" ? "agent" : path.resolve(import.meta.dirname, "../node_modules/.bin/claude-agent-acp"))
    const adapter = new ACPAdapter({ binary, type: runner.type })
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

export function startServer(port = 3002) {
  let runner = initialRunner()
  let state: "ready" | "applying" | "error" = "ready"
  let err = ""
  let adapter = createAdapter(runner)

  const app = new Hono()

  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  app.use(
    cors({
      origin: (origin) => {
        if (!origin) return undefined
        if (origin.startsWith("http://localhost:")) return origin
        if (origin.startsWith("http://127.0.0.1:")) return origin
        if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(origin)) return origin
        return undefined
      },
    }),
  )

  const apply = async (next: RuntimeSnapshot) => {
    state = "applying"
    const replacing = next.runner.type !== runner.type || next.runner.binary !== runner.binary

    try {
      if (replacing) {
        adapter.dispose()
        runner = next.runner
        adapter = createAdapter(runner)
      }

      if (!replacing && acp(next.runner.type) && "setModel" in adapter && next.runner.model !== runner.model) {
        ;(adapter as ACPAdapter).setModel(next.runner.model ?? "")
      }

      if (acp(next.runner.type) && "setAuth" in adapter) {
        ;(adapter as ACPAdapter).setAuth({
          anthropic: next.auth["claude-acp"] || undefined,
          openai: next.auth["codex-acp"] || undefined,
          cursor: next.auth["cursor-acp"] || undefined,
        })
      }

      if (!replacing) runner = next.runner
      await adapter.applyConfig({
        mcp: next.mcp,
        auth: next.auth,
        runner: next.runner,
      })
      state = "ready"
      err = ""
    } catch (cause) {
      state = "error"
      err = cause instanceof Error ? cause.message : String(cause)
      throw cause
    }
  }

  app.get("/api/wr/health", (c) =>
    c.json((() => {
      const directory = workspaceDir()
      const processes = ProcessManager.list(directory)
      return {
        ok: state === "ready",
        status: state,
        service: "workspace-runtime",
        workspaceId: workspaceId(),
        directory,
        agentType: runner.type,
        acpBinary: acp(runner.type) ? path.basename(runner.binary ?? process.env.CLAXEDO_ACP_BINARY ?? "claude-agent-acp") : null,
        model: runner.model ?? null,
        error: err || null,
        ptyCount: Pty.list().length,
        processCount: processes.length,
        activeProcessCount: processes.filter((item) => item.status !== "idle" && item.status !== "stopped").length,
      }
    })()),
  )

  app.get("/api/wr/acp-config-options", async (c) => {
    if (!acp(runner.type)) return c.json([])
    const directory = assertTarget(c.req.query("directory") || c.req.header("x-opencode-directory"))
    try {
      return c.json(await adapter.probeConfigOptions(directory))
    } catch {
      return c.json([])
    }
  })

  app.get("/global/health", (c) => c.json({ healthy: state === "ready", service: "workspace-runtime" }))

  app.get("/session/status", async (c) => {
    if (runner.type !== "opencode") {
      const directory = assertTarget(c.req.query("directory") || c.req.header("x-opencode-directory"))
      return c.json(sessionStatusSnapshot(await adapter.listSessions(directory)))
    }
    return (await proxyOpenCode(c, adapter))!
  })

  app.get("/mcp", async (c) => {
    if (runner.type !== "opencode") return c.json({})
    return (await proxyOpenCode(c, adapter))!
  })

  app.post("/mcp/:name/connect", async (c) => {
    if (runner.type !== "opencode") return c.json(true)
    return (await proxyOpenCode(c, adapter))!
  })

  app.post("/mcp/:name/disconnect", async (c) => {
    if (runner.type !== "opencode") return c.json(true)
    return (await proxyOpenCode(c, adapter))!
  })

  app.get("/lsp", async (c) => {
    if (runner.type !== "opencode") return c.json([])
    return (await proxyOpenCode(c, adapter))!
  })

  app.get("/vcs", async (c) => {
    if (runner.type !== "opencode") return c.json({})
    return (await proxyOpenCode(c, adapter))!
  })

  app.get("/global/event", async (c) => {
    if (runner.type === "opencode" && "getServerUrl" in adapter) {
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

  app.route("/api/claxedo/pty", PtyRoutes(upgradeWebSocket))
  app.route("/api/claxedo/hook", AgentHookRoutes())
  app.get("/api/claxedo/events", eventsHandler)
  app.route("/api/claxedo/process", ProcessRoutes())
  app.route("/api/claxedo/tunnel", TunnelRoutes())
  app.route("/api/claxedo/diff", DiffRoutes())
  app.route("/", SessionRoutes(() => adapter))
  app.route("/", ConfigRoutes(apply))
  app.route("/", OpenCodeCompatRoutes())

  const server = serve({
    fetch: app.fetch,
    port,
    hostname: "127.0.0.1",
  })
  injectWebSocket(server)

  setupAgentHooks({ port })
    .then(() => {
      console.error(`[workspace-runtime] INFO  agent hooks setup complete`)
    })
    .catch((cause) => {
      console.error(`[workspace-runtime] WARN  failed to setup agent hooks`, cause)
    })

  process.on("SIGTERM", () => {
    adapter.dispose()
    server.close()
    process.exit(0)
  })

  return server
}
