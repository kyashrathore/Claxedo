/**
 * Hosted shell-boot routes: the global surface the app shell reads from a
 * hosted central (Cloudflare Worker) deployment, which has no local
 * filesystem, no embedded runtime and no machine behind it.
 *
 *   GET    /api/claxedo/auth/descriptor         public auth adapter descriptor
 *   GET    /api/cp/events                       auth-gated live-sync SSE stream,
 *                                               resumable by `Last-Event-ID` when a
 *                                               LiveSyncRoom is bound
 *   GET    /global/health                       { healthy, version }
 *   GET    /api/claxedo/bootstrap               public posture, plus the project
 *                                               catalog for a signed caller
 *   GET    /path                                synthetic path derived from ?directory
 *   GET    /api/claxedo/agent-config/providers  Pi provider catalog
 *   GET    /api/claxedo/agent-config/providers/auth
 *   PUT    /auth/:providerID?harness=pi         store an org Pi credential
 *   DELETE /auth/:providerID?harness=pi         remove an org Pi credential
 *   GET    /api/claxedo/agent-config/connections  always unsupported on a central
 *   GET    /api/claxedo/agent-config/harness    a placement's harness health, read over
 *                                               the relay
 *   GET    /api/claxedo/agent-config/harness/options  a placement's model options, read
 *                                               over the relay
 */

