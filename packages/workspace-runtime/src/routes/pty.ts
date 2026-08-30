import { Hono, type Context } from "hono"
import type { WSContext } from "hono/ws"
import type { UpgradeWebSocket } from "hono/ws"
import { Pty } from "../pty/index"
import { boundedJsonBody, errorBody, isRequestBodyTooLarge, requestBodyTooLargeBody } from "./http"
import { assertTarget, resolveWorkspaceCommandPaths, resolveWorkspacePath, WorkspaceTargetError } from "../target"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import type { ProcessObserver } from "../managed-processes/process-observer"
import { denyWorkspaceViewers } from "./workspace-role"
import { readHistorySessionId } from "../pty/history-disk"
import {
  managedWorkspaceSessionAccessPolicy,
  sessionAccessContext,
  sessionAccessDenied,
  type SessionAccessOperation,
  type SessionAccessPolicy,
} from "../session-access-policy"

const PTY_AUTHORIZATION_REFRESH_MS = 1_000
const PTY_AUTHORIZATION_LEASE_MS = 5_000

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

function sessionRequired() {
  return errorBody("pty_session_id_required", "Managed PTY creation requires a sessionId")
}

function requestPort(url: string) {
  try {
    const parsed = new URL(url)
    return parsed.port || (parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : undefined)
  } catch {
    return
  }
}

