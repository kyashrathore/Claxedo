import { embeddedConfigModeForPath } from "../../workspace/runtime-dispatch/internals"
import path from "path"
import fs from "fs/promises"
import os from "node:os"
import {
  authorizePtyAttach,
  createAuthorizedPtyConnection,
  createPersistentTranscriptHandleStore,
  createRuntimeCredentialIssuer,
  createTranscriptResolver,
  createWorkspaceRuntimeApp,
  managedWorkspaceSessionAccessPolicy,
  Pty,
  ptyAccessRefusalResponse,
  ptyStreamAccess,
  PTY_NOT_FOUND_REFUSAL,
  runtimeCredentialWorkspaceId,
  type AuthorizedPtyConnection,
  type EmbeddedRelayHostIdentity,
  type ProcessObserver,
  type ProcessOwnerHandle,
  type RuntimeCredentialClaims,
  type WorkspaceEventFramesTap,
  type WorkspaceRuntimeServerOptions,
} from "@claxedo/workspace-runtime"
import type { WorkspaceRuntimeRouteContribution } from "@claxedo/workspace-runtime/route-contribution"
import type { OpenCodeRuntime } from "@claxedo/workspace-runtime/opencode"
import type { WorkspaceRuntimeExposure } from "@claxedo/workspace-runtime/exposure"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { configureLocalWorkspaceRuntime } from "@claxedo/server-core/workspace/local-runtime-port"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { createClaxedoRuntimeExposure } from "../../hosts/workspace-runtime/exposure"
import { claxedoCorsOrigin } from "@claxedo/server-core/hosts/workspace-runtime/cors-origin"
import { createClaxedoAppliedRuntimeConfig } from "@claxedo/server-core/hosts/workspace-runtime/runtime-config"
import { resolveClaxedoWorkspaceRuntimeTarget } from "../../hosts/workspace-runtime/target"
import {
  createAcpConnectionProvider,
  projectionRenewalDue,
  projectionRenewalDueAt,
  type AgentTurnOutcome,
  type CompatEnvelope,
  type ConnectionProvider,
  type ConnectionSecretResolver,
} from "@claxedo/agent-sdk-runtime"
import { createOpenCodeServerConnectionProvider } from "@claxedo/opencode-server-adapter"
import { createLocalConnectionSecretResolver } from "@claxedo/server-core/agent-config/connection-secrets"
import { defaultHarness, loadUserConfig } from "@claxedo/server-core/agent-config/index"
import { credentialById, resolveSecretById } from "@claxedo/server-core/credentials/registry"
import { renewSdkCredentialsIfDue } from "@claxedo/server-core/opencode/sdk-credential-bridge"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import type { HostSessionAuthority } from "@claxedo/server-core/platform/auth/authority"

const log = Log.create({ service: "embedded-workspace-runtime" })

/**
 * What an observer of the registry is handed: the workspace a runtime serves
 * and its `wr/events` frames. One stable object per runtime, so a listener
 * may key its own attachment by identity and match a retirement to the mount
 * it answered.
 */
export type MountedEmbeddedWorkspaceRuntime = {
  workspace: Workspace
  frames: WorkspaceEventFramesTap
}

export type EmbeddedWorkspaceRuntimePhase = "mounted" | "retired" | "disposed"

type EmbeddedRuntime = ReturnType<typeof createWorkspaceRuntimeApp> & {
  workspace: Workspace
  observed: MountedEmbeddedWorkspaceRuntime
  applying?: Promise<void>
  reconcilingSessionMetadata?: Promise<void>
  diagnosticsOwner?: ProcessOwnerHandle
  /** When this runtime's earliest placeholder must be replaced; absent when it holds none. */
  renewAt?: number
  renewFailures?: number
}

export type EmbeddedWorkspaceRuntimeConfigMode = "skip" | "sync"

/**
 * A retirement in progress or stuck. It outlives the `hosts` entry on purpose:
 * the runtime is no longer routed to, but its store root and whatever its
 * teardown did not release are still this process's, and a replacement writer
 * must not be admitted over them.
 */
type EmbeddedRetirement = {
  workspaceId: string
  runtime: EmbeddedRuntime
  attempt: number
  /** Host teardown finished; a retry does not run it again. */
  disposed: boolean
  state: "retiring" | "retire_failed"
  error?: string
  done: Promise<EmbeddedRetirementResult>
}