import { Hono } from "hono"
import type { Context } from "hono"
import {
  ControlPlaneAuthError,
  bearerToken,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  issuesSessions,
  type ControlPlaneTokenVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { requestHasAuthenticationCredential } from "@claxedo/server-core/platform/auth/authentication"
import type { SandboxManagerPort } from "@claxedo/server-core/sandbox/manager-port"
import { authorityRowBacking, readyCloudWorkspaces } from "@claxedo/server-core/workspace/cloud-runtime-readiness"
import { authorityRowReachable } from "@claxedo/server-core/workspace/placement-reachability"
import { connectLiveSyncRoom, type LiveSyncRoomNamespace } from "../../deployments/hosted-workerd/live-sync-room.cf"
import { requireAuthority, type WorkspaceRecord } from "@claxedo/server-core/platform/auth/authority"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import { WORKSPACE_RUNTIME_IDENTITY_PATH } from "@claxedo/server-core/platform/governance/route-ownership"
import type { ControlPlaneServices } from "../../authority/services"
import { resolveWorkspaceRuntimeTarget } from "../../authority/runtime-target"
import { relayRole } from "../../authority/pulled-session"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { workspaceIdFromWorkspaceRef } from "@claxedo/server-core/workspace/refs"
import type { RelayRole } from "@claxedo/workspace-relay"
import type { RuntimeHarnessSelection } from "@claxedo/workspace-runtime/config"
import { readJsonRecord, stringField } from "@claxedo/server-core/platform/json/index"
import { isAccountSource, type AccountSource } from "@claxedo/account-contract/vocabulary"
import { asRecord, asString } from "@claxedo/helpers/guards"
import { AGENT_HARNESS_IDS, EVENT_STREAM_HEARTBEAT_MS } from "@claxedo/agent-runtime-contract"

export type HostedShellRouteOptions = {
  authentication?: RequestAuthenticationAdapter
  authConfig: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
  /** Reported by /global/health and the bootstrap aggregate. */
  version?: string
  /** Whether the entry mounted the hosted Connections family; the bootstrap declares it. */
  connections?: boolean
  /** Signed project inventory source (the authority workspaces.list). */
  listWorkspaces?: (auth: SignedControlPlaneAuth) => Promise<unknown>
  /** Whose lease says which cloud workspaces of that inventory are running. */
  sandboxManager?: Pick<SandboxManagerPort, "target">
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
  /**
   * Typed as a record rather than `unknown`: the route serves the value
   * verbatim, and `unknown` only forced a `c.json(… as never)` at the one place
   * that does.
   */
  piProviderCatalog?: (auth: SignedControlPlaneAuth) => Promise<Record<string, unknown>>
  putPiCredential?: (auth: SignedControlPlaneAuth, providerID: string, key: string) => Promise<void>
  deletePiCredential?: (auth: SignedControlPlaneAuth, providerID: string) => Promise<void>
  piAccountSources?: (auth: SignedControlPlaneAuth) => Promise<{ sources: Record<string, AccountSource>; org: string[] }>
  putPiAccountSource?: (auth: SignedControlPlaneAuth, providerID: string, source: AccountSource) => Promise<void>
  /**
   * Ask the runtime of a workspace placed on a machine for harness health and
   * identity,
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
  /**
   * Relays a runtime options read (`path`) for a workspace on a machine or in a
   * sandbox; `undefined` for a workspace the caller cannot open.
   */
  harnessOptions?: (
    auth: SignedControlPlaneAuth,
    input: { workspaceId: string; path: string },
  ) => Promise<Response | undefined>
}

/** `/api/wr/health`'s shape, trimmed to the fields the harness probe reports. */
export type HostedHarnessProbe = {
  ok?: boolean
  status?: string
  harness?: RuntimeHarnessSelection
  activeHarness?: RuntimeHarnessSelection
  model?: string | null
  error?: string
  harnessHealth?: { status: "ok" | "degraded" | "unavailable"; reason?: string }
}

function txt(input: unknown) {
  return typeof input === "string" ? input : undefined
}

function version(options: HostedShellRouteOptions) {
  return options.version || "1.0.0"
}


// Shape mirror of `bootPath()` in routes/client-presentation.ts — the hosted
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

function piProviderAuth() {
  return {
    anthropic: [{ type: "api", label: "API Key" }],
    openai: [{ type: "api", label: "API Key" }],
  }
}

// The local server projects the same inventory, and the two must stay in step.
// They cannot be one function: the local one reaches the fs-backed agent config
// and workspace store, which the Worker bundle cannot carry. The inventory
// tells the app shell which directories a signed workspace occupies, and so
// which runtime-owned reads (provider, files, PTY) take the relay.
export function signedShellProjects(workspaces: unknown[], readyCloud: ReadonlySet<string>) {
  const groups = new Map<string, {
    id: string
    directories: string[]
    workspaces: Record<string, unknown>
  }>()
  for (const workspace of workspaces) {
    const row = asRecord(workspace)
    const workspaceId = asString(row?.workspace_id) ?? asString(row?.workspaceId)
    if (!workspaceId) continue
    // A workspace served elsewhere is addressed by its id; the host's own path
    // is location metadata.
    const directory = `workspace:${workspaceId}`
    const remoteDirectory = asString(row?.remote_directory) ?? asString(row?.remoteDirectory)
    const projectId = asString(row?.project_id) ?? asString(row?.projectID) ?? workspaceId
    const workspaceName = asString(row?.workspace_name) ?? asString(row?.workspaceName) ?? asString(row?.display_name) ?? asString(row?.displayName) ?? workspaceId
    const group = groups.get(projectId) ?? { id: projectId, directories: [], workspaces: {} }
    const backing = authorityRowBacking(row)
    group.directories.push(workspaceId)
    group.workspaces[workspaceId] = {
      id: workspaceId,
      backing,
      workspace_name: workspaceName,
      reachable: authorityRowReachable(row, readyCloud),
      directory,
      ...(remoteDirectory ? { remote_directory: remoteDirectory } : {}),
      // Carried so the client can derive an owner/repo label of its own (the
      // rail already does) without a second round-trip.
      ...(asString(row?.repo_url) ?? asString(row?.repoUrl) ? { repo_url: asString(row?.repo_url) ?? asString(row?.repoUrl) } : {}),
      ...(asString(row?.repo_name) ?? asString(row?.repoName) ? { repo_name: asString(row?.repo_name) ?? asString(row?.repoName) } : {}),
    }
    groups.set(projectId, group)
  }
  return [...groups.values()].map((group) => ({
    id: group.id,
    worktree: group.directories[0] ?? group.id,
    sandboxes: group.directories,
    workspaces: group.workspaces,
  }))
}

/**
 * The scope a hosted request names. A workspace id is the identity; `directory`
 * is what a client shows for it (a `workspace:` ref, or the machine's own path)
 * and only stands in when no id was sent.
 */
function directoryInput(c: Context) {
  return c.req.query("workspaceId") ?? c.req.query("directory") ?? c.req.header("x-claxedo-directory") ?? ""
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
// central. The app sends
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
  const candidate = workspaceIdFromWorkspaceRef(trimmed) ?? trimmed
  return HARNESS_WORKSPACE_ID.test(candidate) ? candidate : undefined
}

// `/api/wr/health`'s shape, read defensively the way every other hosted
// shape-mirror in this file reads a runtime/authority payload: an untyped
// wire response, never a value this module minted itself.
function decodeSandboxHealth(input: unknown): HostedHarnessProbe {
  const row = asRecord(input)
  const health = asRecord(row?.harnessHealth)
  const healthStatus = health?.status
  return {
    ...(typeof row?.ok === "boolean" ? { ok: row.ok } : {}),
    ...(asString(row?.status) ? { status: asString(row?.status) } : {}),
    ...(decodeHarnessSelection(row?.harness) ? { harness: decodeHarnessSelection(row?.harness) } : {}),
    ...(decodeHarnessSelection(row?.activeHarness) ? { activeHarness: decodeHarnessSelection(row?.activeHarness) } : {}),
    ...(typeof row?.model === "string" || row?.model === null ? { model: row.model } : {}),
    ...(txt(row?.error) ? { error: txt(row?.error) } : {}),
    ...(healthStatus === "ok" || healthStatus === "degraded" || healthStatus === "unavailable"
      ? { harnessHealth: { status: healthStatus, ...(asString(health?.reason) ? { reason: asString(health?.reason) } : {}) } }
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
    routingId: target.routingId,
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
        "x-claxedo-directory": `workspace:${input.workspaceId}`,
      },
    },
  )
}

