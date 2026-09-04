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
import type { OpenCodeRuntime } from "@claxedo/workspace-runtime/opencode"
import type { WorkspaceRuntimeExposure } from "@claxedo/workspace-runtime/exposure"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { globalBus } from "@claxedo/server-core/platform/runtime/lib/bus"
import { configureLocalWorkspaceRuntime } from "@claxedo/server-core/workspace/local-runtime-port"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import type { WorkspaceAgentExtensionRecord } from "@claxedo/server-core/hosts/agent-extensions/workspace"
import type { AgentExtensionPolicyOverride } from "@claxedo/server-core/hosts/agent-extensions/runtime-config"
import { createClaxedoRuntimeExposure } from "../../hosts/workspace-runtime/exposure"
import { claxedoCorsOrigin } from "@claxedo/server-core/hosts/workspace-runtime/cors-origin"
import { createClaxedoAppliedRuntimeConfig } from "@claxedo/server-core/hosts/workspace-runtime/runtime-config"
import { resolveClaxedoWorkspaceRuntimeTarget } from "../../hosts/workspace-runtime/target"
import type { OpencodeEvent } from "../../opencode/events"
import type { PiModelBackendResolver } from "@claxedo/agent-sdk-runtime/adapters"
import type { AgentTurnOutcome } from "@claxedo/agent-sdk-runtime"

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
let configuredOpenCodeRuntime: OpenCodeRuntime | undefined
let configuredProviderCatalog: WorkspaceRuntimeServerOptions["providerCatalog"] | undefined
let configuredPiModelBackend: PiModelBackendResolver | undefined
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
// Host-supplied sink for a harness session's async auto-title (and any other
// session.created/session.updated event). A harness session's title is
// re-emitted asynchronously — e.g. a post-turn ACP auto-title
// (`maybeEmitTitle` in `packages/agent-sdk-runtime/src/runtime.ts`) or
// OpenCode's own LLM-driven rename — and that update is published through
// THIS runtime's harness-neutral event hub. Nothing else in claxedo-server
// observes that hub, so
// without this sink a harness session's title reverts to "Untitled" after a
// server restart (the control plane's `services.projectionStore` never
// learns the new title).
let configuredOnSessionMetaEvent: ((event: OpencodeEvent) => void) | undefined

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
  opencodeRuntime: OpenCodeRuntime
  providerCatalog?: WorkspaceRuntimeServerOptions["providerCatalog"]
  piModelBackend?: PiModelBackendResolver
  routeContributions?: readonly WorkspaceRuntimeRouteContribution[]
  processObserver?: ProcessObserver
  /** Signed hosts inject their managed-private authority; unsigned desktop leaves this local. */
  sessionAccessPolicy?: WorkspaceRuntimeServerOptions["sessionAccessPolicy"]
  onSessionMetaEvent?: (event: OpencodeEvent) => void
  onSessionMetaCreated?: (workspace: Workspace, session: unknown) => Promise<void> | void
  onSessionMetaSnapshot?: (workspace: Workspace, sessions: unknown[]) => void | Promise<void>
  onTurnOutcome?: (input: { sessionId: string; assistantMessageId?: string; outcome: AgentTurnOutcome }) => void
}) {
  configuredOpenCodeRuntime = input.opencodeRuntime
  configuredProviderCatalog = input.providerCatalog
  configuredPiModelBackend = input.piModelBackend
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

/**
 * Bridge one embedded runtime's harness event envelope onto `globalBus` — the bus
 * behind the central `/global/event` + `/api/wr/events` stream, which is a
 * LOCAL workspace's ONLY live channel into claxedo-app (the app opens
 * workspace-scoped streams only for cloud/user-hosted kinds; see
 * `compat-routes/events.ts`).
 *
 * Every harness publishes `message.part.delta` / `message.updated` /
 * `session.error` events through this one hub. Before this
 * bridge those events reached only the per-directory dispatched stream that
 * nothing subscribes to, so a live ACP turn rendered in an open timeline only
 * after a manual refresh — the send-POST's own response stream was the
 * timeline's ONLY live input.
 *
 * The payload is stripped to `{type, properties}` because
 * `normalizeGlobalEvent` mints per-frame ids downstream,
 * and compat payload ids must not reach the wire (a part's deltas share one
 * payload id, which would defeat SSE resume ordering if used as the frame id).
 */
export function bridgeCompatEventToGlobalBus(event: {
  directory?: string
  payload: { type: string; properties?: unknown }
}) {
  globalBus.publish({
    directory: event.directory ?? "global",
    payload: {
      type: event.payload.type,
      properties: (event.payload.properties ?? {}) as Record<string, unknown>,
    },
  })
}

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
    ...(configuredOpenCodeRuntime ? { opencodeRuntime: configuredOpenCodeRuntime } : {}),
    ...(configuredPiModelBackend ? { piModelBackend: configuredPiModelBackend } : {}),
    ...(configuredRouteContributions.length ? { routeContributions: configuredRouteContributions } : {}),
    ...(configuredProcessObserver ? { processObserver: configuredProcessObserver } : {}),
    ...(configuredSessionAccessPolicy ? { sessionAccessPolicy: configuredSessionAccessPolicy } : {}),
    ...(configuredOnTurnOutcome ? { onTurnOutcome: configuredOnTurnOutcome } : {}),
    // The typed SDK adapter publishes through the same harness-neutral hub as
    // every other adapter. No raw engine event stream exists beside it.
    onCompatEvent: (event) => {
      bridgeCompatEventToGlobalBus(event)
      configuredOnSessionMetaEvent?.(event)
    },
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
    { headers: { "x-workspace-id": runtime.workspace.id, "x-opencode-directory": runtime.workspace.directory } },
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
