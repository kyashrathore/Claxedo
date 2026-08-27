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
import { globalBus } from "@claxedo/server-core/platform/runtime/lib/bus"
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
/**
 * Process-global tap on the ENGINE's own `/global/event` SSE stream (via the
 * configured opencode transport, one engine per process), forwarding ONLY the
 * engine's async session-meta events (`session.created`/`session.updated` —
 * e.g. its LLM-driven rename) to `configuredOnSessionMetaEvent`. Everything
 * else the sink needs arrives through each workspace host's `onCompatEvent`
 * hub subscription (see `options()`): the harness-neutral session service
 * publishes ACP/native-adapter turn events ONLY into the hub, and the
 * opencode compat adapter REPUBLISHES engine turn events into the hub once
 * real work starts — so the hub alone is the complete, exactly-once turn
 * stream for the control plane's turn meter. The engine's async rename is
 * the one event class that never reaches the hub, which is all this tap
 * carries.
 *
 * MEASURED, both failure modes: the pre-split bridge tapped the runtime's
 * multiplexing `/global/event` route, which with the always-live embedded
 * engine latched onto the engine stream even for an ACP-default workspace —
 * ACP turns then bypassed the meter entirely (tier-real claude-acp: three
 * visible turns, ZERO usage facts). Forwarding the engine tap unfiltered
 * alongside the hub double-counts opencode turns instead (tier-real
 * opencode: three turns, SIX facts — raw engine ids plus hub-republished
 * aliased ids). It starts lazily before the first engine mutation so read-only
 * shell hydration does not boot or pin the engine.
 */
let engineSessionEvents: OpencodeEventsHandle | undefined
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
  if (configuredOpencodeRequest !== input.opencodeRequest) {
    engineSessionEvents?.close()
    engineSessionEvents = undefined
  }
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

function startEngineSessionEvents() {
  if (engineSessionEvents || !configuredOpencodeCompat || !configuredOnSessionMetaEvent) return
  const events = createOpencodeEvents(configuredOpencodeRequest, { autoStart: false })
  events.on((event) => {
    const type = event.payload.type
    if (type !== "session.created" && type !== "session.updated") return
    configuredOnSessionMetaEvent?.(event)
  })
  engineSessionEvents = events
  events.start()
}

const runtimeOpencodeRequest: OpenCodeRequestFn = (request) => {
  if (request.method !== "GET" && request.method !== "HEAD") startEngineSessionEvents()
  return configuredOpencodeRequest(request)
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
 * Bridge one embedded runtime's compat-hub envelope onto `globalBus` — the bus
 * behind the central `/global/event` + `/api/wr/events` stream, which is a
 * LOCAL workspace's ONLY live channel into claxedo-app (the app opens
 * workspace-scoped streams only for cloud/user-hosted kinds; see
 * `compat-routes/events.ts`).
 *
 * The engine's own stream is already bridged (`upstreamEvents.on` in each
 * deployment), but that carries ONLY engine-native sessions: an ACP harness
 * turn (claude/codex) publishes its `message.part.delta` / `message.updated` /
 * `session.error` compat events exclusively through this hub. Before this
 * bridge those events reached only the per-directory dispatched stream that
 * nothing subscribes to, so a live ACP turn rendered in an open timeline only
 * after a manual refresh — the send-POST's own response stream was the
 * timeline's ONLY live input.
 *
 * No double-apply with the engine bridge: for a native-engine workspace the
 * runtime's `/global/event` route PROXIES the engine's stream precisely
 * because native traffic is NOT on this hub (see the "Observe the hub itself"
 * note in `workspace-runtime/src/workspace/runtime.ts`), so the two producers
 * cover disjoint session populations.
 *
 * The payload is stripped to `{type, properties}` to match the engine bridge's
 * proven wire shape — `normalizeGlobalEvent` mints per-frame ids downstream,
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
    // Hub-side compat events: the complete, exactly-once turn stream — the
    // harness-neutral session service publishes ACP/native-adapter turns
    // here, and the opencode compat adapter republishes engine turns here
    // once real work starts. Forwarded to the same host sink the (session-
    // meta-only) engine tap feeds; see `engineSessionEvents` for why the
    // split is exactly this way.
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
  const created = createWorkspaceRuntimeApp(options(ws, runtimeOpencodeRequest, {
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