export type EmbeddedRetirementResult = {
  workspaceId: string
  state: "retired" | "retire_failed"
  attempt: number
  error?: string
}

export type EmbeddedWorkspaceRuntimeOwner = {
  workspaceId: string
  state: "serving" | "retiring" | "retire_failed"
  attempt: number
  error?: string
}

export class EmbeddedWorkspaceRuntimeRetirementUnresolvedError extends Error {
  readonly code = "embedded_runtime_retirement_unresolved"

  constructor(readonly workspaceId: string, readonly attempt: number, readonly reason: string) {
    super(
      `Workspace ${workspaceId} cannot be mounted again: retirement attempt ${attempt} failed (${reason}). `
        + "Release it again with retry before a replacement runtime is created.",
    )
    this.name = "EmbeddedWorkspaceRuntimeRetirementUnresolvedError"
  }
}

const hosts = new Map<string, EmbeddedRuntime>()
const retiring = new Map<string, EmbeddedRetirement>()
let shutdownGeneration = 0

type EmbeddedWorkspaceRuntimeListener = (
  runtime: MountedEmbeddedWorkspaceRuntime,
  phase: EmbeddedWorkspaceRuntimePhase,
) => void

const observers = new Set<EmbeddedWorkspaceRuntimeListener>()

function notify(listener: EmbeddedWorkspaceRuntimeListener, runtime: EmbeddedRuntime, phase: EmbeddedWorkspaceRuntimePhase) {
  try {
    listener(runtime.observed, phase)
  } catch (error) {
    log.warn("an embedded workspace runtime observer threw", {
      workspace_id: runtime.workspace.id,
      phase,
      error: String(error),
    })
  }
}

/**
 * "mounted" and "retired" are announced from the two statements that own
 * `hosts` membership — the `set` in {@link ensureEmbeddedWorkspaceRuntime}
 * and the `delete` in `disposeRuntime` — so every mount is reported exactly
 * once and paired with exactly one retirement, including the
 * replace-while-retiring path, where the retirement is announced before the
 * replacement is created.
 *
 * "disposed" follows, once the runtime's own disposal has settled. Disposal
 * aborts the live turns, and the terminal `agent.lifecycle` and
 * `session.lifecycle` frames that settles are published before the runtime's
 * event stream closes; an observer serving those frames on a stream of its
 * own has to hold on until here or lose them with no gap to show for it.
 */
function announce(runtime: EmbeddedRuntime, phase: EmbeddedWorkspaceRuntimePhase) {
  for (const listener of Array.from(observers)) notify(listener, runtime, phase)
}

/**
 * Watch this process's embedded workspace runtimes. The currently mounted
 * ones are replayed to the new listener before it returns, so a host serving
 * them behind one stream never has to ask the registry for a snapshot and
 * race a mount against it.
 */
export function onEmbeddedWorkspaceRuntime(listener: EmbeddedWorkspaceRuntimeListener): () => void {
  observers.add(listener)
  for (const runtime of hosts.values()) notify(listener, runtime, "mounted")
  return () => {
    observers.delete(listener)
  }
}

/**
 * Whether a runtime mounted in THIS process holds a transcript for the
 * session. False for a workspace with no runtime up, so a caller that needs a
 * yes must be on a request the dispatcher already mounted one for.
 */
export function embeddedWorkspaceRuntimeHoldsSession(workspaceId: string, sessionId: string) {
  return hosts.get(workspaceId)?.host.hasSession(sessionId) ?? false
}

/** Read the active workspace's committed session config without consulting operator defaults. */
export function readEmbeddedWorkspaceSessionConfig(workspaceId: string, sessionId: string) {
  const config = hosts.get(workspaceId)?.host.getSessionConfig(sessionId)
  if (!config) throw new Error(`Workspace ${workspaceId} has no committed configuration for session ${sessionId}`)
  return config
}

