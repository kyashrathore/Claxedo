/**
 * Hosted shell-boot routes — the minimal GLOBAL boot surface the Claxedo app
 * shell needs from a hosted central (Cloudflare Worker) deployment.
 *
 * The app shell boots against a set of "global" routes that the local Node
 * server answers from disk/opencode (`server.ts` + `routes/opencode-compat.ts`
 * + `routes/bootstrap.ts`). A hosted central has no local filesystem, no
 * embedded runtime, and no central runner, so these routes answer with the
 * minimal synthetic payloads the app actually reads:
 *
 *   GET /api/claxedo/events     — auth-gated hosted live-sync SSE stream
 *   GET /api/claxedo/bootstrap  — aggregate boot payload (signed → Convex workspaces)
 *   GET /global/health          — { healthy, version }
 *   GET /global/config          — {}
 *   GET /project                — signed → Convex workspace projects, else []
 *   GET /project/current        — synthetic project derived from ?directory
 *   GET /path                   — synthetic path derived from ?directory
 *   GET /provider               — empty-but-valid provider catalog
 *   GET /provider/auth          — {}
 *
 * Provider catalogs for signed workspaces come from the workspace RUNTIME via
 * the relay (`/workspaces/:id/provider`), not from here — the central catalog
 * is intentionally empty so the UI degrades gracefully instead of toasting.
 */

import { Hono } from "hono"
import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { loadAgentExtensionsCatalog } from "../agent-extensions/catalog"
import {
  ControlPlaneAuthError,
  bearerToken,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
  type ControlPlaneAuthContext,
  type SignedControlPlaneAuth,
} from "../control-plane/auth"
import { connectLiveSyncRoom, type LiveSyncRoomNamespace } from "../live-sync-room"

export type HostedShellRouteOptions = {
  authConfig: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  /** Reported by /global/health and the bootstrap aggregate. */
  version?: string
  /** Signed project inventory source (Convex workspaces.list). */
  listWorkspaces?: (auth: SignedControlPlaneAuth) => Promise<unknown>
  /** Heartbeat cadence for the events stream (tests shrink this). */
  heartbeatMs?: number
  /**
   * W5.2: per-owner live-sync fan-out Durable Object namespace (Cloudflare
   * Worker only). The public SSE route is bridged to a hibernatable socket held
   * by the caller's LiveSyncRoom. Absent → heartbeat fallback.
   */
  liveSyncRoom?: LiveSyncRoomNamespace
  /**
   * Resolves the caller's AUTHORITY-INTERNAL org id (`authority.resolveOrgId`)
   * at connect time. Room names and the per-connection event visibility filter
   * live in this namespace — the SAME one document/provision events and
   * WorkGraph runtime-token claims are stamped with — never the Clerk org
   * claim. Absent → signed subscribers hold the subject-keyed owner room,
   * where org-scoped events stay invisible fail-closed.
   */
  resolveOrgId?: (auth: SignedControlPlaneAuth) => Promise<string>
  piProviderCatalog?: (auth: SignedControlPlaneAuth) => Promise<unknown>
  putPiCredential?: (auth: SignedControlPlaneAuth, providerID: string, key: string) => Promise<void>
  deletePiCredential?: (auth: SignedControlPlaneAuth, providerID: string) => Promise<void>
  /** Idempotent owner setup scheduled only from signed bootstrap on Worker waitUntil. */
  activateOwner?: (auth: SignedControlPlaneAuth) => Promise<void>
}