/**
 * The parsed body, as `unknown`. A caller-chosen type parameter here would only
 * assert a shape nothing checks: every caller either narrows with `asRecord` or
 * hands the value to a schema.
 */
async function harnessRuntimeJson(
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
  return await res.json().catch(() => undefined)
}

type HarnessRelayTarget = Parameters<typeof harnessRelayFetch>[2]

/** The relay target of a workspace the caller may open, or nothing when the authority refuses it. */
async function openHarnessTarget(
  services: ControlPlaneServices,
  auth: SignedControlPlaneAuth,
  workspaceId: string,
): Promise<HarnessRelayTarget | undefined> {
  const authority = requireAuthority(services)
  const opened = await authority.openWorkspace(auth, { workspaceId }).catch((err) => {
    if (err instanceof ControlPlaneAuthError) return undefined
    throw err
  })
  const role = relayRole(opened?.role)
  if (!opened || !role) return undefined
  const workspaceRecord = opened.workspace
  const orgId = asString(workspaceRecord?.org_id) ?? asString(await authority.resolveOrgId(auth))
  const stamp = Date.now()
  const ws: Workspace = {
    id: workspaceId,
    ...(orgId ? { org_id: orgId } : {}),
    directory: `workspace:${workspaceId}`,
    kind: "cloud",
    status: "ready",
    created_at: stamp,
    updated_at: stamp,
  }
  return { workspaceId, ws, authorityWorkspace: workspaceRecord, authorityRole: role, path: WORKSPACE_RUNTIME_IDENTITY_PATH }
}

