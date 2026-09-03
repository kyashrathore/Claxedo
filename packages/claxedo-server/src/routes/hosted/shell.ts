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
 *   GET /api/claxedo/events     — auth-gated hosted live-sync SSE stream,
 *                                 resumable by `Last-Event-ID` when a
 *                                 LiveSyncRoom is bound (see deployments/hosted-workerd/live-sync-room.cf.ts)
 *   GET /api/claxedo/services   — { authenticated, services } first-party catalog
 *   GET /global/health          — { healthy, version }
 *   GET /project                — signed → the authority workspace projects, else []
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
import { loadAgentExtensionsCatalog } from "@claxedo/server-core/agent-config/extensions/catalog"
import {
  ControlPlaneAuthError,
  bearerToken,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ControlPlaneTokenVerifier,
  type ControlPlaneAuthConfig,
  type ControlPlaneAuthContext,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { requestHasAuthenticationCredential } from "@claxedo/server-core/platform/auth/authentication"
import {
  EMPTY_SERVICE_CATALOG,
  projectServiceCatalogForBrowser,
  type FirstPartyServiceCatalog,
} from "@claxedo/service-contract"
import { connectLiveSyncRoom, type LiveSyncRoomNamespace } from "../../deployments/hosted-workerd/live-sync-room.cf"
import { requireAuthority, type WorkspaceAuthority, type WorkspaceRecord } from "@claxedo/server-core/platform/auth/authority"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import { WORKSPACE_RUNTIME_IDENTITY_PATH } from "@claxedo/server-core/platform/governance/route-ownership"
import type { ControlPlaneServices } from "../../authority/services"
import { resolveWorkspaceRuntimeTarget } from "../../authority/runtime-target"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import type { RelayRole } from "@claxedo/workspace-relay"

export type HostedShellRouteOptions = {
  authentication?: RequestAuthenticationAdapter
  authConfig: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
  /** Reported by /global/health and the bootstrap aggregate. */
  version?: string
  /** Signed project inventory source (the authority workspaces.list). */
  listWorkspaces?: (auth: SignedControlPlaneAuth) => Promise<unknown>
  /** Heartbeat cadence for the events stream (tests shrink this). */
  heartbeatMs?: number
  /**
   * Per-owner live-sync fan-out Durable Object namespace (Cloudflare
   * Worker only). The public SSE route is bridged to a hibernatable socket held
   * by the caller's LiveSyncRoom. Absent → heartbeat fallback.
   */
  liveSyncRoom?: LiveSyncRoomNamespace
  /**
   * Resolves the caller's AUTHORITY-INTERNAL org id (`authority.resolveOrgId`)
   * at connect time. Room names and the per-connection event visibility filter
   * live in this namespace — the SAME one document/provision events and
   * runtime-token claims are stamped with — never the issuer org
   * claim. Absent → signed subscribers hold the subject-keyed owner room,
   * where org-scoped events stay invisible fail-closed.
   */
  resolveOrgId?: (auth: SignedControlPlaneAuth) => Promise<string>
  piProviderCatalog?: (auth: SignedControlPlaneAuth) => Promise<unknown>
  putPiCredential?: (auth: SignedControlPlaneAuth, providerID: string, key: string) => Promise<void>
  deletePiCredential?: (auth: SignedControlPlaneAuth, providerID: string) => Promise<void>
  /** Durable workspace extension controls owned by the hosted authority. */
  workspaceAgentExtensions?: Pick<
    WorkspaceAuthority,
    | "listWorkspaceAgentExtensions"
    | "authorizeWorkspaceAgentExtensionsAdmin"
    | "setWorkspaceAgentExtensionEnabled"
    | "deleteWorkspaceAgentExtension"
  >
  /** Idempotent owner setup scheduled only from signed bootstrap on Worker waitUntil. */
  activateOwner?: (auth: SignedControlPlaneAuth) => Promise<void>
  /** Authenticated, data-only first-party installation catalog. */
  serviceCatalog?: (auth: SignedControlPlaneAuth) => Promise<FirstPartyServiceCatalog>
  /**
   * Ask a signed user-hosted workspace's runtime for harness health/identity,
   * through the relay. Backs `GET /api/claxedo/agent-config/harness` — the
   * probe the app shell's harness store polls unconditionally
   * (`features/session/harness/{harness-config-store,harness-switcher,
   * harness-hydrator}.ts`) to keep session readiness and the composer health
   * peek current. Desktop answers the same probe locally by proxying
   * `/api/wr/health` through the sandbox manager
   * (`claxedo-local-server/src/agent-config/routes/harness-routes.ts`); a
   * hosted central has no sandbox manager, so this asks the SAME endpoint on
   * the workspace's own runtime over the relay (`hostedHarnessRuntimeStatus`
   * below is the production implementation). Returns `undefined` for a
   * workspace the caller cannot open — the route answers 404, matching an
   * unknown project id elsewhere on this surface. Absent entirely (a
   * composition with no relay wiring) degrades every probe to that same 404
   * rather than a bare unmatched-route 404, which is what the app already
   * treats as "no harness" — silent, not broken.
   */
  harnessStatus?: (
    auth: SignedControlPlaneAuth,
    input: { workspaceId: string; sessionId?: string },
  ) => Promise<HostedHarnessProbe | undefined>
}

/** `/api/wr/health`'s shape, trimmed to the fields the harness probe reports. */
export type HostedHarnessProbe = {
  ok?: boolean
  status?: string
  agentType?: string
  acpBinary?: string | null
  model?: string | null
  error?: string
  harnessHealth?: { status: "ok" | "degraded" | "unavailable"; reason?: string }
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

/**
 * "owner/repo" from a git remote. Mirrors the app's
 * `app/workbench/rail/rail-git-remote.ts` — the rail has always labelled
 * projects this way; the composer could not because the grouping below dropped
 * `repo_url` before it ever reached the client.
 */
function ownerRepo(remote: string | undefined) {
  if (!remote) return undefined
  return remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1]
}

/**
 * The PROJECT's display name.
 *
 * `display_name` is deliberately LAST-but-one: it is the WORKSPACE name, and
 * the hosted create dialog posts `workspaceName: "main"` for the first
 * workspace, so preferring it labelled every hosted cloud project "main".
 * There is no `project_name` column on workspaces — the repo
 * identity is the only project-scoped name the row actually carries.
 */
function projectDisplayName(row: Record<string, unknown> | undefined, projectId: string) {
  return txt(row?.project_name) ??
    txt(row?.projectName) ??
    txt(row?.repo_name) ??
    txt(row?.repoName) ??
    ownerRepo(txt(row?.repo_url) ?? txt(row?.repoUrl)) ??
    txt(row?.display_name) ??
    txt(row?.displayName) ??
    projectId
}

export function signedShellProjects(workspaces: unknown[], now: number) {
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
    // A workspace served elsewhere is addressed by its id; the host's own path
    // is location metadata.
    const directory = `workspace:${workspaceId}`
    const remoteDirectory = txt(row?.remote_directory) ?? txt(row?.remoteDirectory)
    const projectId = txt(row?.project_id) ?? txt(row?.projectID) ?? workspaceId
    const workspaceName = txt(row?.workspace_name) ?? txt(row?.workspaceName) ?? txt(row?.display_name) ?? txt(row?.displayName) ?? workspaceId
    const created = num(row?.created_at) ?? num(row?.createdAt) ?? now
    const updated = num(row?.updated_at) ?? num(row?.updatedAt) ?? num(row?.last_seen_at) ?? created
    const group = groups.get(projectId) ?? {
      id: projectId,
      name: projectDisplayName(row, projectId),
      directories: [],
      workspaces: {},
      created,
      updated,
    }
    group.created = Math.min(group.created, created)
    group.updated = Math.max(group.updated, updated)
    // A project's rows are not uniform: only some carry repo identity. If this
    // group was opened by a bare row its name is still the raw project id, so
    // let a later row that DOES know the repo upgrade it.
    if (group.name === projectId) group.name = projectDisplayName(row, projectId)
    group.directories.push(workspaceId)
    group.workspaces[workspaceId] = {
      id: workspaceId,
      kind: txt(row?.access) ?? txt(row?.backing) ?? "cloud",
      workspace_name: workspaceName,
      directory,
      ...(remoteDirectory ? { remote_directory: remoteDirectory } : {}),
      // Carried so the client can derive an owner/repo label of its own (the
      // rail already does) without a second round-trip.
      ...(txt(row?.repo_url) ?? txt(row?.repoUrl) ? { repo_url: txt(row?.repo_url) ?? txt(row?.repoUrl) } : {}),
      ...(txt(row?.repo_name) ?? txt(row?.repoName) ? { repo_name: txt(row?.repo_name) ?? txt(row?.repoName) } : {}),
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

/**
 * The scope a hosted request names. A workspace id is the identity; `directory`
 * is what a client shows for it (a `workspace:` ref, or the machine's path for
 * a user-hosted workspace) and only stands in when no id was sent.
 */
function directoryInput(c: Context) {
  return c.req.query("workspaceId") ?? c.req.query("directory") ?? c.req.header("x-opencode-directory") ?? ""
}

async function signedAuth(c: Context, options: HostedShellRouteOptions) {
  const context = await controlPlaneAuthContext(c.req.raw, {
    authentication: options.authentication,
    config: options.authConfig,
    ...(options.verifier ? { verifier: options.verifier } : {}),
  })
  return context.mode === "signed" ? context : undefined
}

// The one legal `directory -> workspaceId` narrowing point on the hosted
// central. Mirrors the app's `workspaceIdFromRef`
// (`claxedo-app/src/platform/identity/legacy-resolver.ts`): the app sends
// either a bare `ws_...`/uuid workspace id or that id prefixed
// `workspace:<id>` — a hosted central has no filesystem, so those are the
// only two shapes a `directory` query param can legally carry here. Anything
// else (a filesystem path, an empty string, a malformed ref) resolves to
// `undefined`, which the route answers as an unknown workspace (404) —
// exactly how a genuinely unknown workspace id resolves once opened.
const HARNESS_WORKSPACE_ID = /^(ws_[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i

function harnessWorkspaceId(directory: string) {
  const trimmed = directory.trim()
  if (!trimmed) return undefined
  const candidate = trimmed.match(/^workspace:(.+)$/)?.[1] ?? trimmed
  return HARNESS_WORKSPACE_ID.test(candidate) ? candidate : undefined
}

function runtimeHealthPath(sessionId?: string) {
  return sessionId ? `/api/wr/health?${new URLSearchParams({ sessionId })}` : "/api/wr/health"
}

function relayRoleOf(input: unknown): RelayRole | undefined {
  return input === "viewer" || input === "editor" || input === "admin" || input === "owner" ? input : undefined
}

// `/api/wr/health`'s shape, read defensively the way every other hosted
// shape-mirror in this file reads a runtime/authority payload: an untyped
// wire response, never a value this module minted itself.
function decodeSandboxHealth(input: unknown): HostedHarnessProbe {
  const row = rec(input)
  const health = rec(row?.harnessHealth)
  const healthStatus = health?.status
  return {
    ...(typeof row?.ok === "boolean" ? { ok: row.ok } : {}),
    ...(txt(row?.status) ? { status: txt(row?.status) } : {}),
    ...(txt(row?.agentType) ? { agentType: txt(row?.agentType) } : {}),
    ...(typeof row?.acpBinary === "string" || row?.acpBinary === null ? { acpBinary: row.acpBinary as string | null } : {}),
    ...(typeof row?.model === "string" || row?.model === null ? { model: row.model as string | null } : {}),
    ...(txt(row?.error) ? { error: txt(row?.error) } : {}),
    ...(healthStatus === "ok" || healthStatus === "degraded" || healthStatus === "unavailable"
      ? { harnessHealth: { status: healthStatus, ...(txt(health?.reason) ? { reason: txt(health?.reason) } : {}) } }
      : {}),
  }
}

/**
 * Production `harnessStatus` for `HostedShellRouteOptions`: resolves the
 * caller's access to `workspaceId` through the authority (the same
 * `openWorkspace` gate every other signed workspace read on this plane uses),
 * then asks that workspace's runtime for `/api/wr/health` through the
 * relay-backed `verifiedRuntimeJson` — the identity probe it runs first
 * (`WORKSPACE_RUNTIME_IDENTITY_PATH`) refuses to answer for a relay target
 * that is not actually serving this workspace (see
 * `authority/hosted-session-pull.ts` for the same resolve-then-verify shape
 * on the session-pull path). `httpOptions.runtimeFetch` is a test seam only —
 * production composition passes none, so `verifiedRuntimeJson` mints a real
 * runtime access token and calls the relay.
 *
 * A workspace the caller cannot open (unknown id, revoked share, wrong org)
 * answers `undefined` — the route's 404 — rather than throwing, so a stale
 * project reference degrades to "not found" instead of a 401/403 that would
 * misreport the caller's own auth as invalid. Once the workspace is known,
 * any further failure (relay down, runtime unreachable, identity mismatch)
 * is reported as a DEGRADED probe (`ok: false`, `status: "error"`, `error`)
 * rather than re-thrown, matching the local proxy's own
 * catch-and-degrade for the same unreachable-runtime case.
 *
 * This resolves and calls the relay directly (mint token, fetch) rather than
 * through `authority/http/runtime-transport.ts`'s `verifiedRuntimeJson`: that
 * module pulls in `authority/http/protocol.ts`, which pulls in
 * `workspace/supervisor` — the desktop-only control-token verifier — and
 * `@claxedo/workspace-runtime` with it, a package this Worker bundle must
 * never reach (`test:architecture-ratchets` catches exactly this edge). The
 * shape below mirrors `authority/hosted-session-pull.ts`'s OWN private
 * `runtimeJson`/`verifiedRuntimeJson`, written for the identical reason.
 */
type HarnessRuntimeFetch = (input: { workspaceId: string; path: string }) => Promise<Response>

async function harnessRelayFetch(
  services: ControlPlaneServices,
  auth: SignedControlPlaneAuth,
  input: {
    workspaceId: string
    ws: Workspace
    authorityWorkspace?: WorkspaceRecord
    authorityRole: RelayRole
    path: string
  },
) {
  const provider = services.relay.provider
  if (!provider) throw new Error("Workspace runtime pull transport is not configured")
  const orgId = input.ws.org_id
  if (!orgId) throw new Error("Workspace is missing org identity for runtime token minting")
  const target = await resolveWorkspaceRuntimeTarget(services, auth, {
    workspaceId: input.workspaceId,
    ...(input.authorityWorkspace ? { workspace: input.authorityWorkspace } : {}),
  })
  const token = await provider.mintRuntimeAccessToken({
    workspaceId: input.workspaceId,
    hostId: target.hostId,
    principalKind: "user",
    auth,
    ...(await resolveRuntimeActor(requireAuthority(services), auth)),
    orgId,
    role: input.authorityRole,
    ttlMs: 10 * 60_000,
  })
  const relayUrl = await provider.getRelayEndpoint(input.workspaceId, target.homeRegion)
  return await fetch(
    `${relayUrl.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(input.workspaceId)}${input.path}`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token.token}`,
        "x-opencode-directory": `workspace:${input.workspaceId}`,
      },
    },
  )
}

async function harnessRuntimeJson<T>(
  services: ControlPlaneServices,
  auth: SignedControlPlaneAuth,
  input: Parameters<typeof harnessRelayFetch>[2],
  runtimeFetch?: HarnessRuntimeFetch,
) {
  const res = runtimeFetch
    ? await runtimeFetch({ workspaceId: input.workspaceId, path: input.path })
    : await harnessRelayFetch(services, auth, input)
  if (!res.ok) {
    throw new Error((await res.text().catch(() => "")) || `Workspace runtime pull failed: ${res.status}`)
  }
  return (await res.json()) as T
}

export function hostedHarnessRuntimeStatus(
  services: ControlPlaneServices,
  /** Test seam only — production composition passes none and every fetch goes through the relay. */
  testOptions: { runtimeFetch?: HarnessRuntimeFetch } = {},
): NonNullable<HostedShellRouteOptions["harnessStatus"]> {
  return async (auth, input) => {
    const authority = requireAuthority(services)
    const opened = await authority.openWorkspace(auth, { workspaceId: input.workspaceId }).catch((err) => {
      if (err instanceof ControlPlaneAuthError) return undefined
      throw err
    })
    const role = relayRoleOf(opened?.role)
    if (!opened || !role) return undefined
    const workspaceRecord = opened.workspace
    const orgId = txt(workspaceRecord?.org_id) ?? txt(await authority.resolveOrgId(auth))
    const stamp = Date.now()
    const ws: Workspace = {
      id: input.workspaceId,
      ...(orgId ? { org_id: orgId } : {}),
      directory: `workspace:${input.workspaceId}`,
      kind: "cloud",
      status: "ready",
      created_at: stamp,
      updated_at: stamp,
    }
    const target = { workspaceId: input.workspaceId, ws, authorityWorkspace: workspaceRecord, authorityRole: role }
    try {
      // The identity probe first: refuse to trust a relay target that does
      // not answer for the workspace we asked about.
      const identity = await harnessRuntimeJson<Record<string, unknown>>(
        services,
        auth,
        { ...target, path: WORKSPACE_RUNTIME_IDENTITY_PATH },
        testOptions.runtimeFetch,
      )
      if (txt(identity.workspaceId) !== input.workspaceId) {
        throw new Error("Workspace runtime identity does not match requested workspace")
      }
      // MUTATION-CHECK: runtime health call short-circuited on purpose.
      const health = await harnessRuntimeJson<Record<string, unknown>>(
        services,
        auth,
        {
          ...target,
          path: input.sessionId ? `/api/wr/health?sessionId=${encodeURIComponent(input.sessionId)}` : "/api/wr/health",
        },
        testOptions.runtimeFetch,
      )
      return decodeSandboxHealth(health)
    } catch (err) {
      return { ok: false, status: "error", error: err instanceof Error ? err.message : String(err) }
    }
  }
}

/**
 * The identity the daemon's own status route reports as `harness` /
 * `activeHarness`: the runtime health's `agentType` is the base harness id,
 * served natively unless the runtime is driving an ACP binary.
 */
function hostedHarnessIdentity(probe: HostedHarnessProbe) {
  return { id: probe.agentType, access: probe.acpBinary ? "acp" : "native" }
}

function hostedHarnessStatusBody(probe: HostedHarnessProbe, workspaceId: string, sessionId?: string) {
  return {
    workspaceId,
    directory: `workspace:${workspaceId}`,
    ...(sessionId ? { sessionId } : {}),
    status: probe.ok ? "ready" : probe.status ?? "error",
    ready: probe.ok ?? false,
    ...(probe.agentType
      ? {
          harness: hostedHarnessIdentity(probe),
          activeHarness: hostedHarnessIdentity(probe),
          agentType: probe.agentType,
          activeType: probe.agentType,
        }
      : {}),
    activeBinary: probe.acpBinary ?? null,
    ...(probe.model !== undefined ? { model: probe.model } : {}),
    ...(probe.error ? { error: probe.error } : {}),
    ...(probe.harnessHealth ? { harnessHealth: probe.harnessHealth } : {}),
  }
}

async function harnessStatusResponse(c: Context, options: HostedShellRouteOptions) {
  try {
    const auth = await signedAuth(c, options)
    if (!auth) throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
    const workspaceId = harnessWorkspaceId(directoryInput(c))
    const sessionId = c.req.query("sessionId")?.trim() || undefined
    const probe = workspaceId && options.harnessStatus
      ? await options.harnessStatus(auth, { workspaceId, ...(sessionId ? { sessionId } : {}) })
      : undefined
    if (!probe) {
      return c.json({ error: { code: "workspace_not_found", message: "Workspace not found" } }, 404)
    }
    return c.json(hostedHarnessStatusBody(probe, workspaceId!, sessionId))
  } catch (err) {
    return authErrorResponse(c, err)
  }
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
  if (options.authentication) {
    if (!requestHasAuthenticationCredential(c.req.raw, options.authentication.descriptor)) return []
  } else if (!bearerToken(c.req.header("authorization") ?? null)) return []
  const auth = await signedAuth(c, options)
  if (!auth) return []
  if (activateOwner && options.activateOwner) {
    guardedWaitUntil(c)?.(options.activateOwner(auth))
  }
  if (!options.listWorkspaces) return []
  const workspaces = await options.listWorkspaces(auth)
  return signedShellProjects(Array.isArray(workspaces) ? workspaces : [], Date.now())
}

/**
 * The browser-visible first-party service catalog.
 *
 * `authenticated: false` is authoritative: the app deactivates already-loaded
 * services on it, so an unsigned request must answer the pair rather than an
 * error. This is also the app's first signed read of the session, so it is
 * where the owner's runtime activation is scheduled.
 */
async function signedServiceCatalogState(c: Context, options: HostedShellRouteOptions) {
  const hasCredential = options.authentication
    ? requestHasAuthenticationCredential(c.req.raw, options.authentication.descriptor)
    : !!bearerToken(c.req.header("authorization") ?? null)
  if (!hasCredential) return { authenticated: false, services: EMPTY_SERVICE_CATALOG }
  const auth = await signedAuth(c, options)
  if (!auth) return { authenticated: false, services: EMPTY_SERVICE_CATALOG }
  if (options.activateOwner) guardedWaitUntil(c)?.(options.activateOwner(auth))
  const services = options.serviceCatalog ? await options.serviceCatalog(auth) : EMPTY_SERVICE_CATALOG
  return {
    authenticated: true,
    services: projectServiceCatalogForBrowser(services),
  }
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
//
// REPLAY IS DELIBERATELY NOT IMPLEMENTED HERE, and the reason is that there is
// nothing to replay: this fallback has no publisher of any kind. Nothing writes
// events to it — not the process-global `claxedoBus` (which cannot be reached
// from a module that must stay in the Worker bundle) and not the Durable Object
// (whose absence is what selects this branch). A retention ring bolted on here
// would buffer the empty set forever.
//
// Its one live consumer is the Node hosted composition (`hosted-node.ts`), which
// passes no `liveSyncRoom`. That composition is documented as multi-instance by
// design and single-instance in practice (`docs/plans/
// 2026-07-18-001-cf-deployment-hardening.md` — per-instance live-sync via a
// the authority subscription — is unbuilt), so even once it HAS a publisher, a
// module-singleton ring would be the wrong shape for it: with N instances the
// ring an isolate fills is not the ring the next reconnect reads. Its resumable
// story arrives with the cross-instance fan-out, not before.
//
// The bootstrap frame still echoes the caller's cursor so the wire contract
// matches the Worker path and a reconnect cannot silently rewind a client's
// cursor to 0.
function eventsStream(c: Context, heartbeatMs: number, lastEventId?: string) {
  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const write = (data: unknown, id?: string) => {
        try {
          ctrl.enqueue(encoder.encode(`${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(data)}\n\n`))
        } catch {
          stop()
        }
      }
      // Initial hello so proxies flush headers and the bus goes live at once.
      write({ type: "heartbeat" }, lastEventId ?? "0")
      // Periodic heartbeats carry no id — they must never advance a cursor.
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
      "Cache-Control": "no-store",
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
      // scoping the local Node bus does — to REPLAYED frames as much as live
      // ones, since a room's retention ring is shared by every member of an org.
      const authorize = async () => {
        const auth = await controlPlaneAuthContext(c.req.raw, {
          authentication: options.authentication,
          config: options.authConfig,
          ...(options.verifier ? { verifier: options.verifier } : {}),
        })
        const orgId = auth.mode === "signed" && options.resolveOrgId
          ? await options.resolveOrgId(auth)
          : undefined
        return { auth, ...(orgId ? { orgId } : {}) }
      }
      const subscriber = await authorize()
      // The cursor is read here and forwarded, not resolved here: the room owns
      // the sequence, so it is the only party that can turn a cursor-less
      // connection into a resume point.
      const lastEventId = c.req.header("last-event-id")
      if (options.liveSyncRoom) {
        return await connectLiveSyncRoom(
          options.liveSyncRoom,
          subscriber,
          heartbeatMs,
          authorize,
          lastEventId,
        )
      }
      return eventsStream(c, heartbeatMs, lastEventId)
    } catch (err) {
      return authErrorResponse(c, err)
    }
  }
  return new Hono()
    // Public discovery surface for browser and native clients. Keep this
    // separate from the aggregate bootstrap so a CLI never has to interpret
    // application boot state in order to bind a credential to one deployment.
    // `AuthAdapterDescriptor` is deliberately public configuration: adapter
    // implementations retain every provider secret and signing key.
    .get("/api/claxedo/auth/descriptor", (c) => {
      c.header("Cache-Control", "no-store")
      if (!options.authentication) {
        return c.json({
          error: {
            code: "auth_configuration_invalid",
            message: "Authentication adapter is not configured",
          },
        }, 503)
      }
      return c.json(options.authentication.descriptor)
    })
    // Mirrors routes/events.ts: every bus subscriber passes the
    // same control-plane auth gate as the other claxedo routes. There is no
    // loopback bypass on a hosted central.
    .get("/api/claxedo/events", events)
    .get("/api/wr/events", events)
    .get("/global/event", events)
    // The first-party service catalog for this principal. The app reads it on
    // its own rather than as one field of a boot aggregate: every other field
    // that aggregate carried is per-workspace, per-harness, or a stub, and the
    // workspace catalog is the app's own query over `/api/workspace`.
    .get("/api/claxedo/services", async (c) => {
      try {
        return c.json(await signedServiceCatalogState(c, options))
      } catch (err) {
        return authErrorResponse(c, err)
      }
    })
    .get("/global/health", (c) =>
      c.json({
        healthy: true,
        version: version(options),
      }))
    .get("/project", async (c) => {
      try {
        return c.json(await signedProjects(c, options))
      } catch (err) {
        return authErrorResponse(c, err)
      }
    })
    .get("/project/current", (c) => c.json(hostedProject(directoryInput(c))))
    .get("/project/:id", async (c) => {
      try {
        const id = c.req.param("id")
        const project = (await signedProjects(c, options)).find((item) => item.id === id)
        return project
          ? c.json(project)
          : c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
      } catch (err) {
        return authErrorResponse(c, err)
      }
    })
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
    // Operator-configured ACP agents live in the local machine's
    // `user-agent-config.json` (an fs-backed store the local/self-hosted roots
    // own). A hosted central has no such machine, so it answers the valid
    // empty shape rather than Hono's bare 404 — the app treats any non-ok as
    // "no ACP group", so this only quiets a recurring console 404 that read
    // as a broken deployment. Still per-caller data in shape (a future
    // per-user store), so it requires the same signed bearer every other
    // agent-config data route does.
    .get("/api/claxedo/agent-config/harness/acp-connections", async (c) => {
      try {
        const auth = await signedAuth(c, options)
        if (!auth) throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
        return c.json({ connections: [] })
      } catch (err) {
        return authErrorResponse(c, err)
      }
    })
    // Harness health/status probe — see `HostedShellRouteOptions.harnessStatus`
    // above for what this asks and why. Every session's harness store polls
    // this unconditionally; before this route existed it 404'd and was
    // swallowed, so readiness never moved off its initial state.
    .get("/api/claxedo/agent-config/harness", (c) => harnessStatusResponse(c, options))
    // A hosted central has no local machine/project install surface, so those
    // scopes return the valid empty shape. Workspace scope is authority-owned:
    // list and state mutations below use the same durable rows runtimes read.
    .get("/api/claxedo/agent-config/extensions", async (c) => {
      const workspaceId = c.req.query("scope") === "workspace" ? c.req.query("workspaceId")?.trim() : undefined
      if (!workspaceId) return c.json(emptyExtensionList())
      if (!options.workspaceAgentExtensions) {
        return c.json({ error: { code: "workspace_extensions_unavailable", message: "Workspace extensions are unavailable" } }, 503)
      }
      try {
        const auth = await signedAuth(c, options)
        if (!auth) throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
        const records = await options.workspaceAgentExtensions.listWorkspaceAgentExtensions(auth, { workspaceId })
        const rows = Array.isArray(records) ? records : []
        return c.json({
          desired: { version: 1, installs: rows.flatMap((row) => {
            const desired = rec(row)?.desired
            return desired && typeof desired === "object" && !Array.isArray(desired) ? [desired] : []
          }) },
          materialized: { version: 1, packages: {} },
          effective: {},
        })
      } catch (err) {
        return authErrorResponse(c, err)
      }
    })
    .post("/api/claxedo/agent-config/extensions/:id/enable", async (c) => {
      const workspaceId = c.req.query("scope") === "workspace" ? c.req.query("workspaceId")?.trim() : undefined
      if (!workspaceId) return c.json({ error: { code: "agent_config_workspace_required", message: "workspaceId is required" } }, 400)
      if (!options.workspaceAgentExtensions) return c.json({ error: { code: "workspace_extensions_unavailable", message: "Workspace extensions are unavailable" } }, 503)
      try {
        const auth = await signedAuth(c, options)
        if (!auth) throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
        await options.workspaceAgentExtensions.authorizeWorkspaceAgentExtensionsAdmin(auth, { workspaceId })
        await options.workspaceAgentExtensions.setWorkspaceAgentExtensionEnabled(auth, {
          workspaceId,
          extensionId: c.req.param("id"),
          enabled: true,
        })
        return c.json({ ok: true })
      } catch (err) {
        return authErrorResponse(c, err)
      }
    })
    .post("/api/claxedo/agent-config/extensions/:id/disable", async (c) => {
      const workspaceId = c.req.query("scope") === "workspace" ? c.req.query("workspaceId")?.trim() : undefined
      if (!workspaceId) return c.json({ error: { code: "agent_config_workspace_required", message: "workspaceId is required" } }, 400)
      if (!options.workspaceAgentExtensions) return c.json({ error: { code: "workspace_extensions_unavailable", message: "Workspace extensions are unavailable" } }, 503)
      try {
        const auth = await signedAuth(c, options)
        if (!auth) throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
        await options.workspaceAgentExtensions.authorizeWorkspaceAgentExtensionsAdmin(auth, { workspaceId })
        await options.workspaceAgentExtensions.setWorkspaceAgentExtensionEnabled(auth, {
          workspaceId,
          extensionId: c.req.param("id"),
          enabled: false,
        })
        return c.json({ ok: true })
      } catch (err) {
        return authErrorResponse(c, err)
      }
    })
    .delete("/api/claxedo/agent-config/extensions/:id", async (c) => {
      const workspaceId = c.req.query("scope") === "workspace" ? c.req.query("workspaceId")?.trim() : undefined
      if (!workspaceId) return c.json({ error: { code: "agent_config_workspace_required", message: "workspaceId is required" } }, 400)
      if (!options.workspaceAgentExtensions) return c.json({ error: { code: "workspace_extensions_unavailable", message: "Workspace extensions are unavailable" } }, 503)
      try {
        const auth = await signedAuth(c, options)
        if (!auth) throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
        await options.workspaceAgentExtensions.authorizeWorkspaceAgentExtensionsAdmin(auth, { workspaceId })
        await options.workspaceAgentExtensions.deleteWorkspaceAgentExtension(auth, {
          workspaceId,
          extensionId: c.req.param("id"),
        })
        return c.json({ ok: true })
      } catch (err) {
        return authErrorResponse(c, err)
      }
    })
}