/** The process-owned public embedded-SDK runtime every embedded host shares (the native `opencode` harness). */
let configuredOpenCodeRuntime: OpenCodeRuntime | undefined
let configuredConnectionProviders: readonly ConnectionProvider<unknown, unknown>[] = [
  createAcpConnectionProvider(),
  createOpenCodeServerConnectionProvider(),
]
let configuredConnectionSecretResolver: ConnectionSecretResolver = createLocalConnectionSecretResolver({
  async resolveReference({ reference }) {
    const credential = credentialById(reference, { onOutage: "empty" })
    if (!credential) return { leaseGeneration: "missing" }
    const value = await resolveSecretById(reference)
    return {
      ...(value ? { value } : {}),
      leaseGeneration: String(credential.updated_at),
      ...(credential.expires_at === null || credential.expires_at === undefined
        ? credential.status === "expired" ? { expiresAt: 0 } : {}
        : { expiresAt: credential.expires_at }),
      ...(credential.status === "revoked" ? { revoked: true } : {}),
    }
  },
})
/**
 * Host-supplied route groups for every embedded runtime this process creates.
 *
 * A neutral list rather than a named capability option: naming a hosted
 * capability here would put it inside the desktop-local composition. The
 * desktop passes nothing, so a build that contains no hosted capability
 * contains no path to one.
 */
let configuredRouteContributions: readonly WorkspaceRuntimeRouteContribution[] = []
let configuredProcessObserver: ProcessObserver | undefined
let configuredSessionAccessPolicy: WorkspaceRuntimeServerOptions["sessionAccessPolicy"] | undefined
let configuredLoopbackSessionAuthority: HostSessionAuthority | undefined
let configuredOnSessionMetaEvent: ((event: CompatEnvelope) => void) | undefined
let configuredOnSessionMetaCreated: ((workspace: Workspace, session: unknown) => Promise<void> | void) | undefined
let configuredOnSessionMetaSnapshot: ((workspace: Workspace, sessions: unknown[]) => void | Promise<void>) | undefined
let configuredOnTurnOutcome: ((input: { sessionId: string; assistantMessageId?: string; outcome: AgentTurnOutcome }) => void) | undefined
let configuredFirstPartyMcpLaunch: EmbeddedFirstPartyMcpLaunch | undefined

/**
 * The loopback origin this process serves `/api/claxedo/mcp` on and the user
 * it serves; an unsigned desktop passes no user. Each embedded runtime mints
 * its own credential under this origin.
 */
export type EmbeddedFirstPartyMcpLaunch = {
  baseUrl: string
  userId?: string
  /** The groups this machine has turned on; read per launch, so a switch needs no restart. */
  enabledToolGroups: () => readonly string[]
}

/**
 * How THIS process's embedded workspace runtimes composed their session
 * access — the `sessionAuthority` marker of the very policy
 * `createWorkspaceRuntimeApp` mounts them with.
 *
 * The one place that can answer it, and the one place that should: a host
 * serving these runtimes to remote clients (the desktop's relay tunnel, a
 * self-hosted `claxedo up`) has to DECLARE the composition to the control
 * plane, and the control plane refuses to infer it. Derived from the same
 * expression the app itself uses — the configured policy, or the unbound
 * `managedWorkspaceSessionAccessPolicy()` an embedded exposure falls back to —
 * so the declaration cannot drift from what is actually mounted.
 */
export function embeddedWorkspaceRuntimeSessionAuthority() {
  return embeddedSessionAccessPolicy().sessionAuthority
}

/**
 * The policy every embedded runtime in this process is mounted with: the
 * configured one, or the unbound `managedWorkspaceSessionAccessPolicy()` that
 * `createWorkspaceRuntimeApp` falls back to for an embedded exposure. Written
 * once so the marker above and the terminal attach below cannot answer for
 * different policies than the app itself runs.
 */
function embeddedSessionAccessPolicy() {
  return configuredSessionAccessPolicy ?? managedWorkspaceSessionAccessPolicy()
}

/**
 * What a client on this process's OWN loopback must do before it creates a
 * session here — a different question from the marker above, because these
 * runtimes decide the session lifecycle per request.
 *
 * A desktop daemon mounts the private-session policy for relayed members and
 * keeps the local-owner lifecycle for its own user, so it declares
 * `managed-private` to the control plane and `local` here: its window creates
 * sessions with no reservation, signed in or out. A host that admits nobody
 * without a verified actor stamps its loopback callers too, so its own client
 * must reserve first and both answers are the marker.
 */
export function embeddedWorkspaceRuntimeLoopbackSessionAuthority() {
  return configuredLoopbackSessionAuthority ?? embeddedWorkspaceRuntimeSessionAuthority()
}

