import { Log } from "../log"
import fs from "fs"
import path from "path"
import {
  connectionIdForHarness,
  createAcpConnectionProvider,
  createAgentRuntime,
  createConnectionProviderRegistry,
  type AgentRuntime,
  type AgentSession,
  type AgentMessage,
  type SessionConfig,
  type SessionConfigUpdate,
  type SessionHarness,
  type ConnectionProvider,
  type ConnectionSecretResolver,
  type HarnessConnectionDescriptor,
  type AgentProcessObserver,
  type AgentTurnOutcome,
} from "@claxedo/agent-sdk-runtime"
import {
  ClaudeHarnessAdapter,
  CodexHarnessAdapter,
  CursorHarnessAdapter,
  PiHarnessAdapter,
  hasAdapterCapability,
  type AgentHarnessAdapter,
  type AgentHarnessAdapterHealth,
  type AgentMessagePage,
  type AgentMessagePageInput,
  type AgentRuntimeStoreWithRecovery,
} from "@claxedo/agent-sdk-runtime/adapters"
import { OpenCodeSdkHarnessAdapter, WorkspaceScope, type OpenCodeRuntime } from "../opencode/index"
import type { CompatEnvelope } from "@claxedo/agent-sdk-runtime/compat-events"
import type { SubagentAdmissionStore } from "@claxedo/agent-sdk-runtime/subagent-admission"
import type { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { workspaceCapabilities } from "../capabilities"
import { runGit } from "../git"
import { createRuntimeEventHub, type RuntimeEventEnvelope, type RuntimeEventHub } from "../runtime-event-hub"
import type { ProcessObserver } from "../managed-processes/process-observer"
import { RuntimeStore, type QueuedPromptRecord } from "../store"
import { assertTarget, withWorkspaceTarget, workspaceDir, workspaceId, type WorkspaceTarget } from "../target"
import { normalizeRuntimeSnapshot, requestedSessionHarness, RUNTIME_NATIVE_HARNESS_IDS, RuntimeConfigApplyError, type AppliedRuntimeSnapshot, type RuntimeConnectionDescriptor, type RuntimeHarnessSelection, type RuntimeSnapshot, type ProviderProjection } from "../routes/config"
import { num, rec, str } from "../json-value"
import { AgentRuntimeContractError, assertAgentExecutionBinding } from "@claxedo/agent-runtime-contract"
import { assertWorkspaceRuntimeExposure } from "../exposure"
import { SessionRoutes } from "../routes/session"
import type { QueuedPromptStore } from "../routes/session-queued-prompts"
import { sessionStatusSnapshot } from "../routes/session-status-snapshot"
import {
  mountWorkspaceAgentHooks,
  mountWorkspaceCore,
  mountWorkspaceEvents,
  mountWorkspaceProcess,
  mountWorkspacePty,
  type MountedWorkspaceEvents,
} from "./core"
import type { RuntimeConfigApplyStatus, WorkspaceHost, WorkspaceHostMountOptions } from "./host"
import { firstPartyMcpAdapterConfig, firstPartyMcpServerFor, type WorkspaceFirstPartyMcpLaunchOptions } from "../first-party-mcp/index"
import { createWorkspaceEventFramesTap, type WorkspaceEventParents } from "../routes/events"
import type { WorkspaceTranscriptRoutesOptions } from "./core"
import {
  managedWorkspaceSessionAccessPolicy,
  type SessionAccessPolicy,
} from "../session-access-policy"
import { SessionRollbackError } from "../session-rollback-error"
import { WorkspaceHarnessUnavailableError } from "../harness-unavailable-error"

/**
 * The store surface the workspace-runtime engine actually consumes — derived
 * from the real calls in this file, NOT from the concrete `RuntimeStore` class.
 *
 * It is the harness-adapter store contract (`AgentRuntimeStoreWithRecovery`,
 * what each adapter's `createStore` must return) narrowed on the read methods
 * the engine's own session-config store path relies on (`getSession`,
 * `getMessages`, and optional bounded `getMessagePage`), plus
 * `getSessionMaxSeq` (used by the message-snapshot route).
 * `recoverBusySessions` is optional: the host calls it once when opening its
 * shared store, so a host-supplied factory need not implement it. A
 * host may back the runtime with any store that satisfies this shape — e.g. the
 * in-memory store from `@claxedo/agent-sdk-runtime/stores/memory`.
 */

export type WorkspaceRuntimeStore =
  & Omit<AgentRuntimeStoreWithRecovery, "getSession" | "getMessages" | "listSessions" | "bindSession" | "updateSessionConfig">
  & {
    getSession(id: string): AgentSession | null
    getMessages(id: string): AgentMessage[]
    listSessions(directory: string): AgentSession[]
    getMessagePage?: (id: string, page: AgentMessagePageInput) => AgentMessagePage | undefined
    getSessionMaxSeq(sessionId: string): number
    getSessionFencingToken?: (sessionId: string) => number | undefined
    listSubagents: (parentSessionId: string) => unknown[]
    /** Per-store secret keyed material; child ids derived from `clientRequestId` need it. */
    runtimeSecret?: (name: string) => string
    listPendingSubagentWakes?: () => Array<{ parentSessionId: string; subagentKey: string; childSessionId: string; directory: string }>
    /**
     * Durable prompts waiting for a running turn. All four are optional
     * together: a store that cannot persist them leaves the queue in the
     * request that holds it.
     */
    queuePrompt?: (input: Omit<QueuedPromptRecord, "seq" | "queuedAt">) => QueuedPromptRecord
    deleteQueuedPrompt?: (sessionId: string, seq: number) => void
    replaceQueuedPromptParts?: (sessionId: string, seq: number, parts: QueuedPromptRecord["parts"]) => boolean
    listQueuedPrompts?: () => QueuedPromptRecord[]
    bindSession(input: {
      sessionId: string
      workspaceId?: string
      directory: string
      connectionId?: string
      upstreamSessionId?: string
      agentSessionId: string
      title?: string
      ownerKey?: string | null
      parentSessionId?: string
      createdAt?: number
      updatedAt?: number
    }): void
    updateSessionConfig(
      id: string,
      update: SessionConfigUpdate,
      input?: { directory?: string },
    ): SessionConfig | null | undefined
    recoverBusySessions?: () => unknown
    flush?: () => void
    close?: () => void
  }

/**
 * Seam: a host-injected factory producing the runtime store for a given
 * `storeRoot`. The kit default constructs the SQLite-backed `RuntimeStore`.
 * The host owns recovery and closing of the shared store. The factory must
 * be a pure constructor: it receives `{ storeRoot }` and returns a fresh
 * store; it must not itself run recovery.
 */
export type WorkspaceRuntimeStoreFactory = (input: { storeRoot?: string }) => WorkspaceRuntimeStore

export type WorkspaceHostOptions = {
  /** Optional, local-only lifecycle observer supplied by an embedding host. */
  processObserver?: ProcessObserver
  /** Host observer for the durable turn.finish outcome after store commit. */
  onTurnOutcome?: (input: { sessionId: string; assistantMessageId?: string; outcome: AgentTurnOutcome }) => void
  /** Direct observer for canonical compatibility events produced by this host. */
  onCompatEvent?: (event: CompatEnvelope) => void
  /**
   * Direct observer for the canonical runtime events produced by this host.
   *
   * The compat bus carries session metadata; this one carries what the harness
   * said during the turn. A host that has to keep something a harness reports —
   * a plan's quota windows outliving the session that heard about them — reads
   * it here rather than off the SSE stream.
   */
  onRuntimeEvent?: (event: RuntimeEventEnvelope) => void
  /** Parent lookup for scoping a subagent child's frames as its parent's; defaults to this host's own store. */
  sessionParents?: WorkspaceEventParents
  /** Host-mediated resolver endpoint for opaque file-backed transcript handles. */
  transcripts?: WorkspaceTranscriptRoutesOptions
  /** Host-owned projection write that completes before the created lifecycle event. */
  afterCreateSession?: (input: { directory: string; session: unknown }) => Promise<void> | void
  /** Private-session authority selected by the host composition. */
  sessionAccessPolicy?: SessionAccessPolicy
  /**
   * The sole native OpenCode rail: the process-owned public embedded SDK. The
   * kit never constructs it — a host composes one SDK owner per process and
   * injects it here, and `opencode` selections fail loudly without it.
   */
  opencodeRuntime?: OpenCodeRuntime
  harness?: RuntimeHarnessSelection
  /** Installed generic connection providers. ACP is installed by default. */
  connectionProviders?: readonly ConnectionProvider<unknown, unknown>[]
  /** Host-owned resolver for opaque descriptor secret references. */
  resolveConnectionSecrets?: ConnectionSecretResolver
  target?: WorkspaceTarget
  storeRoot?: string
  /**
   * Durable config-apply receipts (`accepted-snapshot.json`,
   * `apply-status.json`). OFF by default: the live `configApply` status is
   * already exposed through `host.detail()` and `/api/wr/health`, so receipt
   * files are a diagnostics opt-in, not the source of truth. Hosts that need
   * durable receipts (cloud/sandbox postmortems) pass a directory they own —
   * never derived from the workspace checkout.
   */
  configApplyReceiptDir?: string
  eventHub?: RuntimeEventHub
  /**
   * Host-supplied shared store factory. Defaults to the SQLite-backed
   * `RuntimeStore`. See {@link WorkspaceRuntimeStoreFactory}.
   */
  storeFactory?: WorkspaceRuntimeStoreFactory
  subagentAdmission?: SubagentAdmissionStore
  /**
   * Host-supplied harness-adapter registry. `createAdapter` dispatches through
   * it (first matching entry wins). Defaults to
   * {@link defaultWorkspaceHarnessRegistry}. Must be STABLE for the host
   * lifetime — the engine caches adapters by `adapterKey` and owns config-apply
   * serialization and active-turn drain regardless of the registry (R2).
   */
  harnesses?: WorkspaceHarnessRegistry
  /**
   * The first-party MCP entry every launched session receives: the loopback
   * origin serving `/api/claxedo/mcp` and this runtime's credential issuer.
   * Absent, no harness receives the entry — the host that mounts the route is
   * the one that enables injection.
   */
  firstPartyMcpLaunch?: WorkspaceFirstPartyMcpLaunchOptions
}

const RUNNER_REPLACEMENT_DRAIN_TIMEOUT_MS = 1_000

type ActiveTurn = {
  sessionId: string
  directory: string
  controller: AbortController
  done: Promise<void>
  finish: () => void
}

type RuntimeRunner = SessionHarness
const NATIVE_HARNESS_ADAPTERS = {
  claude: ClaudeHarnessAdapter,
  codex: CodexHarnessAdapter,
  cursor: CursorHarnessAdapter,
  pi: PiHarnessAdapter,
} as const

function configuredConnection(harness: RuntimeRunner) {
  return harness.access === "connection"
}

function nativeSdk(harness: RuntimeRunner): harness is RuntimeRunner & { id: keyof typeof NATIVE_HARNESS_ADAPTERS; access: "native" } {
  return harness.access === "native" && harness.id in NATIVE_HARNESS_ADAPTERS
}

function sessionRowConfigPatch(session: unknown) {
  const row = rec(session)
  const modelInput = rec(row?.model)
  const model = modelInput && {
    providerID: str(modelInput.providerID),
    modelID: str(modelInput.modelID) ?? str(modelInput.id),
    variant: str(modelInput.variant),
  }
  return {
    ...(model?.providerID && model.modelID ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
    ...(model?.variant ? { variant: model.variant } : {}),
    ...(str(row?.agent) ? { agent: str(row?.agent) } : {}),
  } satisfies Partial<SessionConfig>
}

function mergeRecoveredSessionConfig(config: SessionConfig, patch: Partial<SessionConfig>) {
  if (config.model && config.agent && config.variant !== undefined) return config
  const next = {
    ...config,
    ...(!config.model && patch.model ? { model: patch.model } : {}),
    ...((config.variant === undefined || config.variant === null) && patch.variant ? { variant: patch.variant } : {}),
    ...((config.agent === undefined || config.agent === null) && patch.agent ? { agent: patch.agent } : {}),
  }
  if (next === config || (next.model === config.model && next.agent === config.agent && next.variant === config.variant)) return config
  return next
}

function harnessKey(harness: RuntimeRunner) {
  return `${harness.id}:${harness.access}`
}

function runnerForSelection(selection: RuntimeHarnessSelection): RuntimeRunner {
  return selection.kind === "native"
    ? { id: selection.harnessId, access: "native" }
    : { id: selection.connectionId, access: "connection" }
}

function selectionForRunner(runner: RuntimeRunner): RuntimeHarnessSelection {
  // `find` over the canonical id list produces the literal type; a membership
  // test would leave `runner.id` a bare `string` and force an assertion.
  const harnessId = runner.access === "native"
    ? RUNTIME_NATIVE_HARNESS_IDS.find((id) => id === runner.id)
    : undefined
  if (harnessId) return { kind: "native", harnessId }
  if (runner.access === "connection") return { kind: "connection", connectionId: runner.id }
  throw new WorkspaceHarnessUnavailableError(runner)
}

function errorMessage(input: unknown) {
  if (input instanceof Error) return input.message
  const row = rec(input)
  if (!row) return String(input)
  const message = str(rec(row.data)?.message) ?? str(row.message)
  if (message) return message
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}

function harnessConfigOptionsErrorMessage(input: {
  harness: RuntimeRunner
  cause: unknown
}) {
  const message = errorMessage(input.cause)
  return message
}

function runtimeConfigSnapshotMetadata(snapshot: AppliedRuntimeSnapshot) {
  return {
    version: snapshot.version,
    ...(snapshot.defaultHarness ? { defaultHarness: snapshot.defaultHarness } : {}),
    connections: snapshot.connections.map(({ connectionId, providerKey, configRevision, enabled }) => ({
      connectionId,
      providerKey,
      configRevision,
      enabled,
    })),
    mcp: { keys: Object.keys(snapshot.mcp).sort() },
    auth: { keys: Object.keys(snapshot.auth).sort() },
    ...(snapshot.harnessLaunch ? { harnessLaunch: Object.keys(snapshot.harnessLaunch).sort() } : {}),
    ...(snapshot.workspaceHarnessEnabled !== undefined ? { workspaceHarnessEnabled: snapshot.workspaceHarnessEnabled } : {}),
    ...(snapshot.commands ? { commands: snapshot.commands.map((command) => command.name).sort() } : {}),
  }
}

async function persistRuntimeConfigApplyStatus(input: {
  receiptDir?: string
  status: RuntimeConfigApplyStatus
  snapshot?: AppliedRuntimeSnapshot
}) {
  // Receipts are opt-in. Without a host-supplied directory there is nothing to
  // write: `configApply` is already live on `host.detail()`/`/api/wr/health`,
  // and deriving a path from the workspace would put local operational state
  // (revision counters, timestamps) in the user's source tree.
  if (!input.receiptDir) return
  try {
    const root = input.receiptDir
    await fs.promises.mkdir(root, { recursive: true, mode: 0o755 })
    if (input.snapshot) {
      await fs.promises.writeFile(
        path.join(root, "accepted-snapshot.json"),
        JSON.stringify({
          revision: input.status.revision,
          acceptedAt: input.status.acceptedAt,
          snapshot: runtimeConfigSnapshotMetadata(input.snapshot),
        }, null, 2) + "\n",
        { mode: 0o600 },
      )
    }
    await fs.promises.writeFile(
      path.join(root, "apply-status.json"),
      JSON.stringify(input.status, null, 2) + "\n",
      { mode: 0o600 },
    )
  } catch {
    throw new RuntimeConfigApplyError(
      "runtime_config_apply_status_persist_failed",
      "Runtime config apply status could not be persisted",
      500,
    )
  }
}

function runtimeConfigApplyError(input: unknown): RuntimeConfigApplyStatus["error"] {
  if (input instanceof RuntimeConfigApplyError) {
    return {
      code: input.code,
      message: input.message,
      ...(input.details ? { details: input.details } : {}),
    }
  }
  return {
    code: "runtime_snapshot_apply_failed",
    message: "Runtime config apply failed",
  }
}

const defaultStoreFactory: WorkspaceRuntimeStoreFactory = ({ storeRoot }) => new RuntimeStore(storeRoot)

function resolveStoreFactory(options: WorkspaceHostOptions): WorkspaceRuntimeStoreFactory {
  const factory = options.storeFactory ?? defaultStoreFactory
  if (!options.onTurnOutcome) return factory
  return (input) => {
    const store = factory(input)
    const finish = store.finishTurn?.bind(store)
    if (finish) {
      store.finishTurn = (value) => {
        const finished = finish(value)
        const session = store.getSession(value.sessionId) as { lastTurn?: AgentTurnOutcome } | null
        options.onTurnOutcome?.({
          ...value,
          ...(value.assistantMessageId ?? session?.lastTurn?.assistantMessageId
            ? { assistantMessageId: value.assistantMessageId ?? session?.lastTurn?.assistantMessageId }
            : {}),
        })
        return finished
      }
    }
    return store
  }
}

/** Input handed to a registry entry's `create` when the engine builds an adapter. */
export type WorkspaceHarnessAdapterInput = {
  /** The runner the engine wants an adapter for. */
  runner: RuntimeRunner
  /** The host options the engine was constructed with. */
  options: WorkspaceHostOptions
  /** Borrowed host store: adapters must not recover or close it. */
  store: WorkspaceRuntimeStore
}

/**
 * One catalog entry: a predicate on the runner and the adapter constructor to
 * use when it matches. Entries are consulted in order; the first match wins.
 */
export type WorkspaceHarnessRegistryEntry = {
  /** Selects this entry when it returns true for the requested runner. */
  match: (runner: RuntimeRunner) => boolean
  /** Constructs the adapter. The engine owns everything around this call —
   *  caching (adapterKey), config-apply serialization, active-turn drain, and
   *  `recoverBusySessions` on the shared host store — regardless of the
   *  registry (R2). */
  create: (input: WorkspaceHarnessAdapterInput) => AgentHarnessAdapter
}

/**
 * A harness-adapter registry: an ordered list of entries the engine dispatches
 * through in {@link createAdapter}. It must be STABLE for the host lifetime —
 * the engine caches adapters by `adapterKey` and reuses them across turns, so a
 * registry that changes between calls would produce inconsistent adapters for
 * the same runner. The kit default is {@link defaultWorkspaceHarnessRegistry};
 * a host may supply its own via `WorkspaceHostOptions.harnesses`.
 */
export type WorkspaceHarnessRegistry = WorkspaceHarnessRegistryEntry[]

/**
 * Native SDK adapter catalog. Generic connections resolve through the
 * connection-provider registry and never enter this dispatch table.
 */
export function defaultWorkspaceHarnessRegistry(): WorkspaceHarnessRegistry {
  return [
    {
      match: (runner) => nativeSdk(runner),
      create: ({ runner, options, store }) => {
        // `match` narrowed this runner, but the registry hands `create` the
        // unnarrowed entry, so the guard is re-applied here rather than
        // asserting the key and letting an unknown id fail as "not a constructor".
        if (!nativeSdk(runner)) throw new WorkspaceHarnessUnavailableError(runner)
        const Adapter = NATIVE_HARNESS_ADAPTERS[runner.id]
        const transcripts = options.transcripts
        // `register` is optional on the resolver, so it is bound (not detached)
        // and its presence is what gates the registrar below.
        const resolver = transcripts?.resolver
        const registerTranscript = resolver?.register?.bind(resolver)
        return new Adapter({
          store,
          ...(options.storeRoot ? { storeRoot: options.storeRoot } : {}),
          // Pi's profile holds `models.json`, and that file carries the broker
          // placeholder; without a store root to scope it, the workspace id is
          // what keeps one workspace's binding out of another's turns.
          ...(runner.id === "pi" && options.target ? { workspaceId: options.target.workspaceId } : {}),
          ...(options.eventHub ? { eventHub: options.eventHub } : {}),
          ...(options.processObserver ? { processObserver: agentProcessObserver(options.processObserver) } : {}),
          ...(runner.id === "cursor" && registerTranscript && transcripts ? {
            transcriptRegistrar: {
              register: (input) => registerTranscript({
                workspaceId: transcripts.workspaceId,
                ...input,
              }),
              open: (input) => transcripts.resolver.open({
                workspaceId: transcripts.workspaceId,
                ...input,
              }),
            },
          } : {}),
        })
      },
    },
    {
      match: (runner) => runner.access === "native" && runner.id === "opencode",
      create: ({ options }) => {
        if (!options.opencodeRuntime) {
          throw new Error("Native OpenCode requires the process-owned public embedded SDK runtime")
        }
        return new OpenCodeSdkHarnessAdapter({
          runtime: options.opencodeRuntime,
          workspaceID: options.target?.workspaceId ?? "workspace-runtime",
          directory: options.target?.directory ?? workspaceDir(),
        })
      },
    },
  ]
}

function agentProcessObserver(observer: ProcessObserver): AgentProcessObserver {
  return {
    register(descriptor) {
      const handle = observer.register({
        ownerId: descriptor.ownerId,
        ownerGeneration: descriptor.launchId,
        launchId: descriptor.launchId,
        kind: descriptor.role === "tool" ? "cli" : descriptor.role,
        role: descriptor.role === "tool" ? "cli" : descriptor.role,
        label: descriptor.label,
        ...(descriptor.pid ? { pid: descriptor.pid } : {}),
        ...(descriptor.parentOwnerId ? { parentOwnerId: descriptor.parentOwnerId } : {}),
        ...(descriptor.workspaceId ? { workspaceId: descriptor.workspaceId } : {}),
        ...(descriptor.directory ? { directory: descriptor.directory } : {}),
        ...(descriptor.sessionId ? { sessionId: descriptor.sessionId } : {}),
        harnessId: descriptor.harnessId,
        access: descriptor.locality === "remote" ? "remote" : "local",
        attributionConfidence: descriptor.confidence,
      })
      return {
        update(event) {
          handle.update({
            lifecycle: event.lifecycle,
            ...(event.pid ? { pid: event.pid } : {}),
          })
        },
        exit: (event) => handle.exit(event),
      }
    },
  }
}

function resolveHarnessRegistry(options: WorkspaceHostOptions): WorkspaceHarnessRegistry {
  return options.harnesses ?? defaultWorkspaceHarnessRegistry()
}

function createAdapter(
  harness: RuntimeRunner,
  options: WorkspaceHostOptions,
  registry: WorkspaceHarnessRegistry,
  store: WorkspaceRuntimeStore,
): AgentHarnessAdapter {
  const entry = registry.find((item) => item.match(harness))
  if (!entry) {
    // Reached for any runner no registry entry claims — including an unknown
    // harness id against the default registry. Deliberate: an unrecognized
    // runner must fail loudly here.
    throw new Error(`No workspace harness adapter registered for runner "${harness.id}:${harness.access}"`)
  }
  return entry.create({ runner: harness, options, store })
}

function scopedToolPrompt(
  sessionId: string,
  registration: {
    callbackUrl: string
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
  },
) {
  return [
    "<claxedo_scoped_session_tools>",
    "These trusted tools apply only to the current Session. Their callback derives tenant, workspace, Stream, Task, Run, and lease identity from a nonce-bound host binding; never add or change those identities.",
    "Invoke a tool from the sandbox shell by POSTing JSON shaped as {\"sessionID\",\"name\",\"toolCallID\",\"input\"} to the callback URL. Use a stable unique toolCallID and reuse it if the response is lost.",
    `Session ID: ${JSON.stringify(sessionId)}`,
    `Callback URL: ${JSON.stringify(registration.callbackUrl)}`,
    "Available tools:",
    ...registration.tools.map((tool) => `${tool.name}: ${tool.description}\nInput schema: ${JSON.stringify(tool.inputSchema)}`),
    "Use progress tools only at meaningful logical boundaries. If a completion tool is available, call it with evidence before giving the final response.",
    "</claxedo_scoped_session_tools>",
  ].join("\n")
}

function requestDirectory(c: any) {
  return assertTarget(c.req.query("directory") || workspaceDir())
}

async function gitLine(directory: string, args: string[]) {
  try {
    return (await runGit(args, directory)).trim() || undefined
  } catch {
    return undefined
  }
}

async function localVcsInfo(directory: string) {
  const [branch, remoteHead] = await Promise.all([
    gitLine(directory, ["branch", "--show-current"]),
    gitLine(directory, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
  ])
  return {
    ...(branch ? { branch } : {}),
    ...(remoteHead ? { default_branch: remoteHead.replace(/^origin\//, "") } : {}),
  }
}

function mcpStatus(config: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(config).map((name) => [name, { status: "disabled" }]))
}

function sameRuntimeMcp(a: Record<string, unknown>, b: Record<string, unknown>) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Order-independent canonical form of a snapshot, used to detect a re-apply of
 * config that is already live. Object key order varies with how a host builds
 * the snapshot (control-plane merge order, JSON round-trips), so a plain
 * `JSON.stringify` would report a difference where none exists.
 *
 * Everything the apply path acts on is included — harness, model, mcp, auth,
 * harness launch options, commands, and `workspaceHarnessEnabled`. Nothing else is:
 * the signature deliberately carries no revision, timestamp, or apply state, or
 * it could never compare equal to itself.
 */
function canonicalJson(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(canonicalJson)
  const row = rec(input)
  if (row) {
    return Object.fromEntries(
      Object.entries(row)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, canonicalJson(value)]),
    )
  }
  return input
}

function runtimeSnapshotSignature(snapshot: AppliedRuntimeSnapshot) {
  return JSON.stringify(canonicalJson(snapshot))
}

export function createWorkspaceHost(options: WorkspaceHostOptions = {}): WorkspaceHost {
  const eventHub = options.eventHub ?? createRuntimeEventHub()
  // The hub is the canonical producer shared by every adapter.
  // The workspace's stream subscribes to the process-global runtime bus; a
  // disposed runtime must let that subscription go.
  let closeEvents: () => void = () => {}
  // A host's frame tap outlives any one mount: a consumer may hold it across
  // `mount`, and it forwards the mounted stream's own frames rather than
  // opening a second subscription to the hub or the bus.
  const hostFrames = createWorkspaceEventFramesTap()
  // A subagent child's frames are scoped as its parent's on the workspace
  // stream; the store that filed the child knows the parent.
  const sessionParents: WorkspaceEventParents = {
    parentSessionIdFor: (sessionId) => (store().getSession(sessionId) as { parentID?: string | null } | null)?.parentID ?? undefined,
  }
  const cleanupCompatObserver = options.onCompatEvent
    ? eventHub.subscribeGlobal(options.onCompatEvent)
    : () => undefined
  const cleanupRuntimeObserver = options.onRuntimeEvent
    ? eventHub.subscribeRuntime(options.onRuntimeEvent)
    : () => undefined
  // `store()` is the host's own session-config store. Bound lazily: `store()`
  // opens SQLite on first use, and an idle host never opens it.
  const hostOptions = {
    ...options,
    eventHub,
    subagentAdmission: options.subagentAdmission ?? {
      admit: (input: Parameters<SubagentAdmissionStore["admit"]>[0]) => subagentStore().admit(input),
      markPublished: (parentSessionId: string, observationId: string) =>
        subagentStore().markPublished(parentSessionId, observationId),
    },
  }
  let runner = options.harness ? runnerForSelection(options.harness) : undefined
  let state: "ready" | "applying" | "error" = "ready"
  let err = ""
  let enabled = false
  let configApplyRevision = 0
  let configApply: RuntimeConfigApplyStatus = { state: "idle", revision: 0 }
  // Signature of the last SUCCESSFULLY applied snapshot. Set only after an
  // apply completes, and cleared on failure, so a retry after a failed apply
  // always re-runs rather than being skipped as "already applied".
  let appliedSignature: string | undefined
  let adapter: AgentHarnessAdapter | undefined
  let currentMcp: Record<string, unknown> = {}
  let currentAuthRaw: Record<string, ProviderProjection> = {}
  let currentHarnessLaunch: Record<string, Record<string, unknown>> = {}
  let applyQueue = Promise.resolve()
  const storeFactory = resolveStoreFactory(options)
  // Resolved once and reused: the registry must be stable for the host lifetime
  // (adapter cache identity depends on it — R2).
  const harnessRegistry = resolveHarnessRegistry(options)
  const connectionRegistry = createConnectionProviderRegistry(
    options.connectionProviders ?? [createAcpConnectionProvider()],
  )
  let sessionConfigStore: WorkspaceRuntimeStore | undefined
  let reissueQueuedPrompts: (() => void) | undefined
  let closing = false
  let disposal: Promise<void> | undefined
  const pendingRequests = new Set<Promise<void>>()
  const retiringAdapters = new Map<AgentHarnessAdapter, Promise<void>>()
  const adapterTeardowns = new WeakMap<AgentHarnessAdapter, Promise<void>>()
  const sessionAdapters = new Map<string, AgentHarnessAdapter>()
  const sessionRuntimes = new Map<string, AgentRuntime>()
  const sessionAdapterRunners = new Map<string, RuntimeRunner>()
  const adapterRuntimeKeys = new WeakMap<AgentHarnessAdapter, string>()
  const adapterDirectories = new WeakMap<AgentHarnessAdapter, string>()
  const adapterConfigStamps = new WeakMap<AgentHarnessAdapter, AdapterConfigStamp>()
  const activeTurns = new Map<AgentHarnessAdapter, Set<ActiveTurn>>()
  const activeSessionOwners = new Map<string, { adapter: AgentHarnessAdapter; runtime?: AgentRuntime; directory: string }>()
  let checkpointState: "active" | "freezing" | "frozen" = "active"
  let activeCheckpointWrites = 0
  let reconciledCheckpointEpoch: number | undefined
  const checkpointWriteWaiters = new Set<() => void>()
  const opencodeToolSessions = new Set<string>()
  const sessionToolPrompts = new Map<string, {
    harness?: string
    callbackUrl: string
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
  }>()

  /** What an adapter's applied config is, in the four parts a comparison asks about separately. */
  type AdapterConfigStamp = { key: string; auth: string; mcp: string; launch: string }

  function adapterKey(next: RuntimeRunner) {
    if (next.access === "native") return `native:${next.id}`
    const descriptor = appliedConnections.get(next.id)
    if (!descriptor) throw new WorkspaceHarnessUnavailableError(next)
    return `${descriptor.providerKey}:${descriptor.connectionId}:${descriptor.configRevision}`
  }

  function currentRunner(): RuntimeRunner {
    if (!runner) throw new WorkspaceHarnessUnavailableError({ id: "default", access: "unconfigured" })
    return runner
  }

  function adapterConfigStamp(
    nextRunner: RuntimeRunner,
    auth: Record<string, ProviderProjection>,
    mcp: Record<string, unknown>,
    launch: Record<string, unknown>,
  ): AdapterConfigStamp {
    return {
      key: adapterKey(nextRunner),
      auth: JSON.stringify(auth),
      mcp: JSON.stringify(mcp),
      launch: JSON.stringify(launch),
    }
  }

  function sameAdapterConfig(held: AdapterConfigStamp | undefined, next: AdapterConfigStamp) {
    return held?.key === next.key && held.auth === next.auth && held.mcp === next.mcp && held.launch === next.launch
  }

  /**
   * Whether the only part of this adapter's applied config the snapshot moves
   * is the projection map. Pi refuses to rotate a placeholder while a turn is
   * talking to the process that reads it, and a renewal arrives once every half
   * lifetime, so a session longer than that met the refusal on every push and
   * each one failed the whole apply. The placeholder the adapter already holds
   * stays live until its own expiry, so the replacement can wait for the turn.
   */
  function projectionOnlyChange(
    target: AgentHarnessAdapter,
    nextRunner: RuntimeRunner,
    auth: Record<string, ProviderProjection>,
    mcp: Record<string, unknown>,
    launch: Record<string, unknown>,
  ) {
    const held = adapterConfigStamps.get(target)
    if (!held) return false
    const next = adapterConfigStamp(nextRunner, auth, mcp, launch)
    return held.auth !== next.auth && held.key === next.key && held.mcp === next.mcp && held.launch === next.launch
  }

  async function configureAdapter(next: AgentHarnessAdapter, nextRunner: RuntimeRunner) {
    // `applyConfig` is its own adapter contract: an adapter may take MCP and the
    // per-harness launch payload without advertising the separate
    // runtime-config capability (auth mutation).
    if (!next.applyConfig) return
    const launch = currentHarnessLaunch[nextRunner.id] ?? {}
    const adapterAuth = configuredConnection(nextRunner) ? {} : currentAuthRaw
    const stamp = adapterConfigStamp(nextRunner, adapterAuth, currentMcp, launch)
    if (sameAdapterConfig(adapterConfigStamps.get(next), stamp)) return
    const turns = configuredConnection(nextRunner) ? activeTurns.get(next) : undefined
    if (turns?.size) await Promise.all([...turns].map((turn) => turn.done))
    if (sameAdapterConfig(adapterConfigStamps.get(next), stamp)) return
    await next.applyConfig({
      mcp: currentMcp,
      auth: adapterAuth,
      harness: nextRunner,
      launch,
      ...firstPartyMcpAdapterConfig(options.firstPartyMcpLaunch),
    })
    await (next as AgentHarnessAdapter & { waitForConfigReady?: () => Promise<void> }).waitForConfigReady?.()
    adapterConfigStamps.set(next, stamp)
  }

  // Applied operator-ACP registry: descriptor rows from the last accepted
  // config snapshot, keyed by connection id. Session requests select an open
  // ACP identity by id only — the process command/env always resolves from
  // here, and an identity with no applied row fails closed before any adapter
  // is created.
  let appliedConnections = new Map<string, RuntimeConnectionDescriptor>()

  /**
   * The runtime-config snapshot carries projections, never secret material, so
   * a descriptor that names `secretRefs` has no source here and fails closed. An
   * embedding host that can reach a vault supplies `resolveConnectionSecrets`
   * instead; the desktop's embedded runtime does exactly that against the local
   * credential registry.
   */
  const resolveSnapshotConnectionSecrets: ConnectionSecretResolver = async ({ descriptor }) => {
    if (Object.keys(descriptor.secretRefs ?? {}).length > 0) {
      throw new WorkspaceHarnessUnavailableError({ id: descriptor.connectionId, access: "connection" })
    }
    return { secrets: {}, secretLeaseGeneration: `runtime-config:${configApplyRevision}` }
  }

  function resolveAppliedRunner(next: RuntimeRunner): RuntimeRunner {
    if (next.access === "native") return next
    if (!appliedConnections.has(next.id)) throw new WorkspaceHarnessUnavailableError(next)
    return { id: next.id, access: "connection" }
  }

  async function ensureSessionAdapter(requestedRunner: RuntimeRunner, directory = options.target?.directory ?? workspaceDir()) {
    if (closing) throw new HTTPException(503, { message: "Workspace runtime is disposed" })
    const nextRunner = resolveAppliedRunner(requestedRunner)
    if (nextRunner.access === "connection") {
      const descriptor = appliedConnections.get(nextRunner.id)!
      const secretLease = descriptor.secretRefs && Object.keys(descriptor.secretRefs).length > 0
        ? await (options.resolveConnectionSecrets ?? resolveSnapshotConnectionSecrets)({
            descriptor,
            directory,
          })
        : undefined
      const resolved = await connectionRegistry.resolve({
        descriptor: descriptor as HarnessConnectionDescriptor,
        directory,
        context: {
          store: store(),
          eventHub,
          ...(options.processObserver ? { processObserver: agentProcessObserver(options.processObserver) } : {}),
        },
        ...(secretLease ? { secretLease } : {}),
      })
      const generation = `${resolved.connectionGeneration.configRevision}:${resolved.connectionGeneration.secretLeaseGeneration}`
      if (closing) {
        await disposeAdapter(resolved.adapter)
        throw new HTTPException(503, { message: "Workspace runtime is disposed" })
      }
      const key = JSON.stringify([descriptor.providerKey, descriptor.connectionId, directory, generation])
      const existing = sessionAdapters.get(key)
      if (existing) {
        adapterRuntimeKeys.set(existing, key)
        await resolved.adapter.dispose()
        await configureAdapter(existing, nextRunner)
        return existing
      }
      sessionAdapters.set(key, resolved.adapter)
      sessionAdapterRunners.set(key, nextRunner)
      adapterRuntimeKeys.set(resolved.adapter, key)
      adapterDirectories.set(resolved.adapter, directory)
      retireSupersededConnectionAdapters(nextRunner, key, directory)
      enabled = true
      await configureAdapter(resolved.adapter, nextRunner)
      if (runner && harnessKey(nextRunner) === harnessKey(runner) && directory === (options.target?.directory ?? workspaceDir())) {
        adapter = resolved.adapter
      }
      return resolved.adapter
    }
    const key = adapterKey(nextRunner)
    const existing = sessionAdapters.get(key)
    if (existing) {
      sessionAdapterRunners.set(key, nextRunner)
      adapterRuntimeKeys.set(existing, key)
      await configureAdapter(existing, nextRunner)
      return existing
    }
    const next = createAdapter(nextRunner, hostOptions, harnessRegistry, store())
    sessionAdapters.set(key, next)
    sessionAdapterRunners.set(key, nextRunner)
    adapterRuntimeKeys.set(next, key)
    enabled = true
    await configureAdapter(next, nextRunner)
    if (runner && harnessKey(nextRunner) === harnessKey(runner)) adapter = next
    return next
  }

  function assertSessionDirectory(sessionId: string, directory: string) {
    const owner = (store().getSession(sessionId) as { directory?: string } | null)?.directory
    if (owner && owner !== directory) {
      throw new HTTPException(409, {
        message: `Session ${sessionId} belongs to another workspace directory`,
      })
    }
  }

  function sessionConfigFor(input?: { sessionId?: string; directory?: string }) {
    if (!input?.sessionId) return undefined
    const config = store().getSessionConfig(input.sessionId)
    if (!config || !input.directory) return config
    const session = store().getSession(input.sessionId)
    if (session?.directory && session.directory !== input.directory) return undefined
    return config
  }

  function readSessionConfig(sessionId: string) {
    const config = store().getSessionConfig(sessionId)
    if (!config) return undefined
    return mergeRecoveredSessionConfig(config, sessionRowConfigPatch(store().getSession(sessionId)))
  }

  function executionBindingForHarness(sessionId: string, directory: string, harness: SessionHarness) {
    const binding = store().getExecutionBinding(sessionId)
    if (!binding) {
      throw new AgentRuntimeContractError({
        code: "invalid_execution_binding",
        field: "upstreamSessionId",
        message: `Session ${sessionId} has no complete execution binding`,
      })
    }
    return assertAgentExecutionBinding(binding, {
      ...binding,
      sessionId,
      scope: "workspace",
      workspaceId: workspaceId(),
      directory,
      connectionId: connectionIdForHarness(harness),
    })
  }

  function canonicalExecutionBinding(sessionId: string, directory: string) {
    const config = store().getSessionConfig(sessionId)
    if (!config) {
      throw new AgentRuntimeContractError({
        code: "invalid_execution_binding",
        field: "connectionId",
        message: `Session ${sessionId} has no complete execution binding`,
      })
    }
    return executionBindingForHarness(sessionId, directory, config.harness)
  }

  async function adapterForSession(input?: { sessionId?: string; directory?: string; harness?: RuntimeRunner }) {
    if (closing) throw new HTTPException(503, { message: "Workspace runtime is disposed" })
    const active = input?.sessionId ? activeSessionOwners.get(input.sessionId) : undefined
    if (active && (!input?.directory || input.directory === active.directory)) return active.adapter
    const directory = input?.directory ?? (input?.sessionId ? store().getSession(input.sessionId)?.directory : undefined)
    if (!input?.sessionId) {
      if (input?.harness) return await ensureSessionAdapter(input.harness, directory)
      return await ensureSessionAdapter(currentRunner(), directory)
    }
    const config = sessionConfigFor(input)
    if (!config) return await ensureSessionAdapter(input?.harness ?? currentRunner(), directory)
    return await ensureSessionAdapter(config.harness, directory)
  }

  async function runtimeForSession(input?: { sessionId?: string; directory?: string; harness?: RuntimeRunner }) {
    if (closing) throw new HTTPException(503, { message: "Workspace runtime is disposed" })
    const active = input?.sessionId ? activeSessionOwners.get(input.sessionId) : undefined
    if (active?.runtime && (!input?.directory || input.directory === active.directory)) return active.runtime
    const config = sessionConfigFor(input)
    const nextRunner = config?.harness ?? input?.harness ?? currentRunner()
    const directory = input?.directory ?? (input?.sessionId ? store().getSession(input.sessionId)?.directory : undefined)
    const nextAdapter = await ensureSessionAdapter(nextRunner, directory)
    if (closing) throw new HTTPException(503, { message: "Workspace runtime is disposed" })
    const key = adapterRuntimeKeys.get(nextAdapter) ?? adapterKey(nextRunner)
    const existing = sessionRuntimes.get(key)
    if (existing) return existing
    const runtime = createAgentRuntime({
      store: store(),
      eventHub,
      adapterOwnership: "caller",
      // This session's adapter is already built, so the factory hands the same
      // one back and ignores the creation context the contract offers.
      harnesses: [{
        id: nextRunner.id,
        access: nextRunner.access,
        create: () => nextAdapter,
      }],
      resolveHarness: (target) => ensureSessionAdapter(target, directory),
    })
    sessionRuntimes.set(key, runtime)
    return runtime
  }

  function disposeAdapter(target: AgentHarnessAdapter) {
    const previous = adapterTeardowns.get(target)
    if (previous) return previous
    const done = Promise.resolve().then(() => target.dispose())
    adapterTeardowns.set(target, done)
    void done.catch((error) => Log.create({ service: "workspace-runtime" }).error("Adapter shutdown failed", { error }))
    return done
  }

  function retireAdapter(key: string, target: AgentHarnessAdapter) {
    const previous = retiringAdapters.get(target)
    if (previous) return previous
    const retire = async () => {
      const turns = activeTurns.get(target)
      if (turns?.size) await Promise.all([...turns].map((turn) => turn.done))
      if (sessionAdapters.get(key) !== target) return
      const runtime = sessionRuntimes.get(key)
      sessionAdapters.delete(key)
      sessionAdapterRunners.delete(key)
      if (adapter === target) adapter = undefined
      await runtime?.dispose()
      await disposeAdapter(target)
      sessionRuntimes.delete(key)
      activeTurns.delete(target)
    }
    const pending = retire()
    retiringAdapters.set(target, pending)
    void pending.then(() => retiringAdapters.delete(target), () => {})
    void pending.catch((error) => Log.create({ service: "workspace-runtime" }).error("Adapter retirement failed", { error }))
    return pending
  }

  function retireSupersededConnectionAdapters(nextRunner: RuntimeRunner, keepKey: string, directory: string) {
    if (nextRunner.access !== "connection") return
    for (const [key, target] of sessionAdapters) {
      if (key === keepKey || sessionAdapterRunners.get(key)?.id !== nextRunner.id || adapterDirectories.get(target) !== directory) continue
      // Retirement is detached on purpose: the caller must not wait on a
      // superseded adapter draining. `retireAdapter` logs its own failures.
      void retireAdapter(key, target)
    }
  }

  function listSessions(directory: string) {
    return mergeSessionRows(store().listSessions(directory))
  }

  function mergeSessionRows(rows: AgentSession[]) {
    return [...rows.reduce((acc, row) => {
      const prev = acc.get(row.id)
      if (!prev || sessionTime(row, "updated") >= sessionTime(prev, "updated")) acc.set(row.id, row)
      return acc
    }, new Map<string, AgentSession>()).values()]
      .sort((a, b) => sessionTime(b, "updated") - sessionTime(a, "updated"))
  }

  function sessionTime(input: unknown, key: "created" | "updated") {
    const row = rec(input)
    return num(rec(row?.time)?.[key]) ?? num(row?.[`${key}_at`]) ?? 0
  }

  async function listPermissions(sessionId: string | undefined, directory: string) {
    if (sessionId) return await (await adapterForSession({ sessionId, directory })).listPermissions?.(directory) ?? []
    const seen = new Set<AgentHarnessAdapter>()
    return (await Promise.all(
      [adapter, ...sessionAdapters.values()]
        .filter((item): item is AgentHarnessAdapter => !!item)
        .filter((item) => {
          if (seen.has(item)) return false
          seen.add(item)
          return true
        })
        .map((item) => item.listPermissions?.(directory) ?? Promise.resolve([])),
    )).flat()
  }

  async function listQuestions(directory: string) {
    const seen = new Set<AgentHarnessAdapter>()
    return (await Promise.all(
      [adapter, ...sessionAdapters.values()]
        .filter((item): item is AgentHarnessAdapter => !!item)
        .filter((item) => {
          if (seen.has(item)) return false
          seen.add(item)
          return true
        })
        .map((item) => item.listQuestions?.(directory) ?? Promise.resolve([])),
    )).flat()
  }

  async function clear() {
    await Promise.all([...sessionAdapters].map(([key, target]) => retireAdapter(key, target)))
    adapter = undefined
  }

  function store() {
    if (!sessionConfigStore) {
      if (closing) throw new HTTPException(503, { message: "Workspace runtime is disposed" })
      sessionConfigStore = storeFactory({ storeRoot: options.storeRoot })
      sessionConfigStore.recoverBusySessions?.()
    }
    return sessionConfigStore
  }

  /**
   * The host store, narrowed to the durable queued-prompt rows plus the
   * session row that owns a queued prompt's directory. A store without them
   * leaves the queue where it already was: in the request holding the prompt.
   */
  function queuedPromptStore(): QueuedPromptStore | undefined {
    const target = store()
    const queuePrompt = target.queuePrompt
    const deleteQueuedPrompt = target.deleteQueuedPrompt
    const replaceQueuedPromptParts = target.replaceQueuedPromptParts
    const listQueuedPrompts = target.listQueuedPrompts
    if (!queuePrompt || !deleteQueuedPrompt || !replaceQueuedPromptParts || !listQueuedPrompts) return undefined
    return {
      queuePrompt: (input) => queuePrompt.call(store(), input),
      deleteQueuedPrompt: (sessionId, seq) => deleteQueuedPrompt.call(store(), sessionId, seq),
      replaceQueuedPromptParts: (sessionId, seq, parts) => replaceQueuedPromptParts.call(store(), sessionId, seq, parts),
      listQueuedPrompts: () => listQueuedPrompts.call(store()),
      sessionDirectory: (sessionId) => store().getSession(sessionId)?.directory,
    }
  }

  /**
   * The host store, narrowed to the two subagent-admission methods. Both are
   * optional on {@link WorkspaceRuntimeStore} because a host may back the
   * runtime with any store shape; one that cannot persist subagents fails the
   * individual delegation loudly rather than letting a card silently vanish
   * after reload.
   */
  function subagentStore(): SubagentAdmissionStore {
    const target = store()
    if (!target.admit || !target.markPublished) {
      throw new Error("workspace runtime store does not support subagent admission")
    }
    return { admit: target.admit.bind(target), markPublished: target.markPublished.bind(target) }
  }

  function createActiveTurnScope(input: { adapter: AgentHarnessAdapter; directory: string; sessionId: string }) {
    if (checkpointState !== "active") throw new Error("workspace_checkpoint_frozen")
    let finish = () => {}
    const turn = {
      sessionId: input.sessionId,
      directory: input.directory,
      controller: new AbortController(),
      done: new Promise<void>((resolve) => {
        finish = resolve
      }),
      finish: () => finish(),
    }
    const turns = activeTurns.get(input.adapter) ?? new Set<ActiveTurn>()
    turns.add(turn)
    activeTurns.set(input.adapter, turns)
    const key = adapterRuntimeKeys.get(input.adapter)
    const owner = { adapter: input.adapter, runtime: key ? sessionRuntimes.get(key) : undefined, directory: input.directory }
    if (!activeSessionOwners.has(input.sessionId)) activeSessionOwners.set(input.sessionId, owner)
    return {
      signal: turn.controller.signal,
      dispose() {
        turns.delete(turn)
        if (activeSessionOwners.get(input.sessionId) === owner) activeSessionOwners.delete(input.sessionId)
        turn.finish()
        if (turns.size === 0) {
          activeTurns.delete(input.adapter)
          applyHeldAdapterConfig(input.adapter)
        }
        notifyCheckpointWaiters()
      },
    }
  }

  /**
   * The first moment a config push a running turn held back can land. Without
   * it the held snapshot waits for the next adapter acquisition, and a session
   * that never acquires one again keeps its placeholder past its expiry.
   *
   * On `applyQueue` so it cannot run beside a snapshot apply reconfiguring the
   * same adapter, and its failure moves `configApply` to `failed`: the snapshot
   * that deferred this half already reported `applied`, so nothing else would
   * ever say the runtime is running on a config it could not finish writing.
   */
  function applyHeldAdapterConfig(target: AgentHarnessAdapter) {
    if (closing) return
    const key = adapterRuntimeKeys.get(target)
    const selection = key ? sessionAdapterRunners.get(key) : undefined
    if (!key || !selection || sessionAdapters.get(key) !== target) return
    const configure = () => configureAdapter(target, selection)
    const pending = applyQueue.then(configure, configure).catch(async (cause) => {
      Log.create({ service: "workspace-runtime" }).error("Held adapter configuration failed", { error: cause })
      configApply = {
        ...configApply,
        state: "failed",
        updatedAt: new Date().toISOString(),
        error: runtimeConfigApplyError(cause),
      }
      await persistRuntimeConfigApplyStatus({
        receiptDir: options.configApplyReceiptDir,
        status: configApply,
      }).catch(() => {})
    })
    applyQueue = pending.catch(() => {})
  }

  async function drainActiveTurns(next: AgentHarnessAdapter) {
    const turns = activeTurns.get(next)
    if (!turns?.size) return
    const pending = [...turns]
    for (const turn of pending) turn.controller.abort()
    const aborts = next.abort
      ? pending.map((turn) => next.abort!(canonicalExecutionBinding(turn.sessionId, turn.directory)).catch(() => {}))
      : []
    const drained = Promise.all([...aborts, ...pending.map((turn) => turn.done)])
    await Promise.race([
      drained,
      new Promise((resolve) => setTimeout(resolve, RUNNER_REPLACEMENT_DRAIN_TIMEOUT_MS)),
    ])
  }

  function activeTurnCount() {
    return [...activeTurns.values()].reduce((count, turns) => count + turns.size, 0)
  }

  function checkpointDetail() {
    return {
      state: checkpointState,
      activeWrites: activeCheckpointWrites,
      activeTurns: activeTurnCount(),
      ...(reconciledCheckpointEpoch === undefined ? {} : { reconciledEpoch: reconciledCheckpointEpoch }),
    }
  }

  /** No checkpoint write and no turn is in flight. */
  function checkpointIdle() {
    return activeCheckpointWrites === 0 && activeTurnCount() === 0
  }

  async function waitForCheckpointIdle() {
    // `checkpointIdle()` is re-read after every wake: both counters are moved by
    // other callers, and `notifyCheckpointWaiters` only wakes us once they are 0.
    while (!checkpointIdle()) {
      await new Promise<void>((resolve) => checkpointWriteWaiters.add(resolve))
    }
  }

  function notifyCheckpointWaiters() {
    if (!checkpointIdle()) return
    for (const resolve of checkpointWriteWaiters) resolve()
    checkpointWriteWaiters.clear()
  }

  async function freezeCheckpoint(policy: "drain" | "interrupt") {
    if (checkpointState === "frozen") return checkpointDetail()
    checkpointState = "freezing"
    if (policy === "interrupt") {
      await Promise.all([...activeTurns.keys()].map((next) => drainActiveTurns(next)))
    }
    await waitForCheckpointIdle()
    checkpointState = "frozen"
    return checkpointDetail()
  }

  function runnerHealth(): AgentHarnessAdapterHealth {
    return adapter?.readRuntimeHealth?.(options.target?.directory ?? workspaceDir()) ?? { status: "ok" }
  }

  async function sessionHarnessHealth(input: { sessionId: string; directory?: string }): Promise<AgentHarnessAdapterHealth> {
    const directory = input.directory ?? options.target?.directory ?? workspaceDir()
    const target = await adapterForSession({
      sessionId: input.sessionId,
      directory,
    })
    return target.readRuntimeHealth?.(directory, { sessionId: input.sessionId }) ?? { status: "ok" }
  }

  function healthStatus(input: AgentHarnessAdapterHealth): "ok" | "degraded" | "unavailable" {
    if (state === "error") return "unavailable"
    if (state === "applying") return "degraded"
    return input.status
  }

  async function applySnapshot(next: AppliedRuntimeSnapshot) {
    // Config fan-out re-pushes the same snapshot constantly (most proxied
    // routes sync on the way through), and a full apply restarts adapters,
    // and re-materializes auth. When nothing
    // changed, all of that is waste — so a re-apply of already-live config is
    // a no-op that leaves the revision, the receipts, and the ownership ledger
    // exactly as they are.
    //
    // Checked here rather than in `apply()` so it runs after the queue has
    // serialized: concurrent applies compare against settled state, not
    // against a snapshot that is still mid-flight.
    const signature = runtimeSnapshotSignature(next)
    if (
      appliedSignature !== undefined
      && signature === appliedSignature
      && state === "ready"
      // `enabled` also moves when a session is created, so an identical
      // snapshot can still be the thing that flips it back.
      && enabled === (next.workspaceHarnessEnabled ?? enabled)
    ) return

    state = "applying"
    enabled = next.workspaceHarnessEnabled ?? enabled
    let nextConnections: Map<string, RuntimeConnectionDescriptor>
    let nextRunner: RuntimeRunner | undefined
    try {
      const validatedConnections = connectionRegistry.validateDescriptors(next.connections)
      nextConnections = new Map(validatedConnections.map((row) => [row.connectionId, row] as const))
      for (const [connectionId, previous] of appliedConnections) {
        const updated = nextConnections.get(connectionId)
        if (updated) connectionRegistry.assertRevision(updated, previous)
      }
      nextRunner = next.defaultHarness ? runnerForSelection(next.defaultHarness) : undefined
      if (nextRunner?.access === "connection") {
        const descriptor = nextConnections.get(nextRunner.id)
        if (!descriptor || !descriptor.enabled) throw new WorkspaceHarnessUnavailableError(nextRunner)
      }
    } catch (error) {
      state = "ready"
      throw error
    }
    const receiptDir = options.configApplyReceiptDir
    let revision = configApplyRevision
    let acceptedAt: string | undefined
    const currentKey = runner ? adapterKey(runner) : undefined
    appliedConnections = nextConnections
    const nextKey = nextRunner ? adapterKey(nextRunner) : undefined
    const replacing = nextKey !== currentKey
    const nextHarnessLaunch = next.harnessLaunch ?? {}
    const configChangesActiveConnection = !sameRuntimeMcp(currentMcp, next.mcp)
      || JSON.stringify(currentHarnessLaunch) !== JSON.stringify(nextHarnessLaunch)

    function assertSafeAcpTarget(target: AgentHarnessAdapter | undefined) {
      if (
        !target
        || !nextRunner
        || !configuredConnection(nextRunner)
        || !hasAdapterCapability(target, "runtime-config")
        || (activeTurns.get(target)?.size ?? 0) === 0
        || !configChangesActiveConnection
      ) return
      throw new RuntimeConfigApplyError(
        "runtime_config_unsafe_restart",
        "ACP runtime config change would restart an active session",
        409,
        {
          harness: nextRunner.id,
          activeTurns: activeTurns.get(target)?.size ?? 0,
        },
      )
    }

    try {
      assertSafeAcpTarget(replacing && nextKey ? sessionAdapters.get(nextKey) : adapter)
      revision = configApplyRevision + 1
      acceptedAt = new Date().toISOString()
      configApplyRevision = revision
      configApply = {
        state: "applying",
        revision,
        acceptedAt,
        updatedAt: acceptedAt,
        ...(next.defaultHarness ? { harness: next.defaultHarness } : {}),
      }
      await persistRuntimeConfigApplyStatus({ receiptDir, status: configApply, snapshot: next })

      if (replacing) {
        // Changing the default changes selection policy. Existing sessions
        // still own their cached adapters and active turns.
        adapter = undefined
        runner = nextRunner
      }

      for (const [key, target] of sessionAdapters) {
        const selection = sessionAdapterRunners.get(key)!
        if (selection.access === "connection" && !nextConnections.get(selection.id)?.enabled) void retireAdapter(key, target)
      }

      currentMcp = next.mcp
      currentAuthRaw = next.auth
      currentHarnessLaunch = nextHarnessLaunch
      const deferDefaultAdapterConfig = adapter
        && nextRunner
        && (activeTurns.get(adapter)?.size ?? 0) > 0
        && (configuredConnection(nextRunner)
          || projectionOnlyChange(adapter, nextRunner, next.auth, next.mcp, nextHarnessLaunch[nextRunner.id] ?? {}))

      if (!replacing) runner = nextRunner
      if (!adapter && nextRunner) adapter = await ensureSessionAdapter(nextRunner)
      // Through `configureAdapter` rather than a second `applyConfig` beside
      // it: acquiring the adapter above already configures it, and a push that
      // repeated the call handed every harness the same rotation twice.
      if (!deferDefaultAdapterConfig && adapter && nextRunner) await configureAdapter(adapter, nextRunner)
      await Promise.all([...sessionAdapters.entries()].map(([key, nextAdapter]) => {
        const selection = sessionAdapterRunners.get(key)!
        return activeTurns.get(nextAdapter)?.size || (selection.access === "connection" && !nextConnections.get(selection.id)?.enabled)
          ? Promise.resolve()
          : configureAdapter(nextAdapter, selection)
      }))
      state = "ready"
      err = ""
      // Recorded only here, once every side effect above has succeeded.
      appliedSignature = signature
      const updatedAt = new Date().toISOString()
      configApply = {
        state: "applied",
        revision,
        ...(acceptedAt ? { acceptedAt } : {}),
        updatedAt,
        ...(next.defaultHarness ? { harness: next.defaultHarness } : {}),
      }
      await persistRuntimeConfigApplyStatus({ receiptDir, status: configApply })
      // The runtime can run a turn from here, which is the earliest a prompt
      // left queued by the previous process can become one.
      reissueQueuedPrompts?.()
    } catch (cause) {
      // A partial apply leaves the runtime in an unknown state, so no snapshot
      // counts as live: the next push of this same snapshot must retry in full
      // rather than be skipped.
      appliedSignature = undefined
      const updatedAt = new Date().toISOString()
      configApply = {
        state: "failed",
        revision,
        ...(acceptedAt ? { acceptedAt } : {}),
        updatedAt,
        ...(next.defaultHarness ? { harness: next.defaultHarness } : {}),
        error: runtimeConfigApplyError(cause),
      }
      await persistRuntimeConfigApplyStatus({ receiptDir, status: configApply }).catch(() => {})
      if (cause instanceof RuntimeConfigApplyError) {
        state = cause.status === 500 ? "error" : "ready"
        err = cause.status === 500 ? cause.message : ""
        throw cause
      }
      state = "error"
      err = errorMessage(cause)
      throw cause
    }
  }

  async function apply(next: RuntimeSnapshot) {
    if (closing) throw new HTTPException(503, { message: "Workspace runtime is disposed" })
    const normalized = normalizeRuntimeSnapshot(next)
    if (!normalized) throw new RuntimeConfigApplyError("runtime_config_invalid", "Invalid runtime config snapshot", 409)
    const pending = applyQueue.then(() => applySnapshot(normalized), () => applySnapshot(normalized))
    applyQueue = pending.catch(() => {})
    return pending
  }

  return {
    mount(app: Hono, options: WorkspaceHostMountOptions) {
      app.use("*", async (c, next) => {
        if (closing) return c.json({ error: "Workspace runtime is disposed" }, 503)
        let finish!: () => void
        const request = new Promise<void>((resolve) => { finish = resolve })
        pendingRequests.add(request)
        try { await next() } finally { pendingRequests.delete(request); finish() }
        return undefined
      })
      assertWorkspaceRuntimeExposure({ exposure: options.exposure, env: process.env })
      const sessionAccessPolicy = hostOptions.sessionAccessPolicy
        ?? (options.exposure.kind === "loopback" ? managedWorkspaceSessionAccessPolicy() : undefined)
      if (!sessionAccessPolicy) {
        throw new Error("Managed workspace session routes require SessionAccessPolicy")
      }
      if (
        options.exposure.kind !== "loopback"
        && options.exposure.kind !== "embedded"
        && sessionAccessPolicy.sessionAuthority !== "managed-private"
      ) {
        throw new Error("Managed workspace session routes require authority-backed SessionAccessPolicy")
      }
      let events: MountedWorkspaceEvents
      if (options.core) {
        events = mountWorkspaceCore(app, options.core.upgradeWebSocket, {
          directory: hostOptions.target?.directory ?? workspaceDir(),
          workspaceId: hostOptions.target?.workspaceId ?? workspaceId(),
          eventHub,
          exposure: options.exposure,
          sessionAccessPolicy,
          processObserver: hostOptions.processObserver,
          sessionParents: hostOptions.sessionParents ?? sessionParents,
          transcripts: hostOptions.transcripts,
        })
      } else {
        // A host that serves sessions serves their stream, whatever else it mounts.
        events = mountWorkspaceEvents(app, {
          directory: hostOptions.target?.directory ?? workspaceDir(),
          workspaceId: hostOptions.target?.workspaceId ?? workspaceId(),
          eventHub,
          sessionAccessPolicy,
          sessionParents: hostOptions.sessionParents ?? sessionParents,
          ...(options.renewalIntervalMs !== undefined ? { renewalIntervalMs: options.renewalIntervalMs } : {}),
        })
        if (options.pty) {
          mountWorkspacePty(app, options.pty.upgradeWebSocket, hostOptions.processObserver, sessionAccessPolicy)
        }
        if (options.process) mountWorkspaceProcess(app, sessionAccessPolicy)
        if (options.agentHooks) mountWorkspaceAgentHooks(app, sessionAccessPolicy)
      }
      // A mount replaces whatever the previous one left attached: two live
      // forwards would put every frame on the host tap twice, and the
      // replaced stream would keep its bus subscription for good.
      closeEvents()
      const detachFrames = events.frames.subscribe((frame) => hostFrames.emit(frame))
      closeEvents = () => {
        detachFrames()
        events.close()
      }
      app.get("/api/wr/harness-config-options", async (c) => {
        let targetRunner: RuntimeRunner
        try {
          targetRunner = requestedSessionHarness(c.req) ?? currentRunner()
        } catch (cause) {
          if (cause instanceof WorkspaceHarnessUnavailableError) {
            return c.json({ ok: false, error: { code: cause.code, message: cause.message } }, 409)
          }
          throw cause
        }
        const directory = assertTarget(c.req.query("directory") || workspaceDir())
        try {
          // Adapter selection is inside the guarded region because it is a
          // source of the very failure this route reports: an ACP identity with
          // no applied connection descriptor raises
          // `WorkspaceHarnessUnavailableError` before any process is spawned.
          // Selecting outside it let that escape as an untyped 500, so the
          // caller saw a transport failure instead of the named reason.
          const adapter = await ensureSessionAdapter(targetRunner)
          if (!adapter.probeConfigOptions) {
            return c.json({
              ok: false,
              error: {
                code: "harness_config_options_unavailable",
                harness: targetRunner.id,
                message: `${targetRunner.id} does not expose harness config options`,
              },
            }, 404)
          }
          return c.json(await adapter.probeConfigOptions(directory))
        } catch (cause) {
          return c.json({
            ok: false,
            error: {
              code: "harness_config_options_unavailable",
              harness: targetRunner.id,
              message: harnessConfigOptionsErrorMessage({
                harness: targetRunner,
                cause,
              }),
            },
          }, 502)
        }
      })

      app.get("/mcp", async (c) => c.json(mcpStatus(currentMcp)))

      app.get("/vcs", async (c) => {
        return c.json(await localVcsInfo(requestDirectory(c)))
      })

      const sessions = SessionRoutes((input) => adapterForSession(input), {
        eventHub,
        sessionAccessPolicy,
        resolveRuntime: (input) => runtimeForSession(input),
        resolveExecutionBinding: ({ sessionId, directory }) => canonicalExecutionBinding(sessionId, directory),
        createSession: async (c, directory, title, id, create) => {
          // Write through to the durable store on CREATE.
          //
          // Creation binds the canonical session immediately. Provider-native
          // discovery is intentionally separate and never adopts rows into
          // Claxedo inventory.
          //
          // A caller-supplied id may name a session this runtime already owns.
          // It must not be able to say which WORKSPACE that session belongs to.
          //
          // `bindSession` upserts on a single primary key, so a create issued
          // against another directory REWRITES the existing row's `directory`
          // rather than adding a second one — and the directory string is this
          // runtime's routing identity, so the session simultaneously vanishes
          // from its own workspace's inventory and starts resolving against the
          // caller's directory. Nothing in a create verifies the claim: the
          // harness is told to make a session, it is never asked which
          // workspace the id already lives in.
          //
          // A repeat in the SAME directory is left alone — that is the retry
          // path, where the upsert is a no-op. Only a cross-directory claim is
          // refused, before the harness is asked to create anything.
          if (id) assertSessionDirectory(id, directory)
          // The requested harness must be honoured here exactly as the route's
          // own `resolveAdapter` would. Resolving the ACTIVE runner instead
          // silently creates the session on the wrong adapter — and when the
          // active runner is ACP, spawns a process the caller never asked for.
          const requested = requestedSessionHarness(c.req)
          const adapter = await adapterForSession({
            ...(id ? { sessionId: id } : {}),
            directory,
            ...(requested ? { harness: requested } : {}),
          })
          const session = await adapter.createSession(
            directory,
            title,
            id,
            {
              ...(create?.instructions ? { instructions: create.instructions } : {}),
              ...(create?.group ? { group: create.group } : {}),
            },
          )
          const selectedHarness = requested
            ?? sessionConfigFor({ sessionId: session.id, directory })?.harness
            ?? currentRunner()
          const upstreamSessionId = session.agentSessionId ?? store().getAgentSessionId(session.id) ?? session.id
          const binding = assertAgentExecutionBinding({
            sessionId: session.id,
            workspaceId: workspaceId(),
            directory,
            connectionId: connectionIdForHarness(selectedHarness),
            upstreamSessionId,
          })
          try {
            assertSessionDirectory(session.id, directory)
            // The agent session id belongs to the HARNESS, never to this
            // write-through. An adapter that persists into this store has
            // already bound the id its process answers to: a codex
            // `thread/start` id, an ACP `session/new` id, or the `claude-sdk:`
            // sentinel that means "no SDK conversation exists yet". Re-binding
            // `session.id` over it told the harness to resume a conversation
            // that never existed, so the FIRST turn of every native-SDK session
            // died with `thread not found` / `No conversation found with session
            // ID` (ACP hid it by booting a replacement session). `session.id` is
            // only the placeholder for adapters that keep their sessions
            // elsewhere and left nothing here to preserve.
            store().bindSession({
              ...binding,
              ...(title ? { title } : {}),
              ...(create?.parentID ? { parentSessionId: create.parentID } : {}),
              agentSessionId: upstreamSessionId,
            })
            if (!store().getSessionConfig(session.id)) {
              // An adapter that owns its config has already persisted the
              // retained pair into this store; one whose config is
              // runtime-owned wrote nothing, and a reopened session has no
              // other place to read the instructions or the group back from.
              const accepted = adapter.sessionConfigOwner === "runtime"
                ? {
                    harness: selectedHarness,
                    model: null,
                    variant: null,
                    agent: null,
                    ...(create?.instructions ? { instructions: create.instructions } : {}),
                    ...(create?.group ? { group: create.group } : {}),
                  }
                : await adapter.getSessionConfig(binding)
              store().updateSessionConfig(session.id, {
                ...accepted,
                harness: selectedHarness,
              }, { directory })
            }
            if (create?.permissionCeiling) store().updateSessionConfig(session.id, { permissionCeiling: create.permissionCeiling }, { directory })
            const persisted = store().getSession(session.id)
            if (!persisted) throw new Error(`Session ${session.id} was not persisted`)
            return persisted
          } catch (cause) {
            // The route-level rollback only begins after this hook returns. If
            // binding or initial config persistence fails after the provider
            // has created a remote session, this hook must compensate it using
            // the known upstream id or the remote conversation is orphaned.
            try {
              await adapter.deleteSession(binding)
              if (store().getSession(session.id)) store().deleteSession(session.id)
            } catch (cleanupError) {
              throw new SessionRollbackError("provider", cause, cleanupError)
            }
            throw cause
          }
        },
        afterCreateSession: hostOptions.afterCreateSession,
        listSessions: async (_c, directory) => listSessions(directory),
        getStatus: (_c, directory) => sessionStatusSnapshot(store().listSessions(directory)),
        listSubagents: ({ parentSessionId }) => store().listSubagents(parentSessionId),
        childSessions: {
          admission: hostOptions.subagentAdmission,
          secret: () => {
            const secret = store().runtimeSecret
            if (!secret) throw new Error("workspace runtime store cannot derive idempotent child session ids")
            return secret.call(store(), "child-session")
          },
          pendingWakes: () => store().listPendingSubagentWakes?.() ?? [],
        },
        queuedPrompts: () => queuedPromptStore(),
        listPermissions: (c, directory) => listPermissions(c.req.query("sessionId"), directory),
        listQuestions: (_c, directory) => listQuestions(directory),
        createActiveTurnScope: (input) => createActiveTurnScope(input),
        transformPromptBody: ({ sessionId, body }) => {
          const registration = sessionToolPrompts.get(sessionId)
          if (!registration) return body
          return {
            ...body,
            parts: [...(body.parts ?? []), { type: "text", text: scopedToolPrompt(sessionId, registration) }],
          }
        },
        getMessages: async ({ sessionId }) => {
          if (!store().getSession(sessionId)) throw new HTTPException(404, { message: "Session not found" })
          return store().getMessages(sessionId)
        },
        getMessagePage: async ({ sessionId, page }) => {
          const runtimeStore = store()
          if (!runtimeStore.getSession(sessionId)) throw new HTTPException(404, { message: "Session not found" })
          const getMessagePage = runtimeStore.getMessagePage
          if (!getMessagePage) throw new HTTPException(501, { message: "Bounded message history is unavailable" })
          return {
            ...getMessagePage.call(runtimeStore, sessionId, page) ?? { messages: [] },
            maxEventOrdinal: runtimeStore.getSessionMaxSeq(sessionId),
          }
        },
        getMessageSnapshot: async ({ sessionId }) => {
          if (!store().getSession(sessionId)) throw new HTTPException(404, { message: "Session not found" })
          const messages = store().getMessages(sessionId)
          const fencingToken = store().getSessionFencingToken?.(sessionId) ?? 0
          return {
            messages,
            maxEventOrdinal: store().getSessionMaxSeq(sessionId),
            ...(fencingToken === 0 ? {} : { fencingToken }),
          }
        },
        getSession: async ({ directory, sessionId }) => {
          const stored = store().getSession(sessionId)
          if (!stored) return null
          return (stored.directory ?? "") === (directory ?? "") ? stored : null
        },
        getTodos: async ({ sessionId }) => {
          if (!store().getSession(sessionId)) return undefined
          return store().getTodos(sessionId)
        },
        getSessionConfig: async ({ sessionId }) => {
          const config = readSessionConfig(sessionId)
          if (!config) throw new HTTPException(404, { message: "Session not found" })
          return config
        },
        updateSessionConfig: async ({ directory, sessionId, update }) => {
          const runtime = await runtimeForSession({ sessionId, directory })
          return runtime.sessions.updateConfig(sessionId, update, directory)
        },
        switchSessionHarness: async ({ directory, sessionId, update }) => {
          assertSessionDirectory(sessionId, directory)
          const runtime = await runtimeForSession({ sessionId, directory })
          return await runtime.sessions.updateConfig(sessionId, update, directory)
        },
        afterUpdateSession: ({ sessionId, updates }) => {
          // Renames and archives have to reach the durable store, or a
          // store-owned inventory serves the old title and keeps handing back
          // sessions the user archived.
          store().updateSession(sessionId, updates)
        },
        beforeDeleteSession: async ({ sessionId }) => {
          // Stop only this session's host readers while their execution binding
          // still exists. Deleting first can fence out the terminal frame that
          // those readers need to release their residency pins.
          const pending = [...activeTurns.entries()].flatMap(([adapter, turns]) =>
            [...turns].filter((turn) => turn.sessionId === sessionId).map((turn) => ({ adapter, turn })))
          for (const { turn } of pending) turn.controller.abort()
          await Promise.all(pending.map(async ({ adapter, turn }) => {
            await adapter.abort?.(canonicalExecutionBinding(sessionId, turn.directory))
            await turn.done
          }))
        },
        afterDeleteSession: ({ sessionId }) => {
          // A store-owned inventory needs its own row removed here, or it
          // would resurrect every deleted session on the next list.
          store().deleteSession(sessionId)
          hostOptions.transcripts?.resolver.invalidateParent?.(hostOptions.transcripts.workspaceId, sessionId)
        },
      })
      app.route("/", sessions.routes)
      // No request carries this work, so the workspace target a session route
      // would have bound is bound here instead.
      reissueQueuedPrompts = () => {
        const reissue = () => void sessions.recoverQueuedPrompts()
        if (hostOptions.target) withWorkspaceTarget(hostOptions.target, reissue)
        else reissue()
      }
      // A host told its harness at construction can start a queued prompt now;
      // one that waits for a config snapshot re-issues them when it applies.
      if (runner) reissueQueuedPrompts()
    },
    hasSession(sessionId: string) {
      return !!store().getSession(sessionId)
    },
    frames: hostFrames.tap,
    getSessionConfig: readSessionConfig,
    parentSessionIdFor(sessionId: string) {
      const session = store().getSession(sessionId) as { parentID?: string | null } | null
      return session?.parentID ?? undefined
    },
    runtimeCredentialIssuer() {
      return options.firstPartyMcpLaunch?.issuer
    },
    firstPartyMcpServer(sessionId) {
      return options.firstPartyMcpLaunch ? firstPartyMcpServerFor(options.firstPartyMcpLaunch, sessionId) : undefined
    },
    apply,
    applyHarnessLaunch(harnessLaunch: Record<string, Record<string, unknown>>) {
      return apply({
        version: 4,
        mcp: currentMcp,
        connections: [...appliedConnections.values()],
        ...(runner ? { defaultHarness: selectionForRunner(runner) } : {}),
        auth: currentAuthRaw,
        workspaceHarnessEnabled: enabled,
        harnessLaunch,
      })
    },
    detail() {
      const health = runnerHealth()
      return {
        state,
        healthStatus: healthStatus(health),
        harness: runner ? selectionForRunner(runner) : undefined,
        error: err,
        harnessHealth: health,
        workspaceHarnessEnabled: enabled,
        configApply,
      }
    },
    readHarnessHealth: sessionHarnessHealth,
    capabilities() {
      return workspaceCapabilities(enabled)
    },
    activity() {
      return {
        activeTurns: activeTurnCount(),
        activeWrites: activeCheckpointWrites,
        checkpointState,
      }
    },
    async registerSessionTools(input) {
      if (closing) throw new HTTPException(503, { message: "Workspace runtime is disposed" })
      const config = store().getSessionConfig(input.sessionId)
      if (config?.harness.access === "native" && config.harness.id === "opencode") {
        // The SDK owns tool dispatch for its sessions; the prompt-projection
        // path below is for harnesses that receive tools as prompt context.
        if (!hostOptions.opencodeRuntime) throw new Error("OpenCode SDK runtime is required for Session tool registration")
        sessionToolPrompts.delete(input.sessionId)
        const directory = options.target?.directory ?? workspaceDir()
        await hostOptions.opencodeRuntime.tools.registerSession({
          scope: WorkspaceScope.authorize({ workspaceID: options.target?.workspaceId ?? "workspace-runtime", directory }),
          sessionID: input.sessionId,
          callbackUrl: input.callbackUrl,
          tools: input.tools,
        })
        opencodeToolSessions.add(input.sessionId)
        return
      }
      sessionToolPrompts.set(input.sessionId, input)
    },
    async unregisterSessionTools(sessionId) {
      sessionToolPrompts.delete(sessionId)
      if (opencodeToolSessions.delete(sessionId)) await hostOptions.opencodeRuntime?.tools.unregisterSession(sessionId)
    },
    checkpoint: {
      detail: checkpointDetail,
      beginWrite(): (() => void) | undefined {
        if (checkpointState !== "active") return undefined
        activeCheckpointWrites++
        let finished = false
        return () => {
          if (finished) return
          finished = true
          activeCheckpointWrites--
          notifyCheckpointWaiters()
        }
      },
      freeze: freezeCheckpoint,
      async flush() {
        if (checkpointState !== "frozen") throw new Error("workspace_checkpoint_not_frozen")
        await applyQueue
        sessionConfigStore?.flush?.()
      },
      async scrub() {
        if (checkpointState !== "frozen") throw new Error("workspace_checkpoint_not_frozen")
        // Scrub tears down the adapter and deletes materialized auth, so the
        // live config is gone even though the snapshot that produced it has
        // not changed. Drop the signature or the rebuilding apply would be
        // skipped as a no-op and leave the runtime unconfigured.
        appliedSignature = undefined
        await clear()
      },
      async resume() {
        if (closing) throw new HTTPException(503, { message: "Workspace runtime is disposed" })
        checkpointState = "active"
        return checkpointDetail()
      },
      async restoreReconcile(input) {
        if (closing) throw new HTTPException(503, { message: "Workspace runtime is disposed" })
        if (!Number.isSafeInteger(input.epoch) || input.epoch < 1 || !input.checkpointId) {
          throw new Error("workspace_checkpoint_reconcile_invalid")
        }
        reconciledCheckpointEpoch = input.epoch
        checkpointState = "active"
        return checkpointDetail()
      },
    },
    dispose() {
      if (disposal) return disposal
      closing = true
      checkpointState = "freezing"
      for (const turns of activeTurns.values()) for (const turn of turns) turn.controller.abort()
      disposal = (async () => {
        // Initiate teardown now: a pending create or permission may only
        // settle when its provider process is stopped.
        const adaptersDone = [...new Set([...sessionAdapters.values(), ...retiringAdapters.keys()])].map(disposeAdapter)
        // Existing handlers may be finishing creation or reading the final
        // prompt snapshot. Keep their borrowed store alive through that work.
        await Promise.allSettled([applyQueue, ...pendingRequests])
        // Adapter teardown stops autonomous goals and interactions as well as
        // prompts. Native adapters await their own committing producer tails.
        await Promise.all([
          ...adaptersDone,
          ...retiringAdapters.values(),
          ...new Set([...sessionRuntimes.values()].map((runtime) => runtime.dispose())),
        ])
        sessionAdapters.clear()
        sessionAdapterRunners.clear()
        sessionRuntimes.clear()
        activeTurns.clear()
        activeSessionOwners.clear()
        adapter = undefined
        cleanupCompatObserver()
        cleanupRuntimeObserver()
        closeEvents()
        sessionToolPrompts.clear()
        opencodeToolSessions.clear()
        sessionConfigStore?.close?.()
        sessionConfigStore = undefined
      })()
      void disposal.catch((error) => Log.create({ service: "workspace-runtime" }).error("Workspace shutdown failed", { error }))
      return disposal
    },
  }
}
