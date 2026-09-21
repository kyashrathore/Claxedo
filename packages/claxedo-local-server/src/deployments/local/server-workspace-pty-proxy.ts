import type { createNodeWebSocket } from "@hono/node-ws"
import type { Context, Hono as HonoType, Next } from "hono"
import { connectEmbeddedWorkspacePty } from "../../deployments/local/embedded-workspace-runtime"
import {
  embedded,
  resolveWorkspaceRuntimeHit,
  resolveWorkspaceRuntimeHitForWorkspaceId,
  type RuntimeProxyOptions,
} from "../../workspace/runtime-dispatch/internals"
import { resolveIngressProvenance } from "../../workspace/runtime-dispatch/ingress-provenance"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"
import { resolveWorkspace, type Workspace } from "@claxedo/server-core/workspace/store/index"

const PTY_ROUTE_PREFIX = "/api/wr/pty"

type IngressOptions = Pick<RuntimeProxyOptions, "resolveRelayActor" | "requireRelayActor" | "verifyRelayIngress">

function ingressOptions(options: RuntimeProxyOptions): IngressOptions {
  return {
    ...(options.resolveRelayActor ? { resolveRelayActor: options.resolveRelayActor } : {}),
    ...(options.requireRelayActor ? { requireRelayActor: true } : {}),
    ...(options.verifyRelayIngress ? { verifyRelayIngress: true } : {}),
  }
}

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

function cursor(c: Context): number | undefined {
  const value = c.req.query("cursor")
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < -1) return undefined
  return parsed
}

function decoded(value: string | undefined): string | undefined {
  if (!value) return undefined
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
    // `??`, not `||`: a supplied-but-empty id still names a workspace, and an
    // explicit id that resolves to nothing must fail closed at the store
    // rather than fall through to directory resolution.
    workspaceId: c.req.query("workspaceId") ?? c.req.query("workspace") ?? c.req.header("x-workspace-id"),
    directory: decoded(c.req.query("directory") || c.req.header("x-claxedo-directory")),
  })
}

/**
 * Whether this caller may attach to an in-process terminal, answered before the
 * upgrade and answered by the runtime that owns the terminal.
 *
 * The socket itself cannot ask: the runtime's own `/:ptyID/connect` upgrade is
 * bound to the `@hono/node-ws` instance `createWorkspaceRuntimeApp` builds for
 * its own app, nothing ever attaches that instance to a listener, and a
 * replayed `app.fetch` therefore reaches the handler and dies writing the
 * connection symbol onto an absent `env`. So the same decision is taken over a
 * plain in-process fetch: `GET /api/wr/pty/:ptyID` resolves ingress provenance,
 * denies a workspace viewer, and runs the session policy's `pty_read` for the
 * session this terminal is bound to. Anything but 200 is the answer the
 * upgrade gets.
 *
 * A loopback-direct caller is not asked at all: no stamp reaches the runtime,
 * so the only refusal it could return is a terminal that is already gone —
 * which the connect below answers with the close code its client reads.
 */
async function localWorkspacePtyRefusal(
  c: Context,
  ws: Workspace,
  ptyId: string,
  options: RuntimeProxyOptions,
): Promise<Response | undefined> {
  const ingress = ingressOptions(options)
  const provenance = await resolveIngressProvenance(c.req.raw, ws.id, ingress)
  if (provenance.kind === "rejected") return provenance.response
  if (provenance.kind === "loopback-direct") return undefined
  const decision = await embedded(c, ws, `${PTY_ROUTE_PREFIX}/${encodeURIComponent(ptyId)}`, ingress)
  if (!decision.ok) return decision
  await decision.body?.cancel()
  return undefined
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
          const payload: unknown = event.data
          const data = payload instanceof Blob ? await payload.arrayBuffer() : payload
          if (typeof data !== "string" && !(data instanceof ArrayBuffer) && !(data instanceof Uint8Array)) return
          try {
            // Same widening as the inbound direction: re-view the bytes over a
            // plain ArrayBuffer rather than assert the frame is not shared.
            ws.send(data instanceof Uint8Array ? new Uint8Array(data) : data)
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
        if (typeof data === "string" || data instanceof ArrayBuffer) {
          sendUpstream(data)
          return
        }
        if (data instanceof Uint8Array) {
          // TS widens a binary frame's view to `Uint8Array<ArrayBufferLike>`,
          // which `WebSocket.send` rejects. Re-viewing the exact bytes over a
          // plain ArrayBuffer states what a WebSocket frame always is, without
          // claiming it.
          sendUpstream(new Uint8Array(data))
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
      !!c.req.header("x-claxedo-directory")
    if (!hasWorkspaceTarget) return next()
    // Same gate as the scoped variant below: attaching to a workspace
    // terminal is loopback-only in this composition — an unauthenticated
    // remote caller must not reach a live shell.
    if (!isLoopbackLocalRequest(c.req.raw)) {
      return c.json(
        errorBody("workspace_relay_local_loopback_required", "Local workspace relay proxy requires loopback access"),
        401,
      )
    }

    const workspace = await requestWorkspace(c).catch(() => undefined)
    if (workspace && workspace.kind !== "cloud") {
      const ptyId = c.req.param("ptyID")
      const refusal = await localWorkspacePtyRefusal(c, workspace, ptyId, options)
      if (refusal) return refusal
      return connectLocalWorkspacePty(upgradeWebSocket, c, next, workspace, ptyId)
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
      const ptyId = c.req.param("ptyID")
      const refusal = await localWorkspacePtyRefusal(c, workspace, ptyId, options)
      if (refusal) return refusal
      return connectLocalWorkspacePty(upgradeWebSocket, c, next, workspace, ptyId)
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
