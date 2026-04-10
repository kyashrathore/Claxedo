import { Hono } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { WSContext, UpgradeWebSocket } from "hono/ws"
import { ensureWorkspaceRuntime, findPtyWorkspace, forgetPty, listWorkspaceRuntimes, rememberPty } from "../workspace-supervisor"
import { resolveWorkspace } from "../workspace-store"

function copy(res: Response) {
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

async function forward(url: string, c: { req: { raw: Request; method: string } }) {
  const headers = new Headers(c.req.raw.headers)
  headers.delete("host")
  headers.delete("connection")
  const req = new Request(url, {
    method: c.req.method,
    headers,
    body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
    // @ts-ignore
    duplex: "half",
  })
  return fetch(req)
}

async function locate(ptyId: string) {
  const workspaceId = await findPtyWorkspace(ptyId)
  if (!workspaceId) return
  const runtime = await ensureWorkspaceRuntime(workspaceId)
  return {
    workspaceId,
    url: runtime.url!,
  }
}

type Socket = {
  readyState: number
  send: (data: string | Uint8Array | ArrayBuffer) => void
  close: (code?: number, reason?: string) => void
}

function isSocket(value: unknown): value is Socket {
  if (!value || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  return typeof obj.readyState === "number" && typeof obj.send === "function" && typeof obj.close === "function"
}

function payload(data: unknown): string | ArrayBuffer | Uint8Array | undefined {
  if (typeof data === "string" || data instanceof ArrayBuffer || data instanceof Uint8Array) return data
}

export function PtyProxyRoutes(upgradeWebSocket: UpgradeWebSocket) {
  return new Hono()
    .get("/", async (c) => {
      const bodies = await Promise.allSettled(
        listWorkspaceRuntimes().map(async (item) => {
          const res = await fetch(`${item.url}/api/claxedo/pty`, {
            headers: {
              "x-workspace-id": item.workspaceId,
              "x-opencode-directory": item.directory,
            },
            signal: AbortSignal.timeout(2_000),
          })
          if (!res.ok) return []
          const body = await res.json().catch(() => [])
          if (!Array.isArray(body)) return []
          for (const row of body) {
            if (row?.id) rememberPty(row.id, item.workspaceId)
          }
          return body
        }),
      )
      return c.json(
        bodies.flatMap((item) => (item.status === "fulfilled" ? item.value : [])),
      )
    })
    .post("/", async (c) => {
      const body = await c.req.json().catch(() => null) as
        | { cwd?: string; env?: Record<string, string> }
        | null
      if (!body) return c.json({ error: "Invalid JSON body" }, 400)
      const workspaceId = c.req.header("x-workspace-id") || body.env?.CLAXEDO_WORKSPACE_ID
      const directory = c.req.header("x-opencode-directory") || body.cwd
      const ws = await resolveWorkspace({
        workspaceId,
        directory,
        create: !!directory,
      })
      if (!ws) return c.json({ error: "workspaceId or cwd is required" }, 400)
      body.cwd = body.cwd || ws.directory
      body.env = {
        ...(body.env ?? {}),
        CLAXEDO_WORKSPACE_ID: ws.id,
      }
      const runtime = await ensureWorkspaceRuntime(ws.id)
      const res = await fetch(`${runtime.url}/api/claxedo/pty`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-workspace-id": ws.id,
          "x-opencode-directory": ws.directory,
        },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => null) as { id?: string } | null
      if (json?.id) rememberPty(json.id, ws.id)
      return c.json(json, res.status as ContentfulStatusCode)
    })
    .get("/:ptyID", async (c) => {
      const hit = await locate(c.req.param("ptyID"))
      if (!hit) return c.json({ error: "Session not found" }, 404)
      const res = await fetch(`${hit.url}/api/claxedo/pty/${encodeURIComponent(c.req.param("ptyID"))}`, {
        headers: {
          "x-workspace-id": hit.workspaceId,
        },
      })
      return copy(res)
    })
    .put("/:ptyID", async (c) => {
      const hit = await locate(c.req.param("ptyID"))
      if (!hit) return c.json({ error: "Session not found" }, 404)
      return copy(await forward(`${hit.url}/api/claxedo/pty/${encodeURIComponent(c.req.param("ptyID"))}`, c))
    })
    .delete("/:ptyID", async (c) => {
      const id = c.req.param("ptyID")
      const hit = await locate(id)
      if (!hit) return c.json({ error: "Session not found" }, 404)
      forgetPty(id)
      return copy(await forward(`${hit.url}/api/claxedo/pty/${encodeURIComponent(id)}`, c))
    })
    .get(
      "/:ptyID/connect",
      upgradeWebSocket((c) => {
        const id = c.req.param("ptyID")
        const cursor = c.req.query("cursor")
        let upstream: WebSocket | undefined

        return {
          async onOpen(_event: Event, ws: WSContext) {
            const socket = ws.raw
            if (!isSocket(socket)) {
              ws.close()
              return
            }
            const hit = await locate(id)
            if (!hit) {
              ws.close(1008, "Session not found")
              return
            }
            const url = new URL(`/api/claxedo/pty/${encodeURIComponent(id)}/connect`, hit.url)
            if (cursor) url.searchParams.set("cursor", cursor)
            upstream = new WebSocket(url.toString().replace(/^http/, "ws"))
            upstream.binaryType = "arraybuffer"
            upstream.onmessage = (event) => {
              const next = payload(event.data)
              if (next !== undefined) socket.send(next)
            }
            upstream.onclose = (event) => {
              socket.close(event.code, event.reason)
            }
            upstream.onerror = () => {
              socket.close(1011, "Upstream PTY connection failed")
            }
          },
          onMessage(event: { data: unknown }) {
            const next = payload(event.data)
            if (next !== undefined) upstream?.send(next)
          },
          onClose() {
            upstream?.close()
          },
          onError() {
            upstream?.close()
          },
        }
      }),
    )
}
