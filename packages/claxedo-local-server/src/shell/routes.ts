import type { UpgradeWebSocket } from "./event-stream-response"
import { Hono } from "hono"
import { randomUUID } from "node:crypto"
import { listCommands } from "@claxedo/server-core/agent-config/index"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { sandboxFetch } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"
import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"
import {
  controlPlaneAuthContext,
  type ControlPlaneTokenVerifier,
  type ControlPlaneAuthConfig,
} from "@claxedo/server-core/platform/auth/auth"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import { eventScopePrincipal } from "@claxedo/server-core/platform/http/event-visibility"
import { controlPlaneRouteAuth, signedRouteAuth } from "../platform/http/control-plane-route-auth"
import { roleAtLeast, type WorkspaceRole } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import type { MiddlewareHandler } from "hono"
import { createControlPlaneEventsHandler, signedControlPlaneEventVisibleTo } from "./events"
import { allFilesBody, directoryEntriesBody, fileContentBody, fileStatusBody, findFilesBody, findTextBody } from "./file-browser"
import { bootPath, workspaceInput } from "./request-context"
import { createWorktree, deleteWorktree, listWorktreeDirectories, resetWorktree } from "./worktree-routes"
import { sandboxFetchOptionsForRequest } from "../workspace/sandbox-fetch-options"
import { projectRoutes } from "./project-routes"

export type ShellRouteOptions = {
  upgradeWebSocket?: UpgradeWebSocket
  env?: NodeJS.ProcessEnv
  authConfig?: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
  services?: ControlPlaneServicesContract
}

export function ShellRoutes(options: ShellRouteOptions = {}) {
  const app = new Hono()
  const routes = shellRoutes(options)
  for (const routePath of new Set(routes.routes.map((route) => route.path))) {
    app.use(routePath, controlPlaneRouteAuth(options))
    if (WORKSPACE_SCOPED_PATHS.has(routePath)) app.use(routePath, shellWorkspaceGate(options))
  }
  return app.route("/", routes)
}

/**
 * Workspace-scoped shell paths. `/global/health`, `/api/cp/events` (which
 * resolves its own per-principal subscription), `/command`, and the
 * `/project*` family (which authorizes per-project) are deliberately absent.
 */
const WORKSPACE_SCOPED_PATHS = new Set([
  "/path",
  "/find",
  "/find/file",
  "/file",
  "/file/content",
  "/file/status",
  "/file/all",
  "/agent",
  "/experimental/worktree",
  "/experimental/worktree/reset",
])

/**
 * The authorization half `controlPlaneRouteAuth` cannot supply: a verified
 * signature proves WHO the caller is, not WHICH workspace they may touch.
 * In signed mode every workspace-scoped path must resolve to a registered
 * workspace the caller can open — a bare `?directory=` is never the read
 * root — and worktree mutations (which delete files or run `startCommand`
 * through `bash -lc`) require admin.
 *
 * Unsigned-local requests pass untouched: there is no caller identity to
 * check against and the loopback guard is the gate.
 */
function shellWorkspaceGate(options: ShellRouteOptions): MiddlewareHandler {
  return async (c, next) => {
    const auth = signedRouteAuth(c.req.raw)
    if (!auth) {
      await next()
      return undefined
    }
    const input = workspaceInput(c)
    const ws = await resolveWorkspace({
      workspaceId: input.workspaceId,
      directory: input.directory,
    }).catch(() => undefined)
    const opened = ws && options.services?.authority
      ? await options.services.authority.openWorkspace(auth, { workspaceId: ws.id }).catch(() => undefined)
      : undefined
    if (!opened?.allowed || typeof opened.role !== "string") {
      return c.json({ error: { code: "workspace_forbidden", message: "Workspace access denied" } }, 403)
    }
    const method = c.req.method.toUpperCase()
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && !roleAtLeast(opened.role as WorkspaceRole, "admin")) {
      return c.json({ error: { code: "workspace_forbidden", message: "Workspace mutations require an admin role" } }, 403)
    }
    await next()
    return undefined
  }
}

