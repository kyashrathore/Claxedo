import { Hono } from "hono"
import path from "path"
import { defaultHarness, listCommands, loadUserConfig, saveUserConfig } from "@claxedo/server-core/agent-config/index"
import { putCredential, deleteCredentialsByProvider } from "@claxedo/server-core/credentials/registry"
import { fanOutConfig } from "../../agent-config/fanout"
import { syncOpencodeMcpConfig } from "../../opencode/mcp-sync"
import { sandboxFetch } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"
import { listProjects, resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { controlPlaneRouteAuth } from "../../platform/http/control-plane-route-auth"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import { bootPath, queryHarnessId, requestHarnessId, runner, workspaceInput } from "./context"
import { createGlobalEventsHandler, signedGlobalEventVisibleTo } from "./events"
import { allFilesBody, directoryEntriesBody, fileContentBody, fileStatusBody, findFilesBody, findTextBody } from "./file-browser"
import { configBody, configProvidersBody, globalConfigBody, providerAuthBody, providerBody, resolveHarnessId } from "./provider-config"
import { maybeProxy, opencodeCompatDisabled, proxyUpstream, type OpenCodeCompatRouteOptions } from "./proxy"
import { OPENCODE_INTERNAL_BASE, opencodeRequest } from "@claxedo/server-core/opencode/engine"
import { createWorktree, deleteWorktree, listWorktreeDirectories, resetWorktree } from "./worktree-routes"
import { PI_LAUNCH_PROVIDERS } from "@claxedo/server-core/credentials/pi-credentials"
import { controlPlaneAuthContext } from "@claxedo/server-core/platform/auth/auth"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import { eventScopePrincipal } from "@claxedo/server-core/platform/http/event-visibility"
import { sandboxFetchOptionsForRequest } from "../../workspace/sandbox-fetch-options"

function version(options: OpenCodeCompatRouteOptions) {
  return options.env?.npm_package_version || "1.0.0"
}

/** Drop cached engine InstanceState so the next /provider re-reads auth. */
async function disposeOpenCodeInstances() {
  await opencodeRequest(new Request(new URL("/global/dispose", OPENCODE_INTERNAL_BASE), { method: "POST" }))
}

function relayRole(input?: string): "owner" | "admin" | "editor" | "viewer" {
  if (input === "owner" || input === "admin" || input === "editor" || input === "viewer") return input
  return "viewer"
}

function dirProject(id: string, directory: string, created: number, updated: number, sandboxes: string[] = []) {
  return {
    id,
    worktree: directory,
    name: path.basename(directory) || directory,
    time: { created, updated },
    sandboxes,
  }
}

function rec(input: unknown) {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

function syncResultStatus(input: Awaited<ReturnType<typeof syncOpencodeMcpConfig>>) {
  return Object.assign(
    {},
    ...input
      .filter((item) => item.ok)
      .map((item) => rec(item.body) ?? {}),
  ) as Record<string, unknown>
}

/**
 * Gated for the same reason `provider-auth.ts` is, and with more surface: this
 * router reaches `fs.rm(target, {recursive, force})` and `git reset --hard` +
 * `git clean -ffdx` (`/experimental/worktree*`), writes and deletes provider
 * credentials (`PUT|DELETE /auth/:providerID`), rewrites the MCP server list
 * that agents then launch (`PATCH /config`, `PATCH /global/config`) and reads
 * any file the process can read (`GET /file/content`, which resolves absolute
 * `?path=` as-is). `route-ownership.ts` files `/config`, `/provider` and
 * `/auth` in the same AgentConfigRegistry domain as the gated provider-auth
 * routes; this router was the half of that domain still carrying no per-route
 * verification. See `control-plane-route-auth.ts` for why the global
 * `unsignedLocalRequestGuard` does not cover the signed self-host posture.
 *
 * The gate is registered at the router's OWN paths rather than as `.use("*")`.
 * `app.route("/", sub)` re-registers a sub-app's middleware onto the parent
 * router, so a `"*"` middleware here would also run for every parent route
 * mounted after this one — in server.ts that is /documents, /internal/documents,
 * /api/workspace and /api/control, several of which authenticate with an
 * installation or runtime-access token rather than a control-plane bearer and
 * would start failing in signed mode. `auth-gate.test.ts` pins both halves.
 *
 * `/api/claxedo/events` is one of THIS router's own paths (`compatRoutes`
 * below answers it directly, alongside its `/global/event` and `/api/wr/events`
 * aliases), not one of the parent routes above — it never belongs in that
 * after-list. Every composition that mounts this router (`self-hosted-node`,
 * the desktop `local-app`) must let it answer here first rather than also
 * registering its own handler for the same path: Hono resolves the
 * first-registered handler for an exact path, so a later same-path mount is
 * unreachable dead code, not a second implementation.
 */
export function OpenCodeCompatRoutes(options: OpenCodeCompatRouteOptions = {}) {
  const app = new Hono()
  const routes = compatRoutes(options)
  for (const routePath of new Set(routes.routes.map((route) => route.path))) {
    app.use(routePath, controlPlaneRouteAuth(options))
  }
  return app.route("/", routes)
}

function compatRoutes(options: OpenCodeCompatRouteOptions) {
  const streamGlobalEvents = createGlobalEventsHandler(undefined, {
    resolveSubscription: async (c) => {
      const auth = await controlPlaneAuthContext(c.req.raw, {
        ...(options.authConfig ? { config: options.authConfig } : {}),
        ...(options.verifier ? { verifier: options.verifier } : {}),
      })
      if (auth.mode !== "signed") {
        return {
          identity: { mode: "unmanaged-local", connectionId: crypto.randomUUID() },
          visible: () => true,
        }
      }
      const authority = options.services?.authority
      const input = workspaceInput(c)
      if (!authority) {
        const principal = eventScopePrincipal(auth)
        return {
          identity: { mode: "unmanaged-local", connectionId: crypto.randomUUID() },
          visible: (frame) => signedGlobalEventVisibleTo(frame, principal),
        }
      }
      if (!input.workspaceId) {
        const [actor, orgId] = await Promise.all([
          resolveRuntimeActor(authority, auth),
          authority.resolveOrgId(auth),
        ])
        const principal = eventScopePrincipal(auth, String(orgId))
        return {
          identity: {
            mode: "verified",
            connectionId: crypto.randomUUID(),
            actorId: actor.actorId,
            actorKind: actor.actorKind,
            orgId: String(orgId),
            workspaceId: "",
            role: "viewer",
          },
          visible: (frame) => signedGlobalEventVisibleTo(frame, principal),
        }
      }
      const workspaceId = input.workspaceId
      const [actor, workspace] = await Promise.all([
        resolveRuntimeActor(authority, auth),
        authority.openWorkspace(auth, { workspaceId }),
      ])
      const orgId = String(workspace.workspace?.org_id ?? "")
      const principal = eventScopePrincipal(auth, orgId || undefined)
      return {
        identity: {
          mode: "verified",
          connectionId: crypto.randomUUID(),
          actorId: actor.actorId,
          actorKind: actor.actorKind,
          orgId,
          workspaceId,
          role: relayRole(typeof workspace.role === "string" ? workspace.role : undefined),
        },
        visible: (frame) => signedGlobalEventVisibleTo(frame, principal, async (sessionId) => {
          try {
            await authority.authorizeSessionRead(auth, { sessionId, workspaceId })
            return true
          } catch {
            return false
          }
        }),
      }
    },
  })
  return new Hono()
    .get("/global/health", (c) =>
      c.json({
        healthy: true,
        version: version(options),
      }),
    )
    .get("/global/event", (c) => streamGlobalEvents(c))
    .get("/api/wr/events", (c) => streamGlobalEvents(c))
    // The central control-plane bus at its canonical path. The app's events
    // provider opens `controlPlaneEventsUrl` → `/api/claxedo/events` for its
    // central target (matching the hosted deployments, which serve the same
    // path), so the local product must answer here too — without this mount
    // every unsigned desktop build's central stream 404s and retries forever,
    // and the doorbell consumers (document/session lifecycle) never
    // hear anything. Same handler and auth gate as the two aliases above.
    .get("/api/claxedo/events", (c) => streamGlobalEvents(c))
    .get("/path", async (c) => {
      const input = workspaceInput(c)
      const ws = await resolveWorkspace({
        workspaceId: input.workspaceId,
        directory: input.directory,
      })
      return c.json(bootPath(ws?.directory ?? input.directory))
    })
    .get("/find", async (c) => {
      return c.json(await findTextBody(c))
    })
    .get("/find/file", async (c) => {
      return c.json(await findFilesBody(c))
    })
    // Engine parity: the engine's `findSymbol` handler is itself a stub that
    // returns no symbols, so the compat layer answers in kind instead of 404ing.
    .get("/find/symbol", (c) => c.json([]))
    .get("/file", async (c) => {
      return c.json(await directoryEntriesBody(c))
    })
    .get("/file/content", async (c) => {
      return c.json(await fileContentBody(c))
    })
    .get("/file/status", async (c) => {
      return c.json(await fileStatusBody(c))
    })
    .get("/file/all", async (c) => {
      return c.json(await allFilesBody(c))
    })
    .get("/provider", async (c) => {
      const harnessId = requestHarnessId(c)
      try {
        const body = await providerBody(harnessId, options, c.req.query("provider"))
        const status = rec(body)?.ok === false ? 502 : 200
        return c.json(body, status)
      } catch (cause) {
        return c.json(
          errorBody("provider_models_unavailable", cause instanceof Error ? cause.message : String(cause)),
          502,
        )
      }
    })
    .get("/session/status", async (c) => {
      const res = await maybeProxy(c, "/session/status", options)
      if (res) return res
      return c.json({})
    })
    .get("/mcp", async (c) => {
      if (requestHarnessId(c) === "opencode" && !opencodeCompatDisabled(options)) {
        const res = await proxyUpstream(c, "/mcp", options)
        if (!res.ok) return res
        const text = await res.text()
        const current = text.trim() ? JSON.parse(text) as unknown : {}
        const synced = syncResultStatus(await syncOpencodeMcpConfig())
        return c.json({ ...rec(current), ...synced })
      }
      return c.json({})
    })
    .get("/question", async (c) => {
      const res = await maybeProxy(c, "/question", options)
      if (res) return res
      return c.json([])
    })
    .post("/mcp/:name/connect", async (c) => {
      const res = await maybeProxy(c, `/mcp/${encodeURIComponent(c.req.param("name"))}/connect`, options)
      if (res) return res
      return c.json(true)
    })
    .post("/mcp/:name/disconnect", async (c) => {
      const res = await maybeProxy(c, `/mcp/${encodeURIComponent(c.req.param("name"))}/disconnect`, options)
      if (res) return res
      return c.json(true)
    })
    .get("/lsp", async (c) => {
      const res = await maybeProxy(c, "/lsp", options)
      if (res) return res
      return c.json([])
    })
    .get("/vcs", async (c) => {
      const res = await maybeProxy(c, "/vcs", options)
      if (res) return res
      return c.json({})
    })
    .get("/provider/auth", async (c) => {
      try {
        return c.json(await providerAuthBody(queryHarnessId(c)))
      } catch (cause) {
        return c.json(
          errorBody("provider_auth_unavailable", cause instanceof Error ? cause.message : String(cause)),
          502,
        )
      }
    })
    .post("/provider/:providerID/oauth/:step", async (c) => {
      const harnessId = await resolveHarnessId(requestHarnessId(c))
      if (harnessId !== "opencode") {
        return c.json(errorBody("opencode_oauth_unsupported", "oauth unsupported for ACP runners"), 404)
      }
      return proxyUpstream(c, `/provider/${encodeURIComponent(c.req.param("providerID"))}/oauth/${encodeURIComponent(c.req.param("step"))}`, options)
    })
    .get("/config/providers", async (c) => {
      try {
        return c.json(await configProvidersBody(queryHarnessId(c), options))
      } catch (cause) {
        return c.json(
          errorBody("provider_models_unavailable", cause instanceof Error ? cause.message : String(cause)),
          502,
        )
      }
    })
    .put("/auth/:providerID", async (c) => {
      const id = c.req.param("providerID")
      const harnessId = await resolveHarnessId(requestHarnessId(c))
      if (harnessId === "pi" && !PI_LAUNCH_PROVIDERS.includes(id as (typeof PI_LAUNCH_PROVIDERS)[number])) {
        return c.json(errorBody("pi_provider_unsupported", `${id} is not a supported Pi provider`), 400)
      }
      if (harnessId === "pi" && id === "openai-codex") {
        return c.json(errorBody("pi_codex_sync_required", "Connect Codex through the credential sync flow"), 400)
      }
      const body = await c.req.json<{ auth?: { key?: string } }>().catch(() => null)
      const key = body?.auth?.key
      if (!key) return c.json(errorBody("opencode_auth_key_required", "auth.key is required"), 400)
      const user = await loadUserConfig()
      const runner = defaultHarness(user)
      if (harnessId === "opencode" && runner.id === "opencode" && !id.endsWith("-acp")) return proxyUpstream(c, `/auth/${encodeURIComponent(id)}`, options)
      // Store through the credential registry instead of plaintext config
      try {
        await putCredential({
          provider_id: id,
          kind: "api_key",
          source: "managed",
          label: `API key for ${id}`,
          secret: key,
        })
      } catch (cause) {
        if (harnessId === "pi") {
          return c.json(errorBody("pi_credential_store_unavailable", cause instanceof Error ? cause.message : String(cause)), 503)
        }
        // Fallback to legacy config if backend is unavailable
        user.auth = { ...user.auth, [id]: key }
        await saveUserConfig(user)
      }
      await fanOutConfig().catch(() => {})
      return c.json({})
    })
    .delete("/auth/:providerID", async (c) => {
      const id = c.req.param("providerID")
      const harnessId = await resolveHarnessId(requestHarnessId(c))
      if (harnessId === "pi" && !PI_LAUNCH_PROVIDERS.includes(id as (typeof PI_LAUNCH_PROVIDERS)[number])) {
        return c.json(errorBody("pi_provider_unsupported", `${id} is not a supported Pi provider`), 400)
      }
      const user = await loadUserConfig()
      const runner = defaultHarness(user)
      if (harnessId === "opencode" && runner.id === "opencode" && !id.endsWith("-acp")) {
        // Auth lives in the engine file; the provider catalog is cached in
        // InstanceState until dispose. Remove then dispose so the next
        // `/provider` read does not keep the disconnected provider connected.
        const removed = await proxyUpstream(c, `/auth/${encodeURIComponent(id)}`, options)
        await disposeOpenCodeInstances().catch(() => undefined)
        return removed
      }
      // Delete from credential registry
      await deleteCredentialsByProvider(id).catch(() => {})
      // Also clean up legacy config if present
      if (user.auth?.[id]) {
        user.auth = { ...user.auth }
        delete user.auth[id]
        await saveUserConfig(user)
      }
      await fanOutConfig().catch(() => {})
      return c.json(true)
    })
    // Must reach the embedded engine — a boolean stub left provider auth
    // cached after Disconnect, so the UI stayed "connected" across refresh.
    .post("/global/dispose", async (c) => {
      const user = await loadUserConfig()
      if (defaultHarness(user).id === "opencode") return proxyUpstream(c, "/global/dispose", options)
      return c.json(true)
    })
    .get("/config", async (c) => {
      const user = await loadUserConfig()
      if (defaultHarness(user).id === "opencode") {
        try {
          return c.json(await globalConfigBody(queryHarnessId(c), options))
        } catch (cause) {
          return c.json(
            errorBody("global_config_unavailable", cause instanceof Error ? cause.message : String(cause)),
            502,
          )
        }
      }
      return c.json(configBody(user))
    })
    .patch("/config", async (c) => {
      const user = await loadUserConfig()
      if (defaultHarness(user).id === "opencode") return proxyUpstream(c, "/config", options)
      const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
      if (body) {
        await saveUserConfig({
          ...user,
          mcp: (body.mcp ?? user.mcp) as typeof user.mcp,
        })
        await fanOutConfig().catch(() => {})
      }
      return c.json(configBody(await loadUserConfig()))
    })
    .get("/global/config", async (c) => {
      const user = await loadUserConfig()
      if (defaultHarness(user).id === "opencode") {
        try {
          return c.json(await globalConfigBody(queryHarnessId(c), options))
        } catch (cause) {
          return c.json(
            errorBody("global_config_unavailable", cause instanceof Error ? cause.message : String(cause)),
            502,
          )
        }
      }
      return c.json(configBody(user))
    })
    .patch("/global/config", async (c) => {
      const user = await loadUserConfig()
      if (defaultHarness(user).id === "opencode") {
        const res = await proxyUpstream(c, "/global/config", options)
        // Config changes (e.g. disabled_providers) stay cached in InstanceState
        // until dispose — same as DELETE /auth.
        await disposeOpenCodeInstances().catch(() => undefined)
        return res
      }
      const body = await c.req.json().catch(() => null) as { config?: Record<string, unknown> } | null
      if (body?.config) {
        await saveUserConfig({
          ...user,
          mcp: (body.config.mcp ?? user.mcp) as typeof user.mcp,
        })
        await fanOutConfig().catch(() => {})
      }
      return c.json(configBody(await loadUserConfig()))
    })
    .get("/agent", async (c) => {
      const user = await loadUserConfig()
      const explicitHarness = requestHarnessId(c)
      const hit = runner(c, explicitHarness ? defaultHarness(user) : { id: "claude", access: "acp" })
      if (explicitHarness && hit.id === "opencode") {
        const res = await proxyUpstream(c, "/agent", options)
        return res
      }
      const input = workspaceInput(c)
      const ws = await resolveWorkspace({
        workspaceId: input.workspaceId,
        directory: input.directory,
        create: !!input.directory,
      }).catch(() => undefined)
      if (ws) {
        try {
          const res = await sandboxFetch(ws, "/agent", {
            headers: {
              "x-workspace-id": ws.id,
              "x-opencode-directory": ws.remote_directory || ws.directory,
            },
            signal: AbortSignal.timeout(2_000),
          }, await sandboxFetchOptionsForRequest(c.req.raw, ws.id, options))
          if (res.ok) return c.json(await res.json())
        } catch { /* fallback below */ }
      }
      // Fallback when no workspace runtime is available yet
      return c.json([
        { name: "build", description: "Default agent", mode: "primary" },
      ])
    })
    .get("/command", async (c) => {
      try {
        return c.json(await listCommands())
      } catch {
        return c.json([])
      }
    })
    .get("/project", async (c) => {
      const all = await listProjects()
      return c.json(all)
    })
    .get("/project/current", async (c) => {
      const input = workspaceInput(c)
      const ws = await resolveWorkspace({
        workspaceId: input.workspaceId,
        directory: input.directory,
        create: !!input.directory,
      })
      const current = ws ?? {
        id: input.workspaceId || input.directory || process.cwd(),
        directory: input.directory || process.cwd(),
        kind: "local" as const,
        created_at: Date.now(),
        updated_at: Date.now(),
      }
      const project_id = "project_id" in current ? current.project_id ?? current.id : current.id
      const all = await listProjects()
      const hit = all.find((item) => item.id === project_id)
      return c.json(hit ?? dirProject(current.id, current.directory, current.created_at, current.updated_at))
    })
    .patch("/project/:id", (c) => c.json({ ok: true }))
    .post("/experimental/worktree", async (c) => {
      return createWorktree(c)
    })
    .get("/experimental/worktree", async (c) => {
      return listWorktreeDirectories(c)
    })
    .delete("/experimental/worktree", async (c) => {
      return deleteWorktree(c)
    })
    .post("/experimental/worktree/reset", async (c) => {
      return resetWorktree(c)
    })
}