export function configureEmbeddedWorkspaceRuntime(input: {
  opencodeRuntime?: OpenCodeRuntime
  connectionProviders?: readonly ConnectionProvider<unknown, unknown>[]
  resolveConnectionSecrets?: ConnectionSecretResolver
  routeContributions?: readonly WorkspaceRuntimeRouteContribution[]
  processObserver?: ProcessObserver
  /** The policy every runtime is mounted with; absent, the unbound `managedWorkspaceSessionAccessPolicy()`, whose marker is `local`. */
  sessionAccessPolicy?: WorkspaceRuntimeServerOptions["sessionAccessPolicy"]
  /** Declared where the policy's loopback arm is the local owner's; otherwise the marker answers. */
  loopbackSessionAuthority?: HostSessionAuthority
  onSessionMetaEvent?: (event: CompatEnvelope) => void
  onSessionMetaCreated?: (workspace: Workspace, session: unknown) => Promise<void> | void
  onSessionMetaSnapshot?: (workspace: Workspace, sessions: unknown[]) => void | Promise<void>
  onTurnOutcome?: (input: { sessionId: string; assistantMessageId?: string; outcome: AgentTurnOutcome }) => void
  /** Absent, no embedded runtime injects the first-party MCP entry into its sessions. */
  firstPartyMcpLaunch?: EmbeddedFirstPartyMcpLaunch
}) {
  configuredOpenCodeRuntime = input.opencodeRuntime
  configuredFirstPartyMcpLaunch = input.firstPartyMcpLaunch
  configuredConnectionProviders = input.connectionProviders ?? configuredConnectionProviders
  configuredConnectionSecretResolver = input.resolveConnectionSecrets ?? configuredConnectionSecretResolver
  configuredRouteContributions = input.routeContributions ?? []
  configuredProcessObserver = input.processObserver
  configuredSessionAccessPolicy = input.sessionAccessPolicy
  configuredLoopbackSessionAuthority = input.loopbackSessionAuthority
  configuredOnSessionMetaEvent = input.onSessionMetaEvent
  configuredOnSessionMetaCreated = input.onSessionMetaCreated
  configuredOnSessionMetaSnapshot = input.onSessionMetaSnapshot
  configuredOnTurnOutcome = input.onTurnOutcome
}

function storeRoot(ws: Workspace) {
  return path.join(dataDir(), "agent-core", ws.id)
}

export function cursorTranscriptRoot(workspaceDirectory: string, cursorDataRoot = process.env.CURSOR_DATA_DIR?.trim()) {
  const project = workspaceDirectory
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
  return path.join(cursorDataRoot || path.join(os.homedir(), ".cursor"), "projects", project, "agent-transcripts")
}

const embeddedRuntimeGuard = () => true

function options(
  ws: Workspace,
  sessionAccess: {
    exists(sessionId: string): boolean
    parentSessionIdFor(sessionId: string): string | undefined
  },
  harness: WorkspaceRuntimeServerOptions["harness"],
): WorkspaceRuntimeServerOptions & {
  exposure: WorkspaceRuntimeExposure
} {
  return {
    ...(harness ? { harness } : {}),
    ...(configuredOpenCodeRuntime ? { opencodeRuntime: configuredOpenCodeRuntime } : {}),
    connectionProviders: configuredConnectionProviders,
    resolveConnectionSecrets: configuredConnectionSecretResolver,
    ...(configuredRouteContributions.length ? { routeContributions: configuredRouteContributions } : {}),
    ...(configuredProcessObserver ? { processObserver: configuredProcessObserver } : {}),
    ...(configuredSessionAccessPolicy ? { sessionAccessPolicy: configuredSessionAccessPolicy } : {}),
    ...(configuredOnTurnOutcome ? { onTurnOutcome: configuredOnTurnOutcome } : {}),
    ...(configuredFirstPartyMcpLaunch
      ? {
          firstPartyMcpLaunch: {
            baseUrl: configuredFirstPartyMcpLaunch.baseUrl,
            enabledToolGroups: configuredFirstPartyMcpLaunch.enabledToolGroups,
            issuer: createRuntimeCredentialIssuer({
              runtimeId: crypto.randomUUID(),
              workspaceId: ws.id,
              ...(configuredFirstPartyMcpLaunch.userId ? { userId: configuredFirstPartyMcpLaunch.userId } : {}),
            }),
          },
        }
      : {}),
    // The observer persists control-plane session metadata. Conversation
    // delivery stays on the workspace's own `wr/events` and is never
    // republished onto the control-plane bus.
    onCompatEvent: (event) => configuredOnSessionMetaEvent?.(event),
    exposure: createClaxedoRuntimeExposure({ kind: "embedded", guard: embeddedRuntimeGuard }),
    target: resolveClaxedoWorkspaceRuntimeTarget(ws),
    storeRoot: storeRoot(ws),
    transcripts: {
      workspaceId: ws.id,
      resolver: createTranscriptResolver({
        workspaceId: ws.id,
        providers: {
          "cursor-agent": { root: cursorTranscriptRoot(ws.directory), format: "jsonl" },
        },
        authorizeParent: ({ workspaceId, parentSessionId }) =>
          workspaceId === ws.id && sessionAccess.exists(parentSessionId),
        handleStore: createPersistentTranscriptHandleStore({
          file: path.join(storeRoot(ws), "transcript-handles.db"),
        }),
      }),
    },
    sessionParents: {
      parentSessionIdFor: (sessionId) => sessionAccess.parentSessionIdFor(sessionId),
    },
    corsOrigin: claxedoCorsOrigin,
    // `createSessionRoutes` awaits this before publishing `session.lifecycle`
    // "created", so the control-plane list can never be invalidated before
    // its canonical projection row exists.
    afterCreateSession: configuredOnSessionMetaCreated
      ? ({ session }) => configuredOnSessionMetaCreated?.(ws, session)
      : undefined,
  }
}

