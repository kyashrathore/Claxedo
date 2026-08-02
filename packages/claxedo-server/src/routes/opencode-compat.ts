import { Hono } from "hono"
import path from "path"
import { defaultHarness, listCommands, loadUserConfig, saveUserConfig } from "../agent-config"
import { putCredential, deleteCredentialsByProvider } from "../credentials/registry"
import { fanOutConfig } from "../config-fanout"
import { syncOpencodeMcpConfig } from "../opencode/mcp-sync"
import { sandboxFetch } from "../sandbox-target-fetch"
import { listProjects, resolveWorkspace } from "../workspace/store/store"
import { controlPlaneRouteAuth } from "./control-plane-route-auth"
import { errorBody } from "./http"
import { bootPath, queryHarnessId, requestHarnessId, runner, workspaceInput } from "./opencode-compat-context"
import { streamGlobalEvents } from "./opencode-compat-events"
import { allFilesBody, directoryEntriesBody, fileContentBody, fileStatusBody, findFilesBody, findTextBody } from "./opencode-compat-file-browser"
import { configBody, configProvidersBody, globalConfigBody, providerAuthBody, providerBody, resolveHarnessId } from "./opencode-compat-provider-config"
import { maybeProxy, opencodeCompatDisabled, proxyUpstream, type OpenCodeCompatRouteOptions } from "./opencode-compat-proxy"
import { createWorktree, deleteWorktree, listWorktreeDirectories, resetWorktree } from "./opencode-compat-worktree-routes"
import { PI_LAUNCH_PROVIDERS } from "../pi-credentials"

// Back-compat: local callers/tests configure the compat transport by URL; this
// maps onto the engine transport as an explicit external-URL opt-in.
export { configureOpenCodeCompat } from "../opencode/engine"

function version(options: OpenCodeCompatRouteOptions) {
  return options.env?.npm_package_version || "1.0.0"
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
 * /api/workspace, /api/control and /api/claxedo/events, several of which
 * authenticate with an installation or runtime-access token rather than a
 * control-plane bearer and would start failing in signed mode.
 * `opencode-compat-auth-gate.test.ts` pins both halves.
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
  return new Hono()
    .get("/global/health", (c) =>
      c.json({
        healthy: true,
        version: version(options),
      }),
    )
    .get("/global/event", (c) => streamGlobalEvents(c))
    .get("/api/wr/events", (c) => streamGlobalEvents(c))
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
        const body = await providerBody(harnessId, options)
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
      return c.json(await providerAuthBody(queryHarnessId(c)))
    })
    .post("/provider/:providerID/oauth/:step", async (c) => {
      const harnessId = await resolveHarnessId(requestHarnessId(c))
      if (harnessId !== "opencode") {
        return c.json(errorBody("opencode_oauth_unsupported", "oauth unsupported for ACP runners"), 404)
      }
      return proxyUpstream(c, `/provider/${encodeURIComponent(c.req.param("providerID"))}/oauth/${encodeURIComponent(c.req.param("step"))}`, options)
    })
    .get("/config/providers", async (c) => {
      return c.json(await configProvidersBody(queryHarnessId(c), options))
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
      if (harnessId === "opencode" && runner.id === "opencode" && !id.endsWith("-acp")) return proxyUpstream(c, `/auth/${encodeURIComponent(id)}`, options)
      // Delete from credential registry
      await deleteCredentialsByProvider(id).catch(() => {})
      // Also clean up legacy config if present
      if (user.auth?.[id]) {
        user.auth = { ...user.auth }
        delete user.auth[id]
        await saveUserConfig(user)
      }
      await fanOutConfig().catch(() => {})
      return c.json({})
    })
    .post("/global/dispose", (c) => c.json(true))
    .get("/config", async (c) => {
      const user = await loadUserConfig()
      if (defaultHarness(user).id === "opencode") return c.json(await globalConfigBody(queryHarnessId(c), options))
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
      if (defaultHarness(user).id === "opencode") return c.json(await globalConfigBody(queryHarnessId(c), options))
      return c.json(configBody(user))
    })
    .patch("/global/config", async (c) => {
      const user = await loadUserConfig()
      if (defaultHarness(user).id === "opencode") return proxyUpstream(c, "/global/config", options)
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
          }, {
            ...(options.services?.sandbox.sandboxManager
              ? { sandboxManager: options.services.sandbox.sandboxManager }
              : {}),
            ...(options.services?.relay.provider ? { relayProvider: options.services.relay.provider } : {}),
            ...(options.services?.defaultHomeRegion ? { defaultHomeRegion: options.services.defaultHomeRegion } : {}),
          })
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
