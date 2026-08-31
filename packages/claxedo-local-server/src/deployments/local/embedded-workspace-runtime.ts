import path from "path"
import fs from "fs/promises"
import os from "node:os"
import {
  createPersistentTranscriptHandleStore,
  createTranscriptResolver,
  createWorkspaceRuntimeApp,
  managedWorkspaceSessionAccessPolicy,
  Pty,
  type ProcessObserver,
  type ProcessOwnerHandle,
  type WorkspaceRuntimeServerOptions,
} from "@claxedo/workspace-runtime"
import type { WorkspaceRuntimeRouteContribution } from "@claxedo/workspace-runtime/route-contribution"
import { agentExtensionStateRoot } from "@claxedo/agent-extensions"
import type { WorkspaceRuntimeExposure } from "@claxedo/workspace-runtime/exposure"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { configureLocalWorkspaceRuntime } from "@claxedo/server-core/workspace/local-runtime-port"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import type { WorkspaceAgentExtensionRecord } from "@claxedo/server-core/hosts/agent-extensions/workspace"
import type { AgentExtensionPolicyOverride } from "@claxedo/server-core/hosts/agent-extensions/runtime-config"
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
import type { PiModelBackendResolver } from "@claxedo/agent-sdk-runtime/adapters"
import { createOpenCodeServerConnectionProvider } from "@claxedo/opencode-server-adapter"
import { createLocalConnectionSecretResolver } from "@claxedo/server-core/agent-config/connection-secrets"
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
// The embedded workspace-runtime host rides one injected opencode transport
// (peer of the old opencodeUrl), threaded from the composition root. Defaults to
// the shared engine transport (embedded engine unless a composition root selects
// external-URL mode). In embedded mode this is the in-process engine handler; in
// external-URL mode it rewrites onto the configured URL.
let configuredOpencodeRequest: OpenCodeRequestFn = defaultOpencodeRequest
let configuredOpencodeCompat = true
let configuredProviderCatalog: WorkspaceRuntimeServerOptions["providerCatalog"] | undefined
let configuredPiModelBackend: PiModelBackendResolver | undefined
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
  opencodeRequest: OpenCodeRequestFn
  opencodeCompat?: boolean
  /**
   * The host's provider catalog for non-opencode harnesses, so a
   * workspace-scoped `/provider` answers the same catalog the compat router
   * serves unscoped. See `WorkspaceHostOptions.providerCatalog`.
   */
  providerCatalog?: WorkspaceRuntimeServerOptions["providerCatalog"]
  piModelBackend?: PiModelBackendResolver
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
}) {
  if (configuredOpencodeRequest !== input.opencodeRequest) {
    engineSessionEvents?.close()
    engineSessionEvents = undefined
  }
  configuredOpencodeRequest = input.opencodeRequest
  configuredOpencodeCompat = input.opencodeCompat ?? true
  configuredProviderCatalog = input.providerCatalog
  configuredPiModelBackend = input.piModelBackend
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

// Agent Extension replay bookkeeping (ownership ledger, lock, fetch cache)
// lives under Claxedo's data dir keyed by workspace id — NOT in the user's
// checkout. Generated skills/MCP/plugins still materialize into the workspace;
// only the record of what we own moves here, so a workspace the user moves or
// re-clones keeps its ownership history and `git status` stays clean.
function extensionStateRoot(ws: Workspace) {
  return agentExtensionStateRoot({ scope: "workspace", workspaceId: ws.id, dataRoot: dataDir() })
}

const embeddedRuntimeGuard = () => true

function options(
  ws: Workspace,
  sessionAccess: {
    exists(sessionId: string): boolean
    parentSessionIdFor(sessionId: string): string | undefined
  },
): WorkspaceRuntimeServerOptions & {
  exposure: WorkspaceRuntimeExposure
} {
  return {
    ...(configuredPiModelBackend ? { piModelBackend: configuredPiModelBackend } : {}),
    connectionProviders: configuredConnectionProviders,
    resolveConnectionSecrets: configuredConnectionSecretResolver,
    ...(configuredRouteContributions.length ? { routeContributions: configuredRouteContributions } : {}),
    ...(configuredProcessObserver ? { processObserver: configuredProcessObserver } : {}),
    ...(configuredSessionAccessPolicy ? { sessionAccessPolicy: configuredSessionAccessPolicy } : {}),
    ...(configuredOnTurnOutcome ? { onTurnOutcome: configuredOnTurnOutcome } : {}),
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
    agentExtensionStateRoot: extensionStateRoot(ws),
    corsOrigin: claxedoCorsOrigin,
    // Claxedo host decision, injected via configureEmbeddedWorkspaceRuntime
    // from the composition root (this module stays ambient-env-free).
    opencodeCompat: configuredOpencodeCompat,
    ...(configuredProviderCatalog ? { providerCatalog: configuredProviderCatalog } : {}),
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

function disposeRuntime(runtime: EmbeddedRuntime) {
  runtime.diagnosticsOwner?.exit({ reason: "disposed" })
  runtime.host.dispose()
}

// A shared module needs a way to reach a LOCAL workspace's runtime, and this
// is the module that owns them. Installing the port here — at import time,
// beside the runtimes it serves — means any composition that can create an
// embedded runtime can also be reached through one, with no import from the
// shared side back into this deployment.
configureLocalWorkspaceRuntime({
  async fetch(workspace: Workspace, request: Request) {
    const runtime = await ensureEmbeddedWorkspaceRuntime(workspace)
    return runtime.app.fetch(request)
  },
  async syncAgentExtensions(workspaceId, installs, options) {
    await syncEmbeddedWorkspaceRuntimeAgentExtensions(
      workspaceId,
      installs as WorkspaceAgentExtensionRecord[],
      (options ?? {}) as { policyOverrides?: AgentExtensionPolicyOverride[] },
    )
  },
})

export async function ensureEmbeddedWorkspaceRuntime(
  ws: Workspace,
  input: { config?: EmbeddedWorkspaceRuntimeConfigMode } = {},
) {
  const config = input.config ?? "sync"
  const hit = hosts.get(ws.id)
  if (hit) {
    if (hit.workspace.directory !== ws.directory) {
      disposeRuntime(hit)
      hosts.delete(ws.id)
    } else {
      if (config === "sync") await configure(hit)
      await reconcileSessionMetadata(hit)
      return hit
    }
  }

  let activeHost: EmbeddedRuntime["host"] | undefined
  const created = createWorkspaceRuntimeApp(options(ws, {
    exists: (sessionId) => activeHost?.hasSession(sessionId) ?? false,
    parentSessionIdFor: (sessionId) => activeHost?.parentSessionIdFor(sessionId),
  }))
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
  runtime.diagnosticsOwner?.update({ lifecycle: "ready" })
  await reconcileSessionMetadata(runtime)
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
    return
  }
  return Pty.connect(ptyId, socket as never, cursor)
}

export async function syncEmbeddedWorkspaceRuntimes() {
  await Promise.allSettled([...hosts.values()].map((runtime) => configure(runtime)))
}

export async function syncEmbeddedWorkspaceRuntimeAgentExtensions(
  workspaceId: string,
  installs: WorkspaceAgentExtensionRecord[],
  options: { policyOverrides?: AgentExtensionPolicyOverride[] } = {},
) {
  const runtime = hosts.get(workspaceId)
  if (!runtime) return
  await runtime.host.apply(await createClaxedoAppliedRuntimeConfig({
    workspaceDir: runtime.workspace.directory,
    workspaceId,
    workspaceInstalls: installs,
    ...(options.policyOverrides ? { policyOverrides: options.policyOverrides } : {}),
  }))
}

export function shutdownEmbeddedWorkspaceRuntimes() {
  for (const runtime of hosts.values()) disposeRuntime(runtime)
  hosts.clear()
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

export function releaseEmbeddedWorkspaceRuntime(workspaceId: string) {
  const runtime = hosts.get(workspaceId)
  if (!runtime) return
  disposeRuntime(runtime)
  hosts.delete(workspaceId)
}
