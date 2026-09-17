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
import { controlPlaneRouteAuth } from "../platform/http/control-plane-route-auth"
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
  }
  return app.route("/", routes)
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
        const principal = eventScopePrincipal(auth)
        return {
          identity: { mode: "unmanaged-local" as const, connectionId: randomUUID() },
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
