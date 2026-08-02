import type { createNodeWebSocket } from "@hono/node-ws"
import type { Context, Hono as HonoType, Next } from "hono"
import { connectEmbeddedWorkspacePty } from "../../deployments/local/embedded-workspace-runtime"
import {
  resolveWorkspaceRuntimeHit,
  resolveWorkspaceRuntimeHitForWorkspaceId,
  type RuntimeProxyOptions,
} from "../../http/proxy"
import { isLoopbackLocalRequest } from "../../routes/local-only-projection"
import { resolveWorkspace, type Workspace } from "../../workspace/store"

type UpgradeWebSocket = ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"]

type PtySocket = {
  readyState: number
  send: (data: string | Uint8Array | ArrayBuffer) => void
  close: (code?: number, reason?: string) => void
}

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

function isPtySocket(value: unknown): value is PtySocket {
  if (!value || typeof value !== "object") return false
  if (!("readyState" in value) || typeof (value as { readyState?: unknown }).readyState !== "number") return false
  if (!("send" in value) || typeof (value as { send?: unknown }).send !== "function") return false
  return "close" in value && typeof (value as { close?: unknown }).close === "function"
}

function cursor(c: Context) {
  const value = c.req.query("cursor")
  if (!value) return
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < -1) return
  return parsed
}