function rec(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function txt(input: unknown) {
  return typeof input === "string" ? input : undefined
}

function version(options: HostedShellRouteOptions) {
  return options.version || "1.0.0"
}

// Shape mirror of `bootPath()` in routes/opencode-compat.ts — the hosted
// central has no home/state/config directories, so those stay empty (the app
// synthesizes the same shape for remote workspaces in `pathFromWorkspace`).
function hostedPath(directory?: string) {
  const dir = directory?.trim() ?? ""
  return {
    home: "",
    state: "",
    config: "",
    worktree: dir,
    directory: dir,
  }
}

// Shape mirror of `dirProject()` in routes/opencode-compat.ts. The app's
// `projectCurrentQuery` only reads `.id`.
function hostedProject(directory: string) {
  const id = directory || "hosted"
  const name = directory.split(/[\\/]/).filter(Boolean).pop() ?? directory
  const now = Date.now()
  return {
    id,
    worktree: directory,
    name: name || id,
    time: { created: now, updated: now },
    sandboxes: [] as string[],
  }
}

// Empty-but-valid catalog — passes the app's `isProviderListResponse` guard
// (`all` array + `connected` array + `default` record) so boot degrades
// gracefully instead of raising the "Failed to load models" toast.
function emptyProvider() {
  return {
    all: [],
    default: {},
    connected: [],
  }
}

function emptyConfigProviders() {
  return {
    providers: [],
    default: {},
  }
}

// Shape mirror of `extensionListBody()` in routes/agent-config-extension-
// support.ts with zero installs (that module is local-only: it imports os and
// fs-backed install/state modules, so it cannot enter the Worker bundle). The
// app's `installedRecordsFromJson` only accepts this object shape — a bare
// array parses to nothing, so every marketplace card would render as
// not-installed and Install would re-run on already-installed entries.
function emptyExtensionList() {
  return {
    desired: { version: 1, installs: [] },
    materialized: { version: 1, packages: {} },
    effective: {},
  }
}

function piProviderAuth() {
  return {
    anthropic: [{ type: "api", label: "API Key" }],
    openai: [{ type: "api", label: "API Key" }],
  }
}

// Copied from routes/bootstrap.ts `signedBootstrapProjects` (that module is
// local-only: it imports fs-backed agent-config/workspace-store and cannot
// enter the Worker bundle). Keep the two in sync — this is what teaches the
// app shell which directories are signed cloud/user-hosted workspaces, which
// in turn routes runtime-owned reads (provider, files, PTY) through the relay.
function num(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function signedShellProjects(workspaces: unknown[], now: number) {
  const groups = new Map<string, {
    id: string
    name: string
    directories: string[]
    workspaces: Record<string, unknown>
    created: number
    updated: number
  }>()
  for (const workspace of workspaces) {
    const row = rec(workspace)
    const workspaceId = txt(row?.workspace_id) ?? txt(row?.workspaceId)
    if (!workspaceId) continue
    const directory = txt(row?.remote_directory) ?? txt(row?.remoteDirectory) ?? "/workspace"
    const projectId = txt(row?.project_id) ?? txt(row?.projectID) ?? workspaceId
    const workspaceName = txt(row?.workspace_name) ?? txt(row?.workspaceName) ?? txt(row?.display_name) ?? txt(row?.displayName) ?? workspaceId
    const created = num(row?.created_at) ?? num(row?.createdAt) ?? now
    const updated = num(row?.updated_at) ?? num(row?.updatedAt) ?? num(row?.last_seen_at) ?? created
    const group = groups.get(projectId) ?? {
      id: projectId,
      name: txt(row?.project_name) ?? txt(row?.projectName) ?? txt(row?.display_name) ?? txt(row?.displayName) ?? projectId,
      directories: [],
      workspaces: {},
      created,
      updated,
    }
    group.created = Math.min(group.created, created)
    group.updated = Math.max(group.updated, updated)
    group.directories.push(workspaceId)
    group.workspaces[workspaceId] = {
      id: workspaceId,
      kind: txt(row?.access) ?? txt(row?.backing) ?? "cloud",
      workspace_name: workspaceName,
      directory,
    }
    groups.set(projectId, group)
  }
  return [...groups.values()].map((group) => ({
    id: group.id,
    name: group.name,
    worktree: group.directories[0] ?? group.id,
    // The app shell's home page sorts recent projects by `time.updated`; a
    // missing `time` crashes the whole app, so always provide it.
    time: { created: group.created, updated: group.updated },
    sandboxes: group.directories,
    workspaces: group.workspaces,
  }))
}

function directoryInput(c: Context) {
  return c.req.query("directory") ?? c.req.query("workspaceId") ?? c.req.header("x-opencode-directory") ?? ""
}

async function signedAuth(c: Context, options: HostedShellRouteOptions) {
  const context = await controlPlaneAuthContext(c.req.raw, {
    config: options.authConfig,
    ...(options.verifier ? { verifier: options.verifier } : {}),
  })
  return context.mode === "signed" ? context : undefined
}

function guardedWaitUntil(c: Context) {
  try {
    const execution = c.executionCtx
    if (typeof execution?.waitUntil !== "function") return
    return (promise: Promise<unknown>) => execution.waitUntil(promise)
  } catch {
    return
  }
}

async function signedProjects(c: Context, options: HostedShellRouteOptions, activateOwner = false) {
  if (!bearerToken(c.req.header("authorization") ?? null)) return []
  const auth = await signedAuth(c, options)
  if (!auth) return []
  if (activateOwner && options.activateOwner) {
    guardedWaitUntil(c)?.(options.activateOwner(auth))
  }
  if (!options.listWorkspaces) return []
  const workspaces = await options.listWorkspaces(auth)
  return signedShellProjects(Array.isArray(workspaces) ? workspaces : [], Date.now())
}

function authErrorResponse(c: Context, err: unknown) {
  if (err instanceof ControlPlaneAuthError) {
    return c.json(controlPlaneAuthErrorBody(err), err.status as ContentfulStatusCode)
  }
  throw err
}

const HEARTBEAT_MS = 30_000

// The app's event bus (`providers/claxedo-events.tsx`) reads this stream with
// fetch+ReadableStream and arms a 45s watchdog that is only reset by `data:`
// lines — SSE comments do NOT reset it. So keepalives must be data heartbeats
// in the local bus envelope (`{"type":"heartbeat"}`), matching
// `routes/events.ts`. This fallback carries heartbeats only; hosted Worker
// composition supplies `LiveSyncRoom` for mutation nudges.
function eventsStream(c: Context, heartbeatMs: number) {
  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const write = (data: unknown) => {
        try {
          ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {
          stop()
        }
      }
      // Initial hello so proxies flush headers and the bus goes live at once.
      write({ type: "heartbeat" })
      timer = setInterval(() => write({ type: "heartbeat" }), heartbeatMs)
    },
    cancel() {
      stop()
    },
  })
  c.req.raw.signal.addEventListener("abort", stop)
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}

