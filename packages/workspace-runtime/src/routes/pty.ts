import { Hono } from "hono"
import type { WSContext } from "hono/ws"
import type { UpgradeWebSocket } from "hono/ws"
import { Pty } from "../pty/index"
import { boundedJsonBody, errorBody, isRequestBodyTooLarge, requestBodyTooLargeBody } from "./http"
import { assertTarget, resolveWorkspacePath, WorkspaceTargetError } from "../target"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import type { ProcessObserver } from "../managed-processes/process-observer"
import { sessionAccessContext, sessionAccessDenied, type SessionAccessPolicy } from "../session-access-policy"
import { authorizeHostCapability, type HostCapabilityAccessOptions } from "./host-capability-access"

function invalidInput(details: Record<string, unknown>) {
  return errorBody("pty_invalid_input", "Invalid PTY request body", details)
}

function notFound() {
  return errorBody("pty_session_not_found", "Session not found")
}

function invalidDirectory() {
  return errorBody("pty_invalid_directory", "PTY directory must match configured workspace")
}

function invalidPath(message: string) {
  return errorBody("pty_invalid_path", message)
}

function requestPort(url: string) {
  try {
    const parsed = new URL(url)
    return parsed.port || (parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : undefined)
  } catch {
    return
  }
}

type PtyRouteOptions = HostCapabilityAccessOptions & {
  processObserver?: ProcessObserver
}

function canAdministerAll(c: Parameters<typeof sessionAccessContext>[0]) {
  const role = sessionAccessContext(c).authority?.role
  return role === "admin" || role === "owner"
}

function actorOwnsPty(c: Parameters<typeof sessionAccessContext>[0], id: string) {
  const context = sessionAccessContext(c)
  if (!context.authority) return true
  if (canAdministerAll(c)) return true
  return !!context.actor && Pty.accessOwner(id) === context.actor.actorId
}

function ptyPrivate() {
  return sessionAccessDenied({
    allowed: false,
    status: 403,
    code: "pty_private",
    message: "Terminal access requires its creator or a workspace administrator",
  })
}

function requestedPtyId(path: string) {
  const parts = path.split("/").filter(Boolean)
  if (parts.at(-1) === "connect") return parts.at(-2)
  return parts.at(-1)
}