export function PtyRoutes(
  upgradeWebSocket: UpgradeWebSocket,
  processObserver?: ProcessObserver,
  policy: SessionAccessPolicy = managedWorkspaceSessionAccessPolicy(),
) {
  const authorize = async (
    c: Context<{ Variables: RelayHostAuthContext }>,
    info: Pty.Info,
    operation: Extract<SessionAccessOperation, "pty_read" | "pty_write">,
  ) => {
    const access = sessionAccessContext(c as never)
    if (!access.authority) return
    if (!info.sessionId) return c.json(notFound(), 404)
    const decision = await policy.authorize({
      ...access,
      operation,
      sessionId: info.sessionId,
      method: c.req.method,
      path: c.req.path,
    })
    if (!decision.allowed) return sessionAccessDenied(decision)
  }

  return new Hono<{ Variables: RelayHostAuthContext }>()
    .onError((err, c) => {
      if (isRequestBodyTooLarge(err)) return c.json(requestBodyTooLargeBody(), 413)
      throw err
    })
    // Terminal access is sensitive even when the transport method is GET.
    .use("*", denyWorkspaceViewers("Workspace role does not allow terminal access"))
    .get("/", async (c) => {
      const rows = Pty.list()
      const access = sessionAccessContext(c as never)
      if (!access.authority) return c.json(rows)
      const scoped = rows.filter((row) => row.sessionId)
      const allowed = new Set(await policy.filterSessions({
        ...access,
        operation: "pty_read",
        method: c.req.method,
        path: c.req.path,
        sessionIds: scoped.map((row) => row.sessionId!),
      }))
      return c.json(scoped.filter((row) => allowed.has(row.sessionId!)))
    })
    .post("/", async (c) => {
      const body = await boundedJsonBody<unknown | null>(c, null)
      const parsed = Pty.CreateInput.safeParse(body)
      if (!parsed.success) {
        return c.json(invalidInput(parsed.error.flatten()), 400)
      }
      const access = sessionAccessContext(c as never)
      if (access.authority && !parsed.data.sessionId) return c.json(sessionRequired(), 400)
      if (access.authority) {
        const decision = await policy.authorize({
          ...access,
          operation: "pty_write",
          sessionId: parsed.data.sessionId,
          method: c.req.method,
          path: c.req.path,
        })
        if (!decision.allowed) return sessionAccessDenied(decision)
      }
      // Strip `managed` — only the process manager (internal caller) may set it
      const { managed: _, ...input } = parsed.data
      const workspaceId = c.req.header("x-workspace-id")
      let cwd: string | undefined
      try {
        const directory = assertTarget(c.req.header("x-opencode-directory"))
        cwd = input.cwd ? await resolveWorkspacePath(directory, input.cwd) : directory
        await resolveWorkspaceCommandPaths(directory, {
          command: input.command,
          args: input.args,
          allowAbsoluteExecutable: true,
        })
        if (input.initialCommand) {
          await resolveWorkspaceCommandPaths(directory, {
            command: input.initialCommand,
            allowAbsoluteExecutable: true,
          })
        }
      } catch (err) {
        if (err instanceof WorkspaceTargetError && err.message.includes("pinned")) {
          return c.json(invalidDirectory(), 400)
        }
        if (err instanceof WorkspaceTargetError) {
          return c.json(invalidPath(err.message), 400)
        }
        throw err
      }
      if (
        access.authority
        && input.env?.previousPtyId
        && await readHistorySessionId(cwd!, input.env.previousPtyId) !== input.sessionId
      ) {
        return sessionAccessDenied({
          allowed: false,
          status: 403,
          code: "pty_history_forbidden",
          message: "PTY history belongs to another session",
        })
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
              ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            }
          : undefined,
      )
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
      const guarded = await authorize(c, info, "pty_read")
      if (guarded) return guarded
      return c.json(info)
    })
    .put("/:ptyID", async (c) => {
      const id = c.req.param("ptyID")
      const body = await boundedJsonBody<unknown | null>(c, null)
      const parsed = Pty.UpdateInput.safeParse(body)
      if (!parsed.success) {
        return c.json(invalidInput(parsed.error.flatten()), 400)
      }
      const current = Pty.get(id)
      if (!current) return c.json(notFound(), 404)
      const guarded = await authorize(c, current, "pty_write")
      if (guarded) return guarded
      const info = await Pty.update(id, parsed.data)
      if (!info) return c.json(notFound(), 404)
      return c.json(info)
    })
    .delete("/:ptyID", async (c) => {
      const id = c.req.param("ptyID")
      const info = Pty.get(id)
      if (!info) return c.json(notFound(), 404)
      const guarded = await authorize(c, info, "pty_write")
      if (guarded) return guarded
      await Pty.remove(id)
      return c.json(true)
    })
    .get(
      "/:ptyID/connect",
      async (c, next) => {
        const info = Pty.get(c.req.param("ptyID"))
        if (!info) return c.json(notFound(), 404)
        const guarded = await authorize(c, info, "pty_read")
        if (guarded) return guarded
        return next()
      },
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
        let messages = Promise.resolve()
        let outputAuthorized = true
        let refreshingAuthorization = false
        let authorizationExpiresAt = 0
        let authorizationTimer: ReturnType<typeof setInterval> | undefined
        let activeSocket: Socket | undefined
        let readLease: string | undefined
        let writeLease: string | undefined
        let writeAuthorizationExpiresAt = 0
        const streamAccess = sessionAccessContext(c as never)

        const authorizeStream = async (
          info: Pty.Info,
          operation: Extract<SessionAccessOperation, "pty_read" | "pty_write">,
          lease?: string,
        ) => {
          if (!streamAccess.authority || !info.sessionId) {
            return { allowed: !streamAccess.authority, expiresAt: Date.now() + PTY_AUTHORIZATION_LEASE_MS } as const
          }
          if (policy.authorizeStream) {
            return await policy.authorizeStream({
              ...streamAccess,
              operation,
              sessionId: info.sessionId,
              method: c.req.method,
              path: c.req.path,
            }, lease)
          }
          const decision = await policy.authorize({
            ...streamAccess,
            operation,
            sessionId: info.sessionId,
            method: c.req.method,
            path: c.req.path,
          })
          return decision.allowed
            ? { allowed: true as const, expiresAt: Date.now() + PTY_AUTHORIZATION_LEASE_MS }
            : decision
        }

        type Socket = {
          readyState: number
          bufferedAmount?: number
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

        const closeDenied = (reason: string) => {
          if (!outputAuthorized) return
          outputAuthorized = false
          if (authorizationTimer) clearInterval(authorizationTimer)
          handler?.onClose()
          activeSocket?.close(1008, reason)
        }

        const refreshAuthorization = async () => {
          if (!outputAuthorized) return
          if (Date.now() >= authorizationExpiresAt) {
            closeDenied("Session access check timed out")
            return
          }
          if (Date.now() + PTY_AUTHORIZATION_LEASE_MS < authorizationExpiresAt) return
          if (refreshingAuthorization) return
          refreshingAuthorization = true
          try {
            const info = Pty.get(id)
            if (!info) {
              closeDenied("Session not found")
              return
            }
            const decision = await authorizeStream(info, "pty_read", readLease)
            if (!decision.allowed) {
              closeDenied("Session access denied")
              return
            }
            readLease = "lease" in decision ? decision.lease : undefined
            if (outputAuthorized) authorizationExpiresAt = decision.expiresAt
          } catch {
            closeDenied("Session access denied")
          } finally {
            refreshingAuthorization = false
          }
        }

        return {
          onOpen(_event: Event, ws: WSContext) {
            const socket = ws.raw
            if (!isSocket(socket)) {
              ws.close()
              return
            }
            activeSocket = socket
            authorizationExpiresAt = Date.now() + PTY_AUTHORIZATION_LEASE_MS
            handler = Pty.connect(id, {
              get readyState() {
                return outputAuthorized ? socket.readyState : 3
              },
              get bufferedAmount() {
                return socket.bufferedAmount
              },
              send(data) {
                if (outputAuthorized && socket.readyState === 1) socket.send(data)
              },
              close(code, reason) {
                socket.close(code, reason)
              },
            }, cursor)
            void refreshAuthorization()
            authorizationTimer = setInterval(() => void refreshAuthorization(), PTY_AUTHORIZATION_REFRESH_MS)
            ;(authorizationTimer as { unref?: () => void }).unref?.()
          },
          onMessage(event: { data: unknown }) {
            messages = messages.then(async () => {
              const info = Pty.get(id)
              if (!info) {
                handler?.onClose()
                activeSocket?.close(1008, "Session not found")
                return
              }
              if (Date.now() + 1_000 >= writeAuthorizationExpiresAt) {
                const decision = await authorizeStream(info, "pty_write", writeLease)
                if (!decision.allowed) {
                  handler?.onClose()
                  activeSocket?.close(1008, "Session access denied")
                  return
                }
                writeLease = "lease" in decision ? decision.lease : undefined
                writeAuthorizationExpiresAt = decision.expiresAt
              }
              if (!outputAuthorized) {
                handler?.onClose()
                activeSocket?.close(1008, "Session access denied")
                return
              }
              handler?.onMessage(event.data)
            })
          },
          onClose() {
            outputAuthorized = false
            if (authorizationTimer) clearInterval(authorizationTimer)
            handler?.onClose()
          },
          onError() {
            outputAuthorized = false
            if (authorizationTimer) clearInterval(authorizationTimer)
            handler?.onClose()
          },
        }
      }),
    )
}
