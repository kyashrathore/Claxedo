import { embeddedConfigModeForPath } from "../../workspace/runtime-dispatch/internals"
import path from "path"
import fs from "fs/promises"
import os from "node:os"
import {
  createPersistentTranscriptHandleStore,
  createRuntimeCredentialIssuer,
  createTranscriptResolver,
  createWorkspaceRuntimeApp,
  managedWorkspaceSessionAccessPolicy,
  Pty,
  runtimeCredentialWorkspaceId,
  type ProcessObserver,
  type ProcessOwnerHandle,
  type RuntimeCredentialClaims,
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
  type AgentTurnOutcome,
  type CompatEnvelope,
  type ConnectionProvider,
  type ConnectionSecretResolver,
} from "@claxedo/agent-sdk-runtime"
import { createOpenCodeServerConnectionProvider } from "@claxedo/opencode-server-adapter"
import { createLocalConnectionSecretResolver } from "@claxedo/server-core/agent-config/connection-secrets"
import { defaultHarness, loadUserConfig } from "@claxedo/server-core/agent-config/index"
import { getCredential, resolveSecretById } from "@claxedo/server-core/credentials/registry"

type EmbeddedRuntime = ReturnType<typeof createWorkspaceRuntimeApp> & {
  workspace: Workspace
  applying?: Promise<void>
  reconcilingSessionMetadata?: Promise<void>
  diagnosticsOwner?: ProcessOwnerHandle
}

export type EmbeddedWorkspaceRuntimeConfigMode = "skip" | "sync"

type PtySocket = {
  readyState: number
  send: (data: string | Uint8Array | ArrayBuffer) => void
  close: (code?: number, reason?: string) => void
}

const hosts = new Map<string, EmbeddedRuntime>()
const retiring = new Map<string, Promise<void>>()
let shutdownGeneration = 0

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
    const credential = getCredential(reference)
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
// Canonical WorkspaceRuntime events are the sole local execution-event source.
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
export type EmbeddedFirstPartyMcpLaunch = { baseUrl: string; userId?: string }

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
  return (configuredSessionAccessPolicy ?? managedWorkspaceSessionAccessPolicy()).sessionAuthority
}

export function configureEmbeddedWorkspaceRuntime(input: {
  opencodeRuntime?: OpenCodeRuntime
  connectionProviders?: readonly ConnectionProvider<unknown, unknown>[]
  resolveConnectionSecrets?: ConnectionSecretResolver
  routeContributions?: readonly WorkspaceRuntimeRouteContribution[]
  processObserver?: ProcessObserver
  /** Signed hosts inject their managed-private authority; unsigned desktop leaves this local. */
  sessionAccessPolicy?: WorkspaceRuntimeServerOptions["sessionAccessPolicy"]
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
            issuer: createRuntimeCredentialIssuer({
              runtimeId: crypto.randomUUID(),
              workspaceId: ws.id,
              ...(configuredFirstPartyMcpLaunch.userId ? { userId: configuredFirstPartyMcpLaunch.userId } : {}),
            }),
          },
        }
      : {}),
    // The observer persists control-plane session metadata. Conversation
    // delivery stays exclusively on WorkspaceRuntime's canonical runtime-event
    // stream and is never republished onto the control-plane bus.
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
    runtimeEventAuthorization: {
      authorizeParent: (_context, parentSessionId) => sessionAccess.exists(parentSessionId),
      resolveParentSessionId: (event) => sessionAccess.parentSessionIdFor(event.sessionId),
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
  await runtime.host.apply(await createClaxedoAppliedRuntimeConfig({
    workspaceDir: runtime.workspace.directory,
    workspaceId: runtime.workspace.id,
  }))
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

function disposeRuntime(runtime: EmbeddedRuntime): Promise<void> {
  const pending = retiring.get(runtime.workspace.id)
  if (pending) return pending
  if (hosts.get(runtime.workspace.id) === runtime) hosts.delete(runtime.workspace.id)
  const disposed = runtime.host.dispose()
  const done = Promise.all([
    disposed,
    // Config resolution and metadata projection begin outside the host's
    // request scope. Their consumers must finish before shared DB cleanup.
    Promise.allSettled([runtime.applying, runtime.reconcilingSessionMetadata]),
  ]).then(() => { runtime.diagnosticsOwner?.exit({ reason: "disposed" }) })
  retiring.set(runtime.workspace.id, done)
  void done.then(() => {
    if (retiring.get(runtime.workspace.id) === done) retiring.delete(runtime.workspace.id)
  }, () => { /* A failed retirement keeps its store root fenced. */ })
  return done
}

// A shared module needs a way to reach a LOCAL workspace's runtime, and this
// is the module that owns them. Installing the port here — at import time,
// beside the runtimes it serves — means any composition that can create an
// embedded runtime can also be reached through one, with no import from the
// shared side back into this deployment.

configureLocalWorkspaceRuntime({
  sessionAuthority: embeddedWorkspaceRuntimeSessionAuthority,
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
    await retirement
    assertCurrent()
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
  const created = createWorkspaceRuntimeApp(options(ws, {
    exists: (sessionId) => activeHost?.hasSession(sessionId) ?? false,
    parentSessionIdFor: (sessionId) => activeHost?.parentSessionIdFor(sessionId),
  }, harness))
  const runtime: EmbeddedRuntime = {
    ...created,
    workspace: ws,
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

export async function connectEmbeddedWorkspacePty(
  ws: Workspace,
  ptyId: string,
  socket: PtySocket,
  cursor?: number,
) {
  await ensureEmbeddedWorkspaceRuntime(ws)
  const info = Pty.get(ptyId)
  if (!info || !await ownsPath(ws, info.cwd)) {
    socket.close(1008, "Session not found")
    return undefined
  }
  return Pty.connect(ptyId, socket, cursor)
}

export async function syncEmbeddedWorkspaceRuntimes() {
  await Promise.allSettled([...hosts.values()].map((runtime) => configure(runtime)))
}

/**
 * Re-push every live runtime's config on an interval. The snapshot carries
 * broker placeholders that expire, so the push is what keeps the next turn's
 * spawn on a valid one. Returns the stop.
 */
export function startEmbeddedWorkspaceRuntimeConfigRenewal(intervalMs: number) {
  const timer = setInterval(() => { void syncEmbeddedWorkspaceRuntimes() }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}

export function shutdownEmbeddedWorkspaceRuntimes(): Promise<void> {
  shutdownGeneration++
  // `disposeRuntime` registers each disposal in `retiring`, so the loop's
  // promises were already awaited below — through the map rather than visibly.
  // Collecting them keeps every promise owned by the caller of this function.
  const disposals = Array.from(hosts.values(), (runtime) => disposeRuntime(runtime))
  const done = Promise.all(disposals.concat(Array.from(retiring.values()))).then(() => {})
  void done.catch(() => {})
  return done
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
  return { hosts: hosts.size, activeTurns, activeWrites, checkpointing }
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

export function releaseEmbeddedWorkspaceRuntime(workspaceId: string): Promise<void> {
  const runtime = hosts.get(workspaceId)
  return runtime ? disposeRuntime(runtime) : retiring.get(workspaceId) ?? Promise.resolve()
}