function shellRoutes(options: ShellRouteOptions) {
  const stream = createControlPlaneEventsHandler(undefined, {
    upgradeWebSocket: options.upgradeWebSocket,
    resolveSubscription: async (c) => {
      const auth = await controlPlaneAuthContext(c.req.raw, {
        ...(options.authConfig ? { config: options.authConfig } : {}),
        ...(options.verifier ? { verifier: options.verifier } : {}),
      })
      if (auth.mode !== "signed") {
        return {
          identity: { mode: "unmanaged-local" as const, connectionId: randomUUID() },
          visible: () => true,
        }
      }

      const authority = options.services?.authority
      const input = workspaceInput(c)
      if (!authority) {
        // A signed subscriber must never share the daemon's own ring: the
        // handler keys its per-principal replay on the identity, and a shared
        // ring replays every tenant's notices.
        const principal = eventScopePrincipal(auth)
        return {
          identity: {
            mode: "verified" as const,
            connectionId: randomUUID(),
            actorId: auth.user.subject,
            actorKind: "human" as const,
            orgId: auth.user.orgId ?? "",
            workspaceId: "",
            role: "viewer",
          },
          visible: (frame: Parameters<typeof signedControlPlaneEventVisibleTo>[0]) =>
            signedControlPlaneEventVisibleTo(frame, principal),
        }
      }

      if (!input.workspaceId) {
        const [actor, orgId] = await Promise.all([
          resolveRuntimeActor(authority, auth),
          authority.resolveOrgId(auth),
        ])
        const internalOrgId = String(orgId)
        const principal = eventScopePrincipal(auth, internalOrgId)
        return {
          identity: {
            mode: "verified" as const,
            connectionId: randomUUID(),
            actorId: actor.actorId,
            actorKind: actor.actorKind,
            orgId: internalOrgId,
            workspaceId: "",
            role: "viewer",
          },
          visible: (frame: Parameters<typeof signedControlPlaneEventVisibleTo>[0]) =>
            signedControlPlaneEventVisibleTo(frame, principal),
        }
      }

      const workspaceId = input.workspaceId
      const [actor, workspace] = await Promise.all([
        resolveRuntimeActor(authority, auth),
        authority.openWorkspace(auth, { workspaceId }),
      ])
      const orgId = workspace.workspace?.org_id ?? ""
      const principal = eventScopePrincipal(auth, orgId || undefined)
      return {
        identity: {
          mode: "verified" as const,
          connectionId: randomUUID(),
          actorId: actor.actorId,
          actorKind: actor.actorKind,
          orgId,
          workspaceId,
          role: relayRole(typeof workspace.role === "string" ? workspace.role : undefined),
        },
        visible: (frame: Parameters<typeof signedControlPlaneEventVisibleTo>[0]) =>
          signedControlPlaneEventVisibleTo(frame, principal),
      }
    },
  })
  return new Hono()
    .get("/global/health", (c) => c.json({ healthy: true, version: options.env?.npm_package_version || "1.0.0" }))
    .get("/api/cp/events", (c) => stream(c))
    .get("/path", async (c) => {
      const input = workspaceInput(c)
      const ws = await resolveWorkspace({ workspaceId: input.workspaceId, directory: input.directory })
      return c.json(bootPath(ws?.directory ?? input.directory))
    })
    .get("/find", async (c) => c.json(await findTextBody(c)))
    .get("/find/file", async (c) => c.json(await findFilesBody(c)))
    .get("/file", async (c) => c.json(await directoryEntriesBody(c)))
    .get("/file/content", async (c) => c.json(await fileContentBody(c)))
    .get("/file/status", async (c) => c.json(await fileStatusBody(c)))
    .get("/file/all", async (c) => c.json(await allFilesBody(c)))
    .get("/agent", async (c) => {
      const input = workspaceInput(c)
      const ws = await resolveWorkspace({
        workspaceId: input.workspaceId,
        directory: input.directory,
        create: !!input.directory,
      })
      if (!ws) return c.json({ error: { code: "workspace_required", message: "Workspace is required" } }, 400)
      const url = new URL("/agent", "http://workspace-runtime.local")
      url.searchParams.set("directory", ws.kind === "cloud" ? ws.remote_directory || "/workspace" : ws.directory)
      const response = await sandboxFetch(
        ws,
        `${url.pathname}${url.search}`,
        undefined,
        await sandboxFetchOptionsForRequest(c.req.raw, ws.id, options),
      )
      return new Response(response.body, { status: response.status, headers: response.headers })
    })
    .get("/command", async (c) => c.json(await listCommands()))
    .route("/", projectRoutes(options))
    .post("/experimental/worktree", createWorktree)
    .get("/experimental/worktree", listWorktreeDirectories)
    .delete("/experimental/worktree", deleteWorktree)
    .post("/experimental/worktree/reset", resetWorktree)
}

function relayRole(input?: string): "owner" | "admin" | "editor" | "viewer" {
  if (input === "owner" || input === "admin" || input === "editor" || input === "viewer") return input
  return "viewer"
}