async function apply(runtime: EmbeddedRuntime) {
  const appliedAt = Date.now()
  const snapshot = await createClaxedoAppliedRuntimeConfig({
    workspaceDir: runtime.workspace.directory,
    workspaceId: runtime.workspace.id,
  })
  await runtime.host.apply(snapshot)
  runtime.renewAt = projectionRenewalDueAt(snapshot.auth, appliedAt)
  runtime.renewFailures = 0
}

function configure(runtime: EmbeddedRuntime) {
  runtime.applying ??= apply(runtime).finally(() => {
    runtime.applying = undefined
  })
  return runtime.applying
}

function reconcileSessionMetadata(runtime: EmbeddedRuntime) {
  if (!configuredOnSessionMetaSnapshot) return Promise.resolve()
  runtime.reconcilingSessionMetadata ??= Promise.resolve(runtime.app.fetch(new Request(
    `http://embedded-workspace-runtime.local/session?directory=${encodeURIComponent(runtime.workspace.directory)}`,
    { headers: { "x-workspace-id": runtime.workspace.id } },
  ))).then(async (response) => {
    if (!response.ok) return
    const sessions = await response.json().catch(() => undefined)
    if (!Array.isArray(sessions)) return
    await configuredOnSessionMetaSnapshot?.(runtime.workspace, sessions)
  }).catch(() => undefined).finally(() => {
    runtime.reconcilingSessionMetadata = undefined
  })
  return runtime.reconcilingSessionMetadata
}

async function runEmbeddedRetirement(record: EmbeddedRetirement): Promise<EmbeddedRetirementResult> {
  const { workspaceId, runtime } = record
  try {
    if (!record.disposed) {
      try {
        await runtime.host.dispose()
      } finally {
        announce(runtime, "disposed")
      }
      record.disposed = true
    }
    // Config resolution and metadata projection begin outside the host's
    // request scope. Their consumers must finish before shared DB cleanup.
    await Promise.allSettled([runtime.applying, runtime.reconcilingSessionMetadata])
    // Only now: while the retirement is unresolved this runtime is still a
    // process owner, and the diagnostics registry should say so.
    runtime.diagnosticsOwner?.exit({ reason: "disposed" })
    retiring.delete(workspaceId)
    return { workspaceId, state: "retired", attempt: record.attempt }
  } catch (error) {
    record.state = "retire_failed"
    record.error = String(error)
    log.warn("an embedded workspace runtime retirement failed", {
      workspace_id: workspaceId,
      attempt: record.attempt,
      error: record.error,
    })
    return { workspaceId, state: "retire_failed", attempt: record.attempt, error: record.error }
  }
}

function disposeRuntime(runtime: EmbeddedRuntime): Promise<EmbeddedRetirementResult> {
  const pending = retiring.get(runtime.workspace.id)
  if (pending) return pending.done
  if (hosts.get(runtime.workspace.id) === runtime) {
    hosts.delete(runtime.workspace.id)
    // From here on nothing new is routed to this runtime; what it still
    // publishes, it publishes while being torn down.
    announce(runtime, "retired")
  }
  const record: EmbeddedRetirement = {
    workspaceId: runtime.workspace.id,
    runtime,
    attempt: 1,
    disposed: false,
    state: "retiring",
    done: Promise.resolve({ workspaceId: runtime.workspace.id, state: "retired", attempt: 1 }),
  }
  record.done = runEmbeddedRetirement(record)
  retiring.set(runtime.workspace.id, record)
  return record.done
}