function decoded(value: string | undefined) {
  if (!value) return
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function messageData(event: unknown) {
  return event && typeof event === "object" && "data" in event
    ? (event as { data: unknown }).data
    : event
}

function requestWorkspace(c: Context) {
  return resolveWorkspace({
    workspaceId: c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id"),
    directory: decoded(c.req.query("directory") || c.req.header("x-opencode-directory")),
  })
}

function connectLocalWorkspacePty(
  upgradeWebSocket: UpgradeWebSocket,
  c: Context,
  next: Next,
  ws: Workspace,
  ptyId: string,
) {
  return upgradeWebSocket(() => {
    let handler: Awaited<ReturnType<typeof connectEmbeddedWorkspacePty>>
    let closed = false
    const pending: unknown[] = []

    const sendLocal = (data: unknown) => {
      if (!handler) {
        pending.push(data)
        return
      }
      handler.onMessage(data)
    }

    return {
      onOpen(_event, socket) {
        const raw = socket.raw
        if (!isPtySocket(raw)) {
          socket.close()
          return
        }
        void connectEmbeddedWorkspacePty(ws, ptyId, raw, cursor(c)).then((nextHandler) => {
          handler = nextHandler
          if (closed) {
            handler?.onClose()
            return
          }
          for (const item of pending.splice(0)) handler?.onMessage(item)
        }).catch(() => {
          socket.close(1011, "Workspace terminal proxy failed")
        })
      },
      onMessage(event) {
        const data = messageData(event)
        if (data instanceof Blob) {
          void data.arrayBuffer().then(sendLocal)
          return
        }
        sendLocal(data)
      },
      onClose() {
        closed = true
        handler?.onClose()
      },
      onError() {
        closed = true
        handler?.onClose()
      },
    }
  })(c, next)
}

function connectRemoteWorkspacePty(
  upgradeWebSocket: UpgradeWebSocket,
  c: Context,
  next: Next,
  hit: NonNullable<Awaited<ReturnType<typeof resolveWorkspaceRuntimeHit>>>,
  pathname?: string,
) {
  const source = new URL(c.req.url)
  const target = new URL((pathname ?? source.pathname) + source.search, hit.url)
  if (target.searchParams.has("directory")) target.searchParams.set("directory", hit.directory)
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:"

  return upgradeWebSocket(() => {
    let upstream: WebSocket | undefined
    const pending: Array<string | ArrayBuffer | Uint8Array<ArrayBuffer>> = []

    const sendUpstream = (data: string | ArrayBuffer | Uint8Array<ArrayBuffer>) => {
      if (!upstream || upstream.readyState !== WebSocket.OPEN) {
        pending.push(data)
        return
      }
      upstream.send(data)
    }

    return {
      onOpen(_event, ws) {
        upstream = new WebSocket(target)
        upstream.addEventListener("open", () => {
          for (const item of pending.splice(0)) upstream?.send(item)
        })
        upstream.addEventListener("message", async (event) => {
          const data = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data
          try {
            ws.send(data as string | ArrayBuffer)
          } catch {
            upstream?.close()
          }
        })
        upstream.addEventListener("close", (event) => {
          try {
            ws.close(event.code || 1000, event.reason)
          } catch {}
        })
        upstream.addEventListener("error", () => {
          try {
            ws.close(1011, "Workspace terminal proxy failed")
          } catch {}
        })
      },
      onMessage(event) {
        const data = messageData(event)
        if (data instanceof Blob) {
          void data.arrayBuffer().then(sendUpstream)
          return
        }
        if (typeof data === "string" || data instanceof ArrayBuffer || data instanceof Uint8Array) {
          // A WebSocket binary message is never SharedArrayBuffer-backed, so the
          // Uint8Array is ArrayBuffer-backed (TS7 widens the bare type to
          // ArrayBufferLike, which WebSocket.send rejects).
          sendUpstream(data as string | ArrayBuffer | Uint8Array<ArrayBuffer>)
        }
      },
      onClose() {
        if (upstream && (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)) {
          upstream.close()
        }
      },
      onError() {
        if (upstream && (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)) {
          upstream.close()
        }
      },
    }
  })(c, next)
}

export function mountWorkspaceRuntimePtyWebSocketProxy(
  app: HonoType,
  upgradeWebSocket: UpgradeWebSocket,
  options: RuntimeProxyOptions = {},
) {
  app.get("/api/wr/pty/:ptyID/connect", async (c, next) => {
    const hasWorkspaceTarget =
      !!c.req.query("workspaceId") ||
      !!c.req.query("workspace") ||
      !!c.req.query("directory") ||
      !!c.req.header("x-workspace-id") ||
      !!c.req.header("x-opencode-directory")
    if (!hasWorkspaceTarget) return next()

    const workspace = await requestWorkspace(c).catch(() => undefined)
    if (workspace && workspace.kind !== "cloud") {
      return connectLocalWorkspacePty(upgradeWebSocket, c, next, workspace, c.req.param("ptyID"))
    }

    const hit = await resolveWorkspaceRuntimeHit(c, options).catch(() => undefined)
    if (!hit) return next()
    return connectRemoteWorkspacePty(upgradeWebSocket, c, next, hit)
  })

  const workspacePtyConnectPath = "/workspaces/:workspaceId/api/wr/pty/:ptyID/connect"
  app.use(workspacePtyConnectPath, async (c, next) => {
    if (c.req.method !== "GET") return next()
    if (!isLoopbackLocalRequest(c.req.raw)) {
      return c.json(
        errorBody("workspace_relay_local_loopback_required", "Local workspace relay proxy requires loopback access"),
        401,
      )
    }
    return next()
  })
  app.get(workspacePtyConnectPath, async (c, next) => {
    const workspaceId = c.req.param("workspaceId")
    if (!workspaceId) return next()
    const workspace = await resolveWorkspace({ workspaceId }).catch(() => undefined)
    if (workspace && workspace.kind !== "cloud") {
      return connectLocalWorkspacePty(upgradeWebSocket, c, next, workspace, c.req.param("ptyID"))
    }
    const hit = await resolveWorkspaceRuntimeHitForWorkspaceId(workspaceId, options).catch(() => undefined)
    if (!hit) return next()
    return connectRemoteWorkspacePty(
      upgradeWebSocket,
      c,
      next,
      hit,
      `/api/wr/pty/${encodeURIComponent(c.req.param("ptyID"))}/connect`,
    )
  })
}