export function PtyRoutes(
  upgradeWebSocket: UpgradeWebSocket,
  processObserverOrOptions?: ProcessObserver | PtyRouteOptions,
  sessionAccessPolicy?: SessionAccessPolicy,
) {
  const options: PtyRouteOptions = processObserverOrOptions && "register" in processObserverOrOptions
    ? { processObserver: processObserverOrOptions, ...(sessionAccessPolicy ? { sessionAccessPolicy } : {}) }
    : processObserverOrOptions ?? {}
  const processObserver = options.processObserver
  return new Hono<{ Variables: RelayHostAuthContext }>()
    .onError((err, c) => {
      if (isRequestBodyTooLarge(err)) return c.json(requestBodyTooLargeBody(), 413)
      throw err
    })
    // Terminal access is sensitive even when the transport method is GET.
    .use("*", async (c, next) => {
      if (c.get("relayHostAuth")?.role === "viewer") {
        return c.json(errorBody("relay_role_denied", "Workspace role does not allow terminal access"), 403)
      }
      const write = !["GET", "HEAD", "OPTIONS"].includes(c.req.method)
      const denied = await authorizeHostCapability(c, options, write ? "pty_write" : "pty_read")
      if (denied) return denied

      // Hono populates route params after wildcard middleware has run, so the
      // guard derives the terminal candidate from the already-normalized path.
      // It only treats it as an id when the canonical PTY store confirms it.
      const candidate = requestedPtyId(c.req.path)
      const id = candidate && Pty.get(candidate) ? candidate : undefined
      if (id && Pty.get(id) && !actorOwnsPty(c, id)) return ptyPrivate()
      return await next()
    })
    .get("/", async (c) => {
      if (!sessionAccessContext(c).authority || canAdministerAll(c)) return c.json(Pty.list())
      return c.json(Pty.list().filter((info) => actorOwnsPty(c, info.id)))
    })
    .post("/", async (c) => {
      const body = await boundedJsonBody<unknown | null>(c, null)
      const parsed = Pty.CreateInput.safeParse(body)
      if (!parsed.success) {
        return c.json(invalidInput(parsed.error.flatten()), 400)
      }
      // Strip `managed` — only the process manager (internal caller) may set it
      const { managed: _, ...input } = parsed.data
      const workspaceId = c.req.header("x-workspace-id")
      let cwd: string | undefined
      try {
        const directory = assertTarget(c.req.header("x-opencode-directory"))
        cwd = input.cwd ? await resolveWorkspacePath(directory, input.cwd) : directory
      } catch (err) {
        if (err instanceof WorkspaceTargetError && err.message.includes("pinned")) {
          return c.json(invalidDirectory(), 400)
        }
        if (err instanceof WorkspaceTargetError) {
          return c.json(invalidPath(err.message), 400)
        }
        throw err
      }
      const port = requestPort(c.req.url)
      const info = await Pty.create(
        {
          ...input,
          ...(cwd ? { cwd } : {}),
          env: {
            ...(input.env ?? {}),
            ...(port ? { CLAXEDO_PORT: port } : {}),
            ...(workspaceId ? { CLAXEDO_WORKSPACE_ID: workspaceId } : {}),
          },
        },
        processObserver
          ? {
              observer: processObserver,
              kind: "pty",
              ownerId: `pty:${crypto.randomUUID()}`,
              workspaceId: workspaceId ?? cwd,
              directory: cwd,
              label: input.title ?? "Terminal",
            }
          : undefined,
      )
      const actorId = sessionAccessContext(c).actor?.actorId
      if (actorId && !Pty.bindAccessOwner(info.id, actorId)) {
        await Pty.remove(info.id)
        return c.json(errorBody("pty_owner_bind_failed", "Terminal ownership could not be recorded"), 503)
      }
      // Ownership transfers only once the public create path has completed.
      // From this point the PTY belongs to the user and must outlive any
      // renderer/WebSocket connection that happens to observe it.
      Pty.commit(info.id)
      return c.json(info)
    })
    .get("/:ptyID", async (c) => {
      const id = c.req.param("ptyID")
      const info = Pty.get(id)
      if (!info) return c.json(notFound(), 404)
      return c.json(info)
    })
    .put("/:ptyID", async (c) => {
      const id = c.req.param("ptyID")
      const body = await boundedJsonBody<unknown | null>(c, null)
      const parsed = Pty.UpdateInput.safeParse(body)
      if (!parsed.success) {
        return c.json(invalidInput(parsed.error.flatten()), 400)
      }
      const info = await Pty.update(id, parsed.data)
      if (!info) return c.json(notFound(), 404)
      return c.json(info)
    })
    .delete("/:ptyID", async (c) => {
      const id = c.req.param("ptyID")
      await Pty.remove(id)
      return c.json(true)
    })
    .get(
      "/:ptyID/connect",
      upgradeWebSocket((c) => {
        const id = c.req.param("ptyID")!
        const cursor = (() => {
          const value = c.req.query("cursor")
          if (!value) return
          const parsed = Number(value)
          if (!Number.isSafeInteger(parsed) || parsed < -1) return
          return parsed
        })()
        let handler: ReturnType<typeof Pty.connect>

        type Socket = {
          readyState: number
          send: (data: string | Uint8Array | ArrayBuffer) => void
          close: (code?: number, reason?: string) => void
        }

        const isSocket = (value: unknown): value is Socket => {
          if (!value || typeof value !== "object") return false
          if (!("readyState" in value)) return false
          if (!("send" in value) || typeof (value as { send?: unknown }).send !== "function") return false
          if (!("close" in value) || typeof (value as { close?: unknown }).close !== "function") return false
          return typeof (value as { readyState?: unknown }).readyState === "number"
        }

        return {
          onOpen(_event: Event, ws: WSContext) {
            const socket = ws.raw
            if (!isSocket(socket)) {
              ws.close()
              return
            }
            handler = Pty.connect(id, socket as any, cursor)
          },
          onMessage(event: { data: unknown }) {
            handler?.onMessage(event.data)
          },
          onClose() {
            handler?.onClose()
          },
          onError() {
            handler?.onClose()
          },
        }
      }),
    )
}