// A shared module needs a way to reach a LOCAL workspace's runtime, and this
// is the module that owns them. Installing the port here — at import time,
// beside the runtimes it serves — means any composition that can create an
// embedded runtime can also be reached through one, with no import from the
// shared side back into this deployment.

configureLocalWorkspaceRuntime({
  sessionAuthority: embeddedWorkspaceRuntimeLoopbackSessionAuthority,
  async fetch(workspace: Workspace, request: Request) {
    // Same policy as the proxy path: a read never waits for a config sync.
    const runtime = await ensureEmbeddedWorkspaceRuntime(workspace, {
      config: embeddedConfigModeForPath(new URL(request.url).pathname, request.method),
    })
    return runtime.app.fetch(request)
  },
})

export async function ensureEmbeddedWorkspaceRuntime(
  ws: Workspace,
  input: { config?: EmbeddedWorkspaceRuntimeConfigMode } = {},
) {
  const generation = shutdownGeneration
  const assertCurrent = () => {
    if (generation !== shutdownGeneration) throw new Error("Embedded workspace runtime was shut down during acquisition")
  }
  const retirement = retiring.get(ws.id)
  if (retirement) {
    if (retirement.state === "retiring") await retirement.done
    assertCurrent()
    const unresolved = retiring.get(ws.id)
    // A mount request is not permission to abandon the old owner's cleanup;
    // a retry is an explicit operation.
    if (unresolved) {
      throw new EmbeddedWorkspaceRuntimeRetirementUnresolvedError(
        ws.id,
        unresolved.attempt,
        unresolved.error ?? "retirement did not complete",
      )
    }
  }
  const config = input.config ?? "sync"
  const hit = hosts.get(ws.id)
  if (hit) {
    if (hit.workspace.directory !== ws.directory) {
      await disposeRuntime(hit)
      assertCurrent()
      return ensureEmbeddedWorkspaceRuntime(ws, input)
    } else {
      if (config === "sync") await configure(hit)
      assertCurrent()
      await reconcileSessionMetadata(hit)
      assertCurrent()
      if (hosts.get(ws.id) !== hit) return ensureEmbeddedWorkspaceRuntime(ws, input)
      return hit
    }
  }

  // A read creates the runtime without applying a config snapshot (`config`
  // "skip"), and a runtime has no default harness until one is applied. The
  // configured default is selection policy, not launch state, so it is handed
  // to the runtime at creation the way a standalone runtime receives
  // `WORKSPACE_RUNTIME_NATIVE_HARNESS`; the first sync still applies the full
  // snapshot and may replace it.
  const harness = defaultHarness(await loadUserConfig())
  assertCurrent()
  // The read above yielded; a concurrent acquisition may have created the
  // runtime meanwhile, and one workspace id owns exactly one runtime.
  if (hosts.get(ws.id)) return ensureEmbeddedWorkspaceRuntime(ws, input)
  let activeHost: EmbeddedRuntime["host"] | undefined
  const created = createWorkspaceRuntimeApp({
    ...options(ws, {
      exists: (sessionId) => activeHost?.hasSession(sessionId) ?? false,
      parentSessionIdFor: (sessionId) => activeHost?.parentSessionIdFor(sessionId),
    }, harness),
    beforeAdapterAcquire: async () => {
      // Fan-out and mutation admission refresh accepted snapshots. Read-side
      // acquisition only supplies the missing initial snapshot (or retries a
      // failed apply), and shares configure's in-flight promise.
      if (runtime.host.detail().configApply.state !== "applied") await configure(runtime)
    },
  })
  const runtime: EmbeddedRuntime = {
    ...created,
    workspace: ws,
    observed: { workspace: ws, frames: created.host.frames },
    ...(configuredProcessObserver
      ? {
          diagnosticsOwner: configuredProcessObserver.register({
            ownerId: `runtime:${ws.id}`,
            ownerGeneration: crypto.randomUUID(),
            launchId: crypto.randomUUID(),
            kind: "runtime",
            role: "runtime",
            label: ws.workspace_name || "Workspace runtime",
            parentOwnerId: "owner-claxedo-server",
            workspaceId: ws.id,
            directory: ws.directory,
          }),
        }
      : {}),
  }
  activeHost = runtime.host
  hosts.set(ws.id, runtime)
  announce(runtime, "mounted")
  if (config === "sync") await configure(runtime)
  assertCurrent()
  runtime.diagnosticsOwner?.update({ lifecycle: "ready" })
  await reconcileSessionMetadata(runtime)
  assertCurrent()
  if (hosts.get(ws.id) !== runtime) return ensureEmbeddedWorkspaceRuntime(ws, input)
  return runtime
}

