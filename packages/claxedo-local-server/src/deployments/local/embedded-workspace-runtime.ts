import path from "path"
import fs from "fs/promises"
import os from "node:os"
import {
  createPersistentTranscriptHandleStore,
  createTranscriptResolver,
  createWorkspaceRuntimeApp,
  Pty,
  type ProcessObserver,
  type ProcessOwnerHandle,
  type WorkspaceRuntimeServerOptions,
} from "@claxedo/workspace-runtime"
import type { WorkspaceRuntimeRouteContribution } from "@claxedo/workspace-runtime/route-contribution"
import { agentExtensionStateRoot } from "@claxedo/agent-extensions"
import { opencodeRequest as defaultOpencodeRequest, type OpenCodeRequestFn } from "@claxedo/server-core/opencode/engine"
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
import { createOpencodeEvents, type OpencodeEvent, type OpencodeEventsHandle } from "../../opencode/events"
import type { PiModelBackendResolver } from "@claxedo/agent-sdk-runtime/adapters"
import type { AgentTurnOutcome } from "@claxedo/agent-sdk-runtime"

type EmbeddedRuntime = ReturnType<typeof createWorkspaceRuntimeApp> & {
  workspace: Workspace
  applying?: Promise<void>
  reconcilingSessionMetadata?: Promise<void>
  /**
   * Bumped by everything that can change what this runtime's generic session
   * list answers. See `mutatesSessionInventory`.
   */
  sessionInventoryGeneration: number
  /** The generation the projection store was last reconciled against. */
  reconciledSessionInventoryGeneration?: number
  /** Lazy tap for engine-native SSE events that never enter the runtime hub. */
  sessionEvents?: OpencodeEventsHandle
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
let configuredPiModelBackend: PiModelBackendResolver | undefined
/**
 * Host-supplied route groups for every embedded runtime this process creates.
 *
 * Was a `workgraphRunBroker` option, which named a hosted capability inside the
 * desktop-local composition. Now it is a neutral list: the desktop passes
 * nothing and the self-hosted composition passes `self-hosted-capabilities.ts`,
 * so a build that contains no WorkGraph contains no path to it.
 */
let configuredRouteContributions: readonly WorkspaceRuntimeRouteContribution[] = []
let configuredProcessObserver: ProcessObserver | undefined
// Host-supplied sink for a harness session's async auto-title (and any other
// session.created/session.updated event). A harness session's title is
// re-emitted asynchronously — e.g. a post-turn ACP auto-title
// (`maybeEmitTitle` in `packages/agent-sdk-runtime/src/runtime.ts`) or
// opencode's own LLM-driven rename — and that update is published ONLY as an
// compatibility event from THIS runtime's own event hub, never as an HTTP
// `PATCH /session/:id`. Nothing else in claxedo-server observes that hub, so
// without this sink a harness session's title reverts to "Untitled" after a
// server restart (the control plane's `services.projectionStore` never
// learns the new title).
let configuredOnSessionMetaEvent: ((event: OpencodeEvent) => void) | undefined
let configuredOnSessionMetaCreated: ((workspace: Workspace, session: unknown) => Promise<void> | void) | undefined
let configuredOnSessionMetaSnapshot: ((workspace: Workspace, sessions: unknown[]) => void | Promise<void>) | undefined
let configuredOnTurnOutcome: ((input: { sessionId: string; assistantMessageId?: string; outcome: AgentTurnOutcome }) => void) | undefined

export function configureEmbeddedWorkspaceRuntime(input: {
  opencodeRequest: OpenCodeRequestFn
  opencodeCompat?: boolean
  piModelBackend?: PiModelBackendResolver
  routeContributions?: readonly WorkspaceRuntimeRouteContribution[]
  processObserver?: ProcessObserver
  onSessionMetaEvent?: (event: OpencodeEvent) => void
  onSessionMetaCreated?: (workspace: Workspace, session: unknown) => Promise<void> | void
  onSessionMetaSnapshot?: (workspace: Workspace, sessions: unknown[]) => void | Promise<void>
  onTurnOutcome?: (input: { sessionId: string; assistantMessageId?: string; outcome: AgentTurnOutcome }) => void
}) {
  configuredOpencodeRequest = input.opencodeRequest
  configuredOpencodeCompat = input.opencodeCompat ?? true
  configuredPiModelBackend = input.piModelBackend
  configuredRouteContributions = input.routeContributions ?? []
  configuredProcessObserver = input.processObserver
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
  opencodeRequest: OpenCodeRequestFn,
  sessionAccess: {
    exists(sessionId: string): boolean
    parentSessionIdFor(sessionId: string): string | undefined
  },
): WorkspaceRuntimeServerOptions & {
  exposure: WorkspaceRuntimeExposure
} {
  return {
    opencodeRequest,
    ...(configuredPiModelBackend ? { piModelBackend: configuredPiModelBackend } : {}),
    ...(configuredRouteContributions.length ? { routeContributions: configuredRouteContributions } : {}),
    ...(configuredProcessObserver ? { processObserver: configuredProcessObserver } : {}),
    ...(configuredOnTurnOutcome ? { onTurnOutcome: configuredOnTurnOutcome } : {}),
    ...(configuredOnSessionMetaEvent ? { onCompatEvent: configuredOnSessionMetaEvent } : {}),
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

/**
 * Whether a dispatched request can change what this runtime's GENERIC session
 * list answers — i.e. whether the metadata snapshot below has to run again.
 *
 * The runtime's own generic `GET /session` is store-only after the first
 * inventory import for a directory (`listSessions` in
 * `packages/workspace-runtime/src/workspace/runtime.ts`, which states the rule:
 * "Generic listing is store-only... Sessions created outside Claxedo after that
 * point arrive through the explicit `?harness=` refresh"). So the snapshot's
 * own upstream changes only when the runtime store changes, and only two kinds
 * of dispatched request change it:
 *
 *   - a MUTATION (anything but GET/HEAD) — `POST /session`,
 *     `PATCH /session/:id`, `DELETE /session/:id`, and any turn that creates a
 *     child session; and
 *   - an explicit `?harness=` / `?runner=` list — the one READ that binds
 *     sessions created outside Claxedo into the store.
 *
 * Everything the runtime changes on its own (an async auto-title, a session an
 * adapter creates mid-turn) is published as a `session.*` event and invalidates
 * through the event tap in `ensureEmbeddedWorkspaceRuntime`.
 */
export function mutatesSessionInventory(method: string, url: URL) {
  if (!["GET", "HEAD"].includes(method.toUpperCase())) return true
  return url.pathname === "/session" && !!(url.searchParams.get("harness") ?? url.searchParams.get("runner"))
}

function invalidateSessionInventory(runtime: EmbeddedRuntime | undefined) {
  if (runtime) runtime.sessionInventoryGeneration++
}

/**
 * Marks a workspace's session metadata snapshot stale.
 *
 * Called by the dispatch sites (`embedded()` in runtime-dispatch/internals.ts
 * and the local runtime port below) AFTER a request that satisfies
 * `mutatesSessionInventory` has been served, so the next request reconciles
 * against post-mutation state rather than the state the mutation replaced.
 */
export function invalidateEmbeddedWorkspaceSessionInventory(workspaceId: string) {
  invalidateSessionInventory(hosts.get(workspaceId))
}

const SESSION_LIFECYCLE_EVENTS = ["session.created", "session.updated", "session.deleted"]

function isSessionLifecycleEvent(event: OpencodeEvent) {
  return !!event.payload.type && SESSION_LIFECYCLE_EVENTS.includes(event.payload.type)
}

/**
 * Brings the control plane's session projection back in line with the runtime.
 *
 * Runs on runtime creation and then only when `sessionInventoryGeneration` has
 * moved — it used to run on EVERY proxied request, which cost a full
 * `GET /session` plus one `sync_session_meta` per session on every read
 * (measured 0.133 ms per session per request: 3.45 ms per read at 20 sessions,
 * ~60% of the request). Nothing is cached that the runtime could have changed
 * without saying so; see `mutatesSessionInventory` for why that set is closed.
 */
function reconcileSessionMetadata(runtime: EmbeddedRuntime) {
  if (!configuredOnSessionMetaSnapshot) return Promise.resolve()
  if (runtime.reconciledSessionInventoryGeneration === runtime.sessionInventoryGeneration) return Promise.resolve()
  const generation = runtime.sessionInventoryGeneration
  runtime.reconcilingSessionMetadata ??= Promise.resolve(runtime.app.fetch(new Request(
    `http://embedded-workspace-runtime.local/session?directory=${encodeURIComponent(runtime.workspace.directory)}`,
    { headers: { "x-workspace-id": runtime.workspace.id, "x-opencode-directory": runtime.workspace.directory } },
  ))).then(async (response) => {
    if (!response.ok) return
    const sessions = await response.json().catch(() => undefined)
    if (!Array.isArray(sessions)) return
    await configuredOnSessionMetaSnapshot?.(runtime.workspace, sessions)
    // Only the generation this snapshot actually read is reconciled. An
    // invalidation that landed WHILE it was in flight has already moved the
    // counter, so the next request reconciles again instead of recording
    // pre-mutation data as current. A failed or non-ok snapshot records
    // nothing and is retried by the next request, as before.
    runtime.reconciledSessionInventoryGeneration = generation
  }).catch(() => undefined).finally(() => {
    runtime.reconcilingSessionMetadata = undefined
  })
  return runtime.reconcilingSessionMetadata
}

function disposeRuntime(runtime: EmbeddedRuntime) {
  runtime.sessionEvents?.close()
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
    const response = await runtime.app.fetch(request)
    // Same rule as the HTTP dispatch site: a request that can change the
    // runtime's session inventory marks the snapshot stale once it has been
    // served, never before.
    if (mutatesSessionInventory(request.method, new URL(request.url))) invalidateSessionInventory(runtime)
    return response
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
  let startSessionEvents = () => {}
  const created = createWorkspaceRuntimeApp(options(ws, async (request) => {
    // Do not start the OpenCode SSE transport merely because the shell opened.
    // The first real engine mutation establishes the metadata tap instead.
    if (!["GET", "HEAD"].includes(request.method)) startSessionEvents()
    return configuredOpencodeRequest(request)
  }, {
    exists: (sessionId) => activeHost?.hasSession(sessionId) ?? false,
    parentSessionIdFor: (sessionId) => activeHost?.parentSessionIdFor(sessionId),
  }))
  const runtime: EmbeddedRuntime = {
    ...created,
    workspace: ws,
    // Generation 0 with nothing reconciled yet: the creation path below always
    // takes one snapshot, exactly as it did when every request took one.
    sessionInventoryGeneration: 0,
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
  if (configuredOnSessionMetaEvent) {
    // `onCompatEvent` observes adapter-produced runtime events directly. This
    // separate lazy stream owns engine-native `/global/event` events (such as
    // an asynchronous OpenCode title) that the injected request transport does
    // not republish into that hub.
    const sessionEvents = createOpencodeEvents(async (request) => runtime.app.fetch(request), { autoStart: false })
    sessionEvents.on((event) => {
      // The other half of the invalidation source: a session the runtime
      // created, renamed or removed on its own announces itself here rather
      // than as an HTTP mutation.
      if (isSessionLifecycleEvent(event)) invalidateSessionInventory(runtime)
      configuredOnSessionMetaEvent?.(event)
    })
    runtime.sessionEvents = sessionEvents
    startSessionEvents = sessionEvents.start
  }
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

export function releaseEmbeddedWorkspaceRuntime(workspaceId: string) {
  const runtime = hosts.get(workspaceId)
  if (!runtime) return
  disposeRuntime(runtime)
  hosts.delete(workspaceId)
}