/** A relay target that does not answer for the workspace asked about is not trusted with a read. */
async function verifyHarnessRuntime(
  services: ControlPlaneServices,
  auth: SignedControlPlaneAuth,
  target: HarnessRelayTarget,
  runtimeFetch: HarnessRuntimeFetch | undefined,
) {
  const identity = asRecord(await harnessRuntimeJson(services, auth, { ...target, path: WORKSPACE_RUNTIME_IDENTITY_PATH }, runtimeFetch))
  if (txt(identity?.workspaceId) !== target.workspaceId) {
    throw new Error("Workspace runtime identity does not match requested workspace")
  }
}

export function hostedHarnessRuntimeStatus(
  services: ControlPlaneServices,
  /** Test seam only — production composition passes none and every fetch goes through the relay. */
  testOptions: { runtimeFetch?: HarnessRuntimeFetch } = {},
): NonNullable<HostedShellRouteOptions["harnessStatus"]> {
  return async (auth, input) => {
    const target = await openHarnessTarget(services, auth, input.workspaceId)
    if (!target) return undefined
    try {
      await verifyHarnessRuntime(services, auth, target, testOptions.runtimeFetch)
      // MUTATION-CHECK: runtime health call short-circuited on purpose.
      const health = asRecord(await harnessRuntimeJson(
        services,
        auth,
        {
          ...target,
          path: input.sessionId ? `/api/wr/health?sessionId=${encodeURIComponent(input.sessionId)}` : "/api/wr/health",
        },
        testOptions.runtimeFetch,
      ))
      return decodeSandboxHealth(health)
    } catch (err) {
      return { ok: false, status: "error", error: err instanceof Error ? err.message : String(err) }
    }
  }
}

/** Production `harnessOptions`: the runtime's own options answer, relayed as it answered. */
export function hostedHarnessRuntimeOptions(
  services: ControlPlaneServices,
  /** Test seam only — production composition passes none and every fetch goes through the relay. */
  testOptions: { runtimeFetch?: HarnessRuntimeFetch } = {},
): NonNullable<HostedShellRouteOptions["harnessOptions"]> {
  return async (auth, input) => {
    const target = await openHarnessTarget(services, auth, input.workspaceId)
    if (!target) return undefined
    await verifyHarnessRuntime(services, auth, target, testOptions.runtimeFetch)
    return testOptions.runtimeFetch
      ? await testOptions.runtimeFetch({ workspaceId: input.workspaceId, path: input.path })
      : await harnessRelayFetch(services, auth, { ...target, path: input.path })
  }
}

function decodeHarnessSelection(input: unknown): RuntimeHarnessSelection | undefined {
  const row = asRecord(input)
  if (row?.kind === "connection" && typeof row.connectionId === "string" && row.connectionId.trim()) {
    return { kind: "connection", connectionId: row.connectionId }
  }
  if (row?.kind === "native" && (row.harnessId === "claude" || row.harnessId === "codex" || row.harnessId === "cursor" || row.harnessId === "pi")) {
    return { kind: "native", harnessId: row.harnessId }
  }
  return undefined
}