async function realPath(input: string) {
  return await fs.realpath(input).catch(() => path.resolve(input))
}

async function ownsPath(ws: Workspace, cwd: string) {
  const [root, current] = await Promise.all([
    realPath(ws.directory),
    realPath(cwd),
  ])
  return current === root || current.startsWith(root + path.sep)
}

export type EmbeddedWorkspacePtyAttachment =
  | { ok: true; connection: AuthorizedPtyConnection }
  | { ok: false; response: Response }

/**
 * Admits a caller to a terminal this process hosts, and hands back the
 * authorized lifetime it may have — the same one the runtime's own
 * `/:ptyID/connect` route builds, from the same policy the app is mounted
 * with.
 *
 * The caller reaching this is a WebSocket upgrade the daemon serves itself,
 * so the identity is the one its ingress verified, passed here whole: a
 * relay-replayed stamp, or nothing at all for this machine's own user. Nothing
 * on this path may name an actor the ingress did not.
 */
export async function attachEmbeddedWorkspacePty(input: {
  workspace: Workspace
  ptyId: string
  identity?: EmbeddedRelayHostIdentity
  authorization?: string
  method: string
  path: string
  cursor?: number
}): Promise<EmbeddedWorkspacePtyAttachment> {
  await ensureEmbeddedWorkspaceRuntime(input.workspace, {
    config: embeddedConfigModeForPath(input.path, input.method),
  })
  const info = Pty.get(input.ptyId)
  if (!info || !await ownsPath(input.workspace, info.cwd)) {
    return { ok: false, response: ptyAccessRefusalResponse(PTY_NOT_FOUND_REFUSAL) }
  }
  const policy = embeddedSessionAccessPolicy()
  const access = ptyStreamAccess({
    ...(input.identity ? { identity: input.identity } : {}),
    ...(input.authorization ? { authorization: input.authorization } : {}),
    method: input.method,
    path: input.path,
  })
  const admission = await authorizePtyAttach({ policy, access, info })
  if (!admission.allowed) return { ok: false, response: ptyAccessRefusalResponse(admission) }
  return {
    ok: true,
    connection: createAuthorizedPtyConnection({
      ptyId: input.ptyId,
      policy,
      access,
      admission,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    }),
  }
}

export async function syncEmbeddedWorkspaceRuntimes() {
  await Promise.allSettled([...hosts.values()].map((runtime) => configure(runtime)))
}

/** How often the renewal check runs; what it renews is decided from each placeholder's expiry. */
const RENEWAL_CHECK_INTERVAL_MS = 30_000
const RENEWAL_RETRY_BASE_MS = 5_000
const RENEWAL_RETRY_CEILING_MS = 5 * 60_000

/**
 * Re-push the config of every runtime whose placeholder is due, and of every
 * runtime at all when the process has just come back from a sleep.
 *
 * A suspended laptop resumes with placeholders older than any tick the timer
 * saw, and the elapsed wall clock is the only evidence the process gets that
 * it was gone.
 *
 * A failure is retried with backoff rather than settled and dropped: an
 * unrenewed placeholder expires inside the harness, and the turn that then
 * fails authentication carries nothing naming the renewal that did not happen.
 */
export async function renewEmbeddedWorkspaceRuntimeConfigs(input: { at: number; all?: boolean }) {
  // The engine is one process serving every workspace, so its placeholder has
  // no runtime in `hosts` to expire with.
  await renewSdkCredentialsIfDue(input).catch((error: unknown) => {
    log.warn("renewing the OpenCode engine's credentials failed", { error: String(error) })
  })
  for (const runtime of hosts.values()) {
    if (!projectionRenewalDue(input, runtime.renewAt)) continue
    try {
      await configure(runtime)
    } catch (error) {
      const failures = (runtime.renewFailures ?? 0) + 1
      runtime.renewFailures = failures
      runtime.renewAt = input.at
        + Math.min(RENEWAL_RETRY_BASE_MS * 2 ** (failures - 1), RENEWAL_RETRY_CEILING_MS)
      log.warn("renewing a workspace runtime's credentials failed", {
        workspace_id: runtime.workspace.id,
        attempt: failures,
        error: String(error),
      })
    }
  }
}

