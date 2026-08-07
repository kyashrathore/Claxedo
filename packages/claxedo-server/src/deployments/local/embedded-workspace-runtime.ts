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
import { opencodeRequest as defaultOpencodeRequest, type OpenCodeRequestFn } from "../../opencode/engine"
import type { WorkspaceRuntimeExposure } from "@claxedo/workspace-runtime/exposure"
import { dataDir } from "../../platform/runtime/lib/paths"
import type { Workspace } from "../../workspace/store"
import type { WorkspaceAgentExtensionRecord } from "../../hosts/agent-extensions/workspace"
import type { AgentExtensionPolicyOverride } from "../../hosts/agent-extensions/runtime-config"
import { createClaxedoRuntimeExposure } from "../../hosts/workspace-runtime/exposure"
import { claxedoCorsOrigin } from "../../hosts/workspace-runtime/runtime-boot"
import { createClaxedoAppliedRuntimeConfig } from "../../hosts/workspace-runtime/runtime-config"
import { resolveClaxedoWorkspaceRuntimeTarget } from "../../hosts/workspace-runtime/target"
import { createOpencodeEvents, type OpencodeEvent, type OpencodeEventsHandle } from "../../opencode/events"
import type { PiModelBackendResolver } from "@claxedo/agent-sdk-runtime/adapters"

type EmbeddedRuntime = ReturnType<typeof createWorkspaceRuntimeApp> & {
  workspace: Workspace
  applying?: Promise<void>
  reconcilingSessionMetadata?: Promise<void>
  /**
   * Tap on this runtime's own `/global/event` SSE stream, forwarding
   * `session.created`/`session.updated` events to the host-configured
   * `onSessionMetaEvent` callback. See `configureEmbeddedWorkspaceRuntime`.
   */
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
// SSE event on THIS runtime's own `/global/event` stream
// (`RuntimeEventHub.publishGlobal`), never as an HTTP `PATCH /session/:id`.
// Nothing else in claxedo-server observes that per-workspace stream, so
// without this sink a harness session's title reverts to "Untitled" after a
// server restart (the control plane's `services.projectionStore` never
// learns the new title — see `ensureEmbeddedWorkspaceRuntime` below, which
// taps it via `createOpencodeEvents`).
let configuredOnSessionMetaEvent: ((event: OpencodeEvent) => void) | undefined
let configuredOnSessionMetaSnapshot: ((workspace: Workspace, sessions: unknown[]) => void | Promise<void>) | undefined

export function configureEmbeddedWorkspaceRuntime(input: {
  opencodeRequest: OpenCodeRequestFn
  opencodeCompat?: boolean
  piModelBackend?: PiModelBackendResolver
  routeContributions?: readonly WorkspaceRuntimeRouteContribution[]
  processObserver?: ProcessObserver
  onSessionMetaEvent?: (event: OpencodeEvent) => void
  onSessionMetaSnapshot?: (workspace: Workspace, sessions: unknown[]) => void | Promise<void>
}) {
  configuredOpencodeRequest = input.opencodeRequest
  configuredOpencodeCompat = input.opencodeCompat ?? true
  configuredPiModelBackend = input.piModelBackend
  configuredRouteContributions = input.routeContributions ?? []
  configuredProcessObserver = input.processObserver
  configuredOnSessionMetaEvent = input.onSessionMetaEvent
  configuredOnSessionMetaSnapshot = input.onSessionMetaSnapshot
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
  runtime.sessionEvents?.close()
  runtime.diagnosticsOwner?.exit({ reason: "disposed" })
  runtime.host.dispose()
}

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
  const created = createWorkspaceRuntimeApp(options(ws, configuredOpencodeRequest, {
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
  if (configuredOnSessionMetaEvent) {
    // Ride the same battle-tested SSE client used for the legacy
    // non-embedded `/global/event` bridge (`createOpencodeEvents`,
    // `server.ts`) instead of duplicating SSE-parsing/reconnect logic — just
    // pointed at THIS runtime's own in-process app (an ordinary in-memory
    // `fetch`, never a real socket) instead of a real network URL.
    const sessionEvents = createOpencodeEvents(async (req) => await runtime.app.fetch(req))
    sessionEvents.on(configuredOnSessionMetaEvent)
    runtime.sessionEvents = sessionEvents
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