function hostedHarnessStatusBody(probe: HostedHarnessProbe, workspaceId: string, sessionId?: string) {
  return {
    workspaceId,
    directory: `workspace:${workspaceId}`,
    ...(sessionId ? { sessionId } : {}),
    status: probe.ok ? "ready" : probe.status ?? "error",
    ready: probe.ok ?? false,
    ...(probe.harness ? { harness: probe.harness } : {}),
    ...(probe.activeHarness ? { activeHarness: probe.activeHarness } : {}),
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

function harnessSelectionParams(c: Context): Record<string, string> | undefined {
  const nativeHarness = c.req.query("nativeHarness")
  if (nativeHarness && AGENT_HARNESS_IDS.some((id) => id === nativeHarness)) return { nativeHarness }
  const connectionId = c.req.query("connectionId")?.trim()
  return connectionId ? { connectionId } : undefined
}

async function relayedHarnessOptionsResponse(c: Context, options: HostedShellRouteOptions) {
  try {
    const auth = await signedAuth(c, options)
    if (!auth) throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
    const selection = harnessSelectionParams(c)
    if (!selection) return c.json({ error: { code: "agent_config_harness_required", message: "Select an agent connection first" } }, 400)
    const workspaceId = harnessWorkspaceId(directoryInput(c))
    const sessionId = c.req.query("sessionId")?.trim() || undefined
    const model = c.req.query("model")?.trim() || undefined
    const query = new URLSearchParams({ ...selection, ...(model ? { model } : {}) })
    const path = `${sessionId ? `/session/${encodeURIComponent(sessionId)}/config-options` : "/api/wr/harness-config-options"}?${query}`
    const answer = workspaceId && options.harnessOptions ? await options.harnessOptions(auth, { workspaceId, path }) : undefined
    if (!answer) return c.json({ error: { code: "workspace_not_found", message: "Workspace not found" } }, 404)
    return new Response(answer.body, { status: answer.status, headers: { "content-type": answer.headers.get("content-type") ?? "application/json" } })
  } catch (err) {
    return authErrorResponse(c, err)
  }
}

function hasCredential(c: Context, options: HostedShellRouteOptions) {
  return options.authentication
    ? requestHasAuthenticationCredential(c.req.raw, options.authentication.descriptor)
    : !!bearerToken(c.req.header("authorization") ?? null)
}

async function signedProjects(c: Context, options: HostedShellRouteOptions) {
  if (!hasCredential(c, options)) return []
  const auth = await signedAuth(c, options)
  if (!auth) return []
  if (!options.listWorkspaces) return []
  const listed = await options.listWorkspaces(auth)
  const workspaces = Array.isArray(listed) ? listed : []
  return signedShellProjects(workspaces, await readyCloudWorkspaces(options.sandboxManager, workspaces))
}

function authErrorResponse(c: Context, err: unknown) {
  if (err instanceof ControlPlaneAuthError) {
    return c.json(controlPlaneAuthErrorBody(err), err.status)
  }
  throw err
}

// The app's stream reader drops a stream after `EVENT_STREAM_STALL_TIMEOUT_MS`
// with no `data:` line; SSE comments do not count. So keepalives must be data
// heartbeats (`{"type":"heartbeat"}`), the frame the local daemon's `cp/events`
// writes too. This fallback carries heartbeats only; hosted Worker composition
// supplies `LiveSyncRoom` for mutation nudges.
//
// Replay is deliberately not implemented here because there is nothing to
// replay: this fallback has no publisher. Nothing writes events to it — not the
// process-global `controlBus` (unreachable from a module that must stay in the
// Worker bundle) and not the Durable Object (whose absence selects this
// branch). A retention ring here would buffer the empty set forever.
//
// A hosted composition built without a `liveSyncRoom` is multi-instance, so
// even once it has a publisher a module-singleton ring would be the wrong
// shape: the ring one isolate fills is not the ring the next reconnect reads.
// Replay for this branch arrives with cross-instance fan-out, not before.
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

// Each reauthorization verifies the bearer and re-reads the caller's org
// through `resolveOrgId`, so it keeps its own 2-per-minute cadence instead of
// running on every heartbeat. A revoked subscriber's stream ends within one
// interval.
const REAUTHORIZE_MS = 30_000

export function HostedShellRoutes(options: HostedShellRouteOptions) {
  const heartbeatMs = options.heartbeatMs ?? EVENT_STREAM_HEARTBEAT_MS
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
          { intervalMs: REAUTHORIZE_MS, current: authorize },
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
    // Every subscriber passes the same control-plane auth gate as the other
    // claxedo routes. There is no loopback bypass on a hosted central.
    .get("/api/cp/events", events)
    .get("/global/health", (c) =>
      c.json({
        healthy: true,
        version: version(options),
      }))
    // Public, and deliberately not the node's bootstrap body: a hosted central
    // has no filesystem, no embedded runtime and no machine behind it. The app
    // reads it before its first render, while nobody is signed in yet, which is
    // why it passes no auth gate and an anonymous caller learns only the
    // posture. A caller holding a credential also gets the project catalog
    // `/project` serves, which is what a signed node's bootstrap carries too.
    .get("/api/claxedo/bootstrap", async (c) => {
      c.header("Cache-Control", "no-store")
      const declaration = {
        healthy: true,
        version: version(options),
        events: { hostAggregate: false },
        deployment: { issuesSessions: issuesSessions(options.authConfig), documents: false, connections: options.connections === true },
      }
      if (!hasCredential(c, options)) return c.json(declaration)
      try {
        return c.json({ ...declaration, project: await signedProjects(c, options) })
      } catch (err) {
        return authErrorResponse(c, err)
      }
    })
    .get("/path", (c) => c.json(hostedPath(directoryInput(c))))
    .get("/api/claxedo/agent-config/providers", async (c) => {
      try {
        const auth = await signedAuth(c, options)
        if (!auth) throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
        if (c.req.query("nativeHarness") !== "pi" || c.req.query("connectionId")) return c.json({ error: { code: "provider_catalog_unsupported", message: "Provider catalog requires nativeHarness=pi" } }, 400)
        if (!options.piProviderCatalog) return c.json({ error: { code: "provider_catalog_unavailable", message: "Pi provider catalog is not configured" } }, 503)
        return c.json(await options.piProviderCatalog(auth))
      } catch (err) {
        return authErrorResponse(c, err)
      }
    })
    .get("/api/claxedo/agent-config/providers/auth", async (c) => {
      try {
        const auth = await signedAuth(c, options)
        if (!auth) throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
        if (c.req.query("nativeHarness") !== "pi" || c.req.query("connectionId")) return c.json({ error: { code: "provider_catalog_unsupported", message: "Provider catalog requires nativeHarness=pi" } }, 400)
        return c.json(piProviderAuth())
      } catch (err) {
        return authErrorResponse(c, err)
      }
    })
    .get("/auth/sources", async (c) => {
      if (c.req.query("harness") !== "pi" || !options.piAccountSources) return c.json({ error: { code: "pi_credentials_unavailable", message: "Pi credential storage is unavailable" } }, 503)
      try {
        const auth = await signedAuth(c, options)
        if (!auth) throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
        return c.json(await options.piAccountSources(auth))
      } catch (err) {
        return authErrorResponse(c, err)
      }
    })
    .put("/auth/:providerID/source", async (c) => {
      if (c.req.query("harness") !== "pi" || !options.putPiAccountSource) return c.json({ error: { code: "pi_credentials_unavailable", message: "Pi credential storage is unavailable" } }, 503)
      try {
        const auth = await signedAuth(c, options)
        if (!auth) throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
        const source = (await readJsonRecord(c.req.raw))?.source
        if (!isAccountSource(source)) return c.json({ error: { code: "account_source_invalid", message: "source must be \"own\" or \"org\"" } }, 400)
        await options.putPiAccountSource(auth, c.req.param("providerID"), source)
        return c.json({})
      } catch (err) {
        return authErrorResponse(c, err)
      }
    })
    .put("/auth/:providerID", async (c) => {
      if (c.req.query("harness") !== "pi" || !options.putPiCredential) return c.json({ error: { code: "pi_credentials_unavailable", message: "Pi credential storage is unavailable" } }, 503)
      try {
        const auth = await signedAuth(c, options)
        if (!auth) throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
        const key = stringField(asRecord((await readJsonRecord(c.req.raw))?.auth), "key")
        if (!key) return c.json({ error: { code: "pi_auth_key_required", message: "auth.key is required" } }, 400)
        await options.putPiCredential(auth, c.req.param("providerID"), key)
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
    // Every session's harness store polls this unconditionally and swallows a
    // 404, so an absent route leaves readiness on its initial state forever.
    .get("/api/claxedo/agent-config/harness", (c) => harnessStatusResponse(c, options))
    .get("/api/claxedo/agent-config/harness/options", (c) => relayedHarnessOptionsResponse(c, options))
}
