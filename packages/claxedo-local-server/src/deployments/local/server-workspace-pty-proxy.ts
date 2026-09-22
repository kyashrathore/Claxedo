import type { createNodeWebSocket } from "@hono/node-ws"
import type { Context, Hono as HonoType, Next } from "hono"
import { isPtyStreamSocket, type AuthorizedPtyConnection } from "@claxedo/workspace-runtime"
import { attachEmbeddedWorkspacePty } from "../../deployments/local/embedded-workspace-runtime"
import {
  resolveWorkspaceRuntimeHit,
  resolveWorkspaceRuntimeHitForWorkspaceId,
  type RuntimeProxyOptions,
} from "../../workspace/runtime-dispatch/internals"
import { resolveIngressProvenance } from "../../workspace/runtime-dispatch/ingress-provenance"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"
import { resolveWorkspace, type Workspace } from "@claxedo/server-core/workspace/store/index"

type IngressOptions = Pick<RuntimeProxyOptions, "resolveRelayActor" | "requireRelayActor" | "verifyRelayIngress">

function ingressOptions(options: RuntimeProxyOptions): IngressOptions {
  return {
    ...(options.resolveRelayActor ? { resolveRelayActor: options.resolveRelayActor } : {}),
    ...(options.requireRelayActor ? { requireRelayActor: true } : {}),
    ...(options.verifyRelayIngress ? { verifyRelayIngress: true } : {}),
  }
}

type UpgradeWebSocket = ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"]

function errorBody(code: string, message: string) {
  return { error: { code, message } }
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
 * Admits this caller to an in-process terminal, before the upgrade, through
 * the runtime's own authorized terminal lifetime.
 *
 * The runtime's `/:ptyID/connect` route cannot be replayed for it: that
 * upgrade is bound to the `@hono/node-ws` instance `createWorkspaceRuntimeApp`
 * builds for its own app, nothing ever attaches that instance to a listener,
 * and an `app.fetch` therefore reaches the handler and dies writing the
 * connection symbol onto an absent `env`. So this hop takes the SAME policy
 * decision the route would have taken — admission now, renewed reads and
 * per-keystroke writes for as long as the socket lives — by handing the
 * identity its ingress verified to `attachEmbeddedWorkspacePty`.
 *
 * A loopback-direct caller carries no identity into that policy, which is what
 * makes it this machine's own user; nothing here mints one.
 */
async function attachLocalWorkspacePty(
  c: Context,
  ws: Workspace,
  ptyId: string,
  options: RuntimeProxyOptions,
): Promise<{ ok: true; connection: AuthorizedPtyConnection } | { ok: false; response: Response }> {
  const provenance = await resolveIngressProvenance(c.req.raw, ws.id, ingressOptions(options))
  if (provenance.kind === "rejected") return { ok: false, response: provenance.response }
  const position = cursor(c)
  return await attachEmbeddedWorkspacePty({
    workspace: ws,
    ptyId,
    // The relay's own bearer is the proof the session authority checks, and it
    // travels only with the identity it was verified as.
    ...(provenance.kind === "relay-replayed"
      ? {
          identity: provenance.stamp,
          ...(c.req.header("authorization") ? { authorization: c.req.header("authorization")! } : {}),
        }
      : {}),
    method: c.req.method,
    path: c.req.path,
    ...(position === undefined ? {} : { cursor: position }),
  })
}

function connectLocalWorkspacePty(
  upgradeWebSocket: UpgradeWebSocket,
  c: Context,
  next: Next,
  connection: AuthorizedPtyConnection,
) {
  return upgradeWebSocket(() => ({
    onOpen(_event, socket) {
      const raw = socket.raw
      if (!isPtyStreamSocket(raw)) {
        socket.close()
        return
      }
      connection.onOpen(raw)
    },
    onMessage(event) {
      const data = messageData(event)
      if (data instanceof Blob) {
        // The connection processes messages in arrival order; a Blob resolved
        // here would jump the frames behind it, so the whole frame is handed
        // over as one already-ordered unit.
        connection.onMessage(data.arrayBuffer())
        return
      }
      connection.onMessage(data)
    },
    onClose() {
      connection.onClose()
    },
    onError() {
      connection.onClose()
    },
  }))(c, next)
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
      const attach = await attachLocalWorkspacePty(c, workspace, c.req.param("ptyID"), options)
      if (!attach.ok) return attach.response
      return connectLocalWorkspacePty(upgradeWebSocket, c, next, attach.connection)
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
      const attach = await attachLocalWorkspacePty(c, workspace, c.req.param("ptyID"), options)
      if (!attach.ok) return attach.response
      return connectLocalWorkspacePty(upgradeWebSocket, c, next, attach.connection)
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