/** Drive {@link renewEmbeddedWorkspaceRuntimeConfigs} off a timer. Returns the stop. */
export function startEmbeddedWorkspaceRuntimeConfigRenewal(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now
  let lastCheck = now()
  const timer = setInterval(() => {
    const at = now()
    const slept = at - lastCheck > RENEWAL_CHECK_INTERVAL_MS * 2
    lastCheck = at
    void renewEmbeddedWorkspaceRuntimeConfigs({ at, all: slept })
  }, RENEWAL_CHECK_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}

export async function shutdownEmbeddedWorkspaceRuntimes(): Promise<{ ok: boolean; results: EmbeddedRetirementResult[] }> {
  shutdownGeneration++
  // Owners already retiring are collected before the live ones start, so
  // neither is counted twice, and every owner's outcome survives the first
  // failure instead of being discarded with it.
  const pending = [
    ...[...retiring.values()].map((record) => ({ workspaceId: record.workspaceId, done: record.done })),
    ...[...hosts.values()].map((runtime) => ({ workspaceId: runtime.workspace.id, done: disposeRuntime(runtime) })),
  ]
  const settled = await Promise.allSettled(pending.map((owner) => owner.done))
  const results = settled.map((outcome, index): EmbeddedRetirementResult =>
    outcome.status === "fulfilled"
      ? outcome.value
      : { workspaceId: pending[index]!.workspaceId, state: "retire_failed", attempt: 0, error: String(outcome.reason) })
  return { ok: results.every((result) => result.state === "retired"), results }
}

export function embeddedWorkspaceRuntimeActivity() {
  let activeTurns = 0
  let activeWrites = 0
  let checkpointing = 0
  for (const runtime of hosts.values()) {
    const activity = runtime.host.activity()
    activeTurns += activity.activeTurns
    activeWrites += activity.activeWrites
    if (activity.checkpointState !== "active") checkpointing++
  }
  return { hosts: hosts.size, activeTurns, activeWrites, checkpointing, owners: embeddedWorkspaceRuntimeOwners() }
}

/** Every workspace this process still owns, whether it is still serving one. */
export function embeddedWorkspaceRuntimeOwners(): EmbeddedWorkspaceRuntimeOwner[] {
  return [
    ...[...hosts.keys()].map((workspaceId) => ({ workspaceId, state: "serving" as const, attempt: 0 })),
    ...[...retiring.values()].map((record) => ({
      workspaceId: record.workspaceId,
      state: record.state,
      attempt: record.attempt,
      ...(record.error ? { error: record.error } : {}),
    })),
  ].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
}

/**
 * Verifies a first-party MCP bearer against the embedded runtime that minted
 * it. Each runtime signs with its own secret, so the unverified workspace claim
 * only selects the runtime to ask; a token for a workspace this process does
 * not host, or that its runtime rejects, verifies to nothing.
 */
export function verifyEmbeddedRuntimeCredential(token: string): RuntimeCredentialClaims | undefined {
  const workspaceId = runtimeCredentialWorkspaceId(token)
  if (!workspaceId) return undefined
  return hosts.get(workspaceId)?.host.runtimeCredentialIssuer()?.verify(token)
}

/**
 * Retire one workspace's runtime. Joins a retirement already under way;
 * `retry` starts a fresh attempt for one that failed, rerunning only the steps
 * that did not complete. Without `retry` a failed retirement is reported as it
 * stands and nothing is started.
 */
export function releaseEmbeddedWorkspaceRuntime(
  workspaceId: string,
  options: { retry?: boolean } = {},
): Promise<EmbeddedRetirementResult> {
  const runtime = hosts.get(workspaceId)
  if (runtime) return disposeRuntime(runtime)
  const record = retiring.get(workspaceId)
  if (!record) return Promise.resolve({ workspaceId, state: "retired", attempt: 0 })
  if (record.state === "retiring") return record.done
  if (!options.retry) {
    return Promise.resolve({
      workspaceId,
      state: "retire_failed",
      attempt: record.attempt,
      ...(record.error ? { error: record.error } : {}),
    })
  }
  record.attempt += 1
  record.state = "retiring"
  delete record.error
  record.done = runEmbeddedRetirement(record)
  return record.done
}