export function HostedShellRoutes(options: HostedShellRouteOptions) {
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
  const events = async (c: Context) => {
    try {
      // Every live-sync subscriber passes control-plane auth. There is no
      // loopback bypass on a hosted central. Keep the resolved context so the
      // room routes by owner and applies the same per-event `eventVisibleTo`
      // scoping the local Node bus does.
      const authorize = () => controlPlaneAuthContext(c.req.raw, {
        config: options.authConfig,
        ...(options.verifier ? { verifier: options.verifier } : {}),
      })
      const ctx = await authorize()
      if (options.liveSyncRoom) {
        // Resolve the internal org id ONCE per connect (not per heartbeat or
        // event) so the subscriber's room and visibility identity share the
        // namespace publishers stamp. A resolution failure fails the connect
        // (the client's reconnect loop retries); silently degrading to the
        // owner room would strand this caller's org events until reconnect.
        const orgId = ctx.mode === "signed" && options.resolveOrgId
          ? await options.resolveOrgId(ctx)
          : undefined
        return await connectLiveSyncRoom(
          options.liveSyncRoom,
          { auth: ctx, ...(orgId ? { orgId } : {}) },
          heartbeatMs,
          authorize,
        )
      }
      return eventsStream(c, heartbeatMs)
    } catch (err) {
      return authErrorResponse(c, err)
    }
  }
  return new Hono()
    // Rubric S1 (mirrors routes/events.ts): every bus subscriber passes the
    // same control-plane auth gate as the other claxedo routes. There is no
    // loopback bypass on a hosted central.
    .get("/api/claxedo/events", events)
    .get("/api/wr/events", events)
    .get("/global/event", events)
    .get("/api/claxedo/bootstrap", async (c) => {
      try {
        const provider = emptyProvider()
        return c.json({
          healthy: true,
          version: version(options),
          path: hostedPath(),
          project: await signedProjects(c, options, true),
          provider,
          provider_auth: {},
          config: {},
          config_providers: emptyConfigProviders(),
        })
      } catch (err) {
        return authErrorResponse(c, err)
      }
    })
    .get("/global/health", (c) =>
      c.json({
        healthy: true,
        version: version(options),
      }))
    .get("/global/config", (c) => c.json({}))
    .get("/project", async (c) => {
      try {
        return c.json(await signedProjects(c, options))
      } catch (err) {
        return authErrorResponse(c, err)
      }
    })
    .get("/project/current", (c) => c.json(hostedProject(directoryInput(c))))
    .get("/path", (c) => c.json(hostedPath(directoryInput(c))))
    .get("/provider", async (c) => {
      if (c.req.query("harness") !== "pi") return c.json(emptyProvider())
      if (!options.piProviderCatalog) return c.json(emptyProvider())
      try {
        const auth = await signedAuth(c, options)
        if (!auth) throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
        return c.json(await options.piProviderCatalog(auth) as never)
      } catch (err) {
        return authErrorResponse(c, err)
      }
    })
    .get("/provider/auth", (c) => c.json(c.req.query("harness") === "pi" ? piProviderAuth() : {}))
    .put("/auth/:providerID", async (c) => {
      if (c.req.query("harness") !== "pi" || !options.putPiCredential) return c.json({ error: { code: "pi_credentials_unavailable", message: "Pi credential storage is unavailable" } }, 503)
      try {
        const auth = await signedAuth(c, options)
        if (!auth) throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
        const body = await c.req.json().catch(() => undefined) as { auth?: { key?: string } } | undefined
        if (!body?.auth?.key) return c.json({ error: { code: "pi_auth_key_required", message: "auth.key is required" } }, 400)
        await options.putPiCredential(auth, c.req.param("providerID"), body.auth.key)
        return c.json({})
      } catch (err) {
        return authErrorResponse(c, err)
      }
    })
    .delete("/auth/:providerID", async (c) => {
      if (c.req.query("harness") !== "pi" || !options.deletePiCredential) return c.json({ error: { code: "pi_credentials_unavailable", message: "Pi credential storage is unavailable" } }, 503)
      try {
        const auth = await signedAuth(c, options)
        if (!auth) throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
        await options.deletePiCredential(auth, c.req.param("providerID"))
        return c.json({})
      } catch (err) {
        return authErrorResponse(c, err)
      }
    })
    // Marketplace catalog — the curated extension list is a static, machine-
    // independent registry, so the hosted central serves it directly (the
    // module is pure: no fs/Node imports). The app reads this at
    // /api/claxedo/agent-config/extensions/catalog.
    .get("/api/claxedo/agent-config/extensions/catalog", (c) =>
      c.json(loadAgentExtensionsCatalog()))
    // Machine-scan discovers extensions already installed under ~/.claude etc.
    // A hosted central has no such local machine, so it returns an empty set.
    .get("/api/claxedo/agent-config/extensions/machine-scan", (c) => c.json([]))
    // Installed-extensions list (marketplace `loadInstalled`, ?scope=machine|
    // project). A hosted central has no local machine/project install surface,
    // so the installed set is empty — served as the `extensionListBody` object
    // shape the app parses, with 200 (a 404 would log a red console error).
    // Workspace-scope installs never land here: the app routes those through
    // the marketplace's workspace flow, not this boot surface.
    .get("/api/claxedo/agent-config/extensions", (c) => c.json(emptyExtensionList()))
}
