import type { Hono } from "hono"
import { workspaceCapabilities } from "../capabilities"
import { subscribeGlobalEvents } from "../global-event-bus"
import { ConfigRoutes, type RuntimeRunner, type RuntimeSnapshot } from "../routes/config"
import type { WorkspaceHost } from "./host"

function initialRunner(): RuntimeRunner {
  const type = (process.env.CLAXEDO_AGENT_TYPE ?? "opencode") as RuntimeRunner["type"] | "acp"
  return {
    type: type === "acp" ? "claude-acp" : type,
    ...(process.env.CLAXEDO_ACP_BINARY ? { binary: process.env.CLAXEDO_ACP_BINARY } : {}),
    ...(process.env.CLAXEDO_ACP_MODEL ? { model: process.env.CLAXEDO_ACP_MODEL } : {}),
  }
}

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  }
}

export function createWorkspaceMinimalHost(): WorkspaceHost {
  let runner = initialRunner()
  let state: "ready" | "applying" | "error" = "ready"
  let err = ""

  return {
    mount(app: Hono) {
      app.get("/api/wr/acp-config-options", (c) => c.json([]))

      app.get("/global/event", async (c) => {
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

      app.route("/", ConfigRoutes((snapshot) => this.apply(snapshot)))
    },
    async apply(next: RuntimeSnapshot) {
      state = "applying"
      runner = next.runner
      state = "ready"
      err = ""
    },
    detail() {
      return {
        state,
        runner,
        error: err,
        workspaceHarnessEnabled: false,
      }
    },
    capabilities() {
      return workspaceCapabilities(false)
    },
    dispose() {},
  }
}
