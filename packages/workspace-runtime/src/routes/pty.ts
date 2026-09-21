import { Hono, type Context } from "hono"
import type { WSContext } from "hono/ws"
import type { UpgradeWebSocket } from "hono/ws"
import { Pty } from "../pty/index"
import { boundedJsonBody, errorBody, isRequestBodyTooLarge, requestBodyTooLargeBody, routeParam } from "./http"
import { assertTarget, authoritativeWorkspaceId, resolveWorkspaceCommandPaths, resolveWorkspacePath, WorkspaceTargetError } from "../target"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import type { ProcessObserver } from "../managed-processes/process-observer"
import { denyWorkspaceViewers } from "./workspace-role"
import { readHistorySessionId } from "../pty/history-disk"
import { installedWrapperAgents } from "../pty/agent-availability"
import {
  authorizePtyAttach,
  createAuthorizedPtyConnection,
  isPtyStreamSocket,
  ptyAccessRefusalResponse,
  PTY_ROLE_DENIED_MESSAGE,
  type PtyStreamAdmission,
} from "../pty/authorized-connection"
import {
  managedWorkspaceSessionAccessPolicy,
  sessionAccessContext,
  sessionAccessDenied,
  type SessionAccessOperation,
  type SessionAccessPolicy,
} from "../session-access-policy"

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

function requestPort(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.port || (parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : undefined)
  } catch {
    return undefined
  }
}

/** The admission the pre-upgrade handler took, read by the upgrade closure behind it. */
type PtyRouteVariables = RelayHostAuthContext & { ptyStreamAdmission?: PtyStreamAdmission }

export function PtyRoutes(
  upgradeWebSocket: UpgradeWebSocket,
  processObserver?: ProcessObserver,
  policy: SessionAccessPolicy = managedWorkspaceSessionAccessPolicy(),
) {
  const authorize = async (
    c: Context<{ Variables: PtyRouteVariables }>,
    info: Pty.Info,
    operation: Extract<SessionAccessOperation, "pty_read" | "pty_write">,
  ) => {
    const access = sessionAccessContext(c)
    if (!access.authority) return undefined
    if (!info.sessionId) return c.json(notFound(), 404)
    const decision = await policy.authorize({
      ...access,
      operation,
      sessionId: info.sessionId,
      method: c.req.method,
      path: c.req.path,
    })
    if (!decision.allowed) return sessionAccessDenied(decision)
    return undefined
  }

  const attachAccess = (c: Context<{ Variables: PtyRouteVariables }>) => ({
    ...sessionAccessContext(c),
    method: c.req.method,
    path: c.req.path,
  })

  return new Hono<{ Variables: PtyRouteVariables }>()
    .onError((err, c) => {
      if (isRequestBodyTooLarge(err)) return c.json(requestBodyTooLargeBody(), 413)
      throw err
    })
    // Terminal access is sensitive even when the transport method is GET.
    .use("*", denyWorkspaceViewers(PTY_ROLE_DENIED_MESSAGE))
    .get("/", async (c) => {
      const rows = Pty.list()
      const access = sessionAccessContext(c)
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
      const body = await boundedJsonBody(c)
      const parsed = Pty.CreateInput.safeParse(body)
      if (!parsed.success) {
        return c.json(invalidInput(parsed.error.flatten()), 400)
      }
      const access = sessionAccessContext(c)
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
      const workspaceId = authoritativeWorkspaceId()
      const { CLAXEDO_WORKSPACE_ID: _untrustedWorkspaceId, ...environment } = input.env ?? {}
      let cwd: string | undefined
      try {
        const directory = assertTarget(c.req.header("x-claxedo-directory"))
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
        && await readHistorySessionId(cwd, input.env.previousPtyId) !== input.sessionId
      ) {
        return sessionAccessDenied({
          allowed: false,
          status: 403,
          code: "pty_history_forbidden",
          message: "PTY history belongs to another session",
        })
      }
      const port = requestPort(c.req.url)
      const accessContext = sessionAccessContext(c)
      const agentHookAuthority = accessContext.actor && accessContext.authority && input.sessionId
        ? policy.authorizeStream
          ? await policy.authorizeStream({
              ...accessContext,
              operation: "agent_lifecycle_write",
              sessionId: input.sessionId,
              method: c.req.method,
              path: c.req.path,
            })
          : {
              allowed: false as const,
              status: 503 as const,
              code: "terminal_capability_authority_unavailable",
              message: "Managed terminal callback authority is unavailable",
            }
        : undefined
      if (agentHookAuthority && !agentHookAuthority.allowed) return sessionAccessDenied(agentHookAuthority)
      const agentHookAccess = accessContext.actor && accessContext.authority && input.sessionId && agentHookAuthority?.allowed
        ? {
            token: crypto.randomUUID().replaceAll("-", ""),
            context: { actor: accessContext.actor, authority: accessContext.authority },
            sessionId: input.sessionId,
            authorityLease: agentHookAuthority.lease,
            authorityExpiresAt: agentHookAuthority.expiresAt,
          }
        : undefined
      const info = await Pty.create(
        {
          ...input,
          ...(cwd ? { cwd } : {}),
          env: {
            ...environment,
            ...(port ? { CLAXEDO_PORT: port } : {}),
            ...(workspaceId ? { CLAXEDO_WORKSPACE_ID: workspaceId } : {}),
            ...(agentHookAccess ? { CLAXEDO_AGENT_HOOK_TOKEN: agentHookAccess.token } : {}),
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
        agentHookAccess,
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
    // Registered before "/:ptyID" so the literal wins the match.
    .get("/agents", async (c) => {
      return c.json({ installed: await installedWrapperAgents() })
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
      const body = await boundedJsonBody(c)
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
        const admission = await authorizePtyAttach({ policy, access: attachAccess(c), info })
        if (!admission.allowed) return ptyAccessRefusalResponse(admission)
        // The upgrade below is a second closure over the same request; the
        // admission it runs on travels on the context rather than being asked
        // for again.
        c.set("ptyStreamAdmission", admission)
        return next()
      },
      upgradeWebSocket((c) => {
        const admission = c.get("ptyStreamAdmission")
        if (!admission) throw new Error("PTY upgrade requires its verified admission")
        const cursor = (() => {
          const value = c.req.query("cursor")
          if (!value) return undefined
          const parsed = Number(value)
          return Number.isSafeInteger(parsed) && parsed >= -1 ? parsed : undefined
        })()
        const connection = createAuthorizedPtyConnection({
          ptyId: routeParam(c, "ptyID"),
          policy,
          access: attachAccess(c),
          admission,
          ...(cursor === undefined ? {} : { cursor }),
        })
        return {
          onOpen(_event: Event, ws: WSContext) {
            const socket = ws.raw
            if (!isPtyStreamSocket(socket)) {
              ws.close()
              return
            }
            connection.onOpen(socket)
          },
          onMessage(event: { data: unknown }) {
            connection.onMessage(event.data)
          },
          onClose() {
            connection.onClose()
          },
          onError() {
            connection.onClose()
          },
        }
      }),
    )
}
