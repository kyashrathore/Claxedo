import type { RecoveryTurnTarget, AgentEventEnvelope } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeHealth, AgentTurnOutcome } from "@claxedo/agent-runtime-contract"
import type { BrokerPorts } from "@claxedo/harness/broker"
import { createHarnessComposer } from "@claxedo/harness/compose"
import type { CustomHarnessProvider } from "@claxedo/harness/providers"
import type { HarnessServices, MachineLoginPolicy } from "@claxedo/harness/contract"
import type { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { clearOpaqueTimer, createKeyedSerializer, errorMessage } from "@claxedo/helpers"
import type { LaunchOwnershipOwner } from "@claxedo/process-ownership/launch"
import { workspaceCapabilities } from "../capabilities"
import { createStoreBrokerPorts } from "../broker-ports"
import { workspaceRuntimeStoreDir } from "../env"
import { assertWorkspaceRuntimeExposure } from "../exposure"
import { firstPartyMcpServerFor, type WorkspaceFirstPartyMcpLaunchOptions } from "../first-party-mcp/index"
import { createHarnessServices } from "../harness-services"
import { WorkspaceHarnessUnavailableError } from "../harness-unavailable-error"
import { defaultHarnessStateRoot, harnessCompositionOptions, sweepIdleHarnessHomes } from "../host/composition"
import { createElicitationPatternEvaluator } from "../host/pattern-evaluator"
import { sessionCredentials } from "../host/launch"
import { harnessUnavailableResponse } from "../routes/session-harness-refusal"
import { pluginProjectionFor } from "../host/projection"
import { PreviewModelInvalidError } from "../host/config-ops"
import { createAgentRuntime, type AgentRuntime, type LaunchComposer } from "../host/runtime"
import { Log } from "../log"
import type { ProcessObserver } from "../managed-processes/process-observer"
import { createRuntimeEventHub, type RuntimeEventEnvelope, type RuntimeEventHub } from "../projection/runtime-event-hub"
import { normalizeRuntimeSnapshot, requestedSessionHarness, RUNTIME_NATIVE_HARNESS_IDS, RuntimeConfigApplyError, type AppliedRuntimeSnapshot, type RuntimeConnectionDescriptor, type RuntimeHarnessSelection, type RuntimeSnapshot } from "../routes/config"
import { createWorkspaceEventFramesTap, type WorkspaceEventParents } from "../routes/events"
import { isSessionRecoveryPath } from "../routes/session-core"
import { sessionOwner } from "../routes/session-route-options"
import { errorBody } from "../routes/error-body"
import { providerCatalogRefusal } from "../routes/workspace-role"
import { managedWorkspaceSessionAccessPolicy, type SessionAccessPolicy } from "../session-access-policy"
import { runtimeSessionTime } from "../session/session-time"
import type { RuntimeStore } from "../store"
import { openRuntimeStore } from "../store-file"
import { workspaceDurableState } from "./durable-state"
import { runGit } from "../git"
import { assertTarget, authoritativeWorkspaceId, withWorkspaceTarget, workspaceDir, workspaceId, type WorkspaceTarget } from "../target"
import { createWorkspaceCheckpoint } from "./checkpoint"
import { createSessionConfiguration } from "./configure"
import { createHarnessHealthFeed } from "./harness-health-feed"
import { mountWorkspaceCore, mountWorkspaceAgentHooks, mountWorkspaceEvents, mountWorkspaceProcess, mountWorkspacePty, type MountedWorkspaceEvents, type WorkspaceTranscriptRoutesOptions } from "./core"
import type { RuntimeConfigApplyStatus, WorkspaceConnectionState, WorkspaceHost, WorkspaceHostMountOptions } from "./host"
import { mountSessionRoutes } from "./session-routes"
import { assertConnectionRevision, connectionConfigHooks, harnessKey, persistRuntimeConfigApplyStatus, runnerForSelection, runtimeConfigApplyError, runtimeSnapshotSignature, sameAuth, sameRuntimeMcp, validateDescriptors, type RuntimeRunner } from "./snapshot"
import { createWorkspaceTransports } from "./transports"
import type { ConnectionSecretResolver } from "@claxedo/agent-runtime-contract"
import { harnessHealthChanged } from "../projection/presentation-events"

export type { RuntimeRunner } from "./snapshot"

export type WorkspaceRuntimeStore = RuntimeStore

export type WorkspaceRuntimeStoreFactory = (input: { storeRoot?: string }) => WorkspaceRuntimeStore

export type WorkspaceHostOptions = {
  /** Optional, local-only lifecycle observer supplied by an embedding host. */
  processObserver?: ProcessObserver
  /** Host observer for the durable turn.finish outcome after store commit. */
  onTurnOutcome?: (input: { sessionId: string; assistantMessageId?: string; outcome: AgentTurnOutcome }) => void
  /** Direct observer for the presentation events produced by this host. */
  onPresentationEvent?: (event: AgentEventEnvelope) => void
  /**
   * Direct observer for the canonical runtime events produced by this host.
   *
   * The presentation stream carries session metadata; this one carries what the harness
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
  /** The workspace that already holds a session id on this host; a create naming an id another workspace holds is refused before any harness launches. */
  sessionIdWorkspace?: (sessionId: string) => Promise<string | undefined> | string | undefined
  /** Private-session authority selected by the host composition. */
  sessionAccessPolicy?: SessionAccessPolicy
  harness?: RuntimeHarnessSelection
  /** Where this runtime runs and whose machine it is; every transport's own-login decision reads it. */
  placement: MachineLoginPolicy
  /** Connection providers this host installs beside the built-in ACP and Pi RPC ones. */
  connectionProviders?: readonly CustomHarnessProvider<unknown>[]
  /** Host-owned resolver for opaque descriptor secret references. */
  resolveConnectionSecrets?: ConnectionSecretResolver
  target?: WorkspaceTarget
  storeRoot?: string
  /** Where Claxedo-owned harness homes live; defaults to `~/.claxedo/harness` of the process user. */
  harnessStateRoot?: string
  /** The environment harness processes inherit and executables are resolved from. */
  env?: NodeJS.ProcessEnv
  /**
   * Durable config-apply receipts (`accepted-snapshot.json`,
   * `apply-status.json`). OFF by default: the live `configApply` status is
   * already exposed through `host.detail()` and `/api/wr/health`, so receipt
   * files are a diagnostics opt-in, not the source of truth. Hosts that need
   * durable receipts (cloud/sandbox postmortems) pass a directory they own —
   * never derived from the workspace checkout.
   */
  configApplyReceiptDir?: string
  /** Embedded owner applies its canonical snapshot before any harness is acquired. */
  beforeHarnessAcquire?: () => Promise<void>
  /**
   * Called synchronously after every change to what `activity()` and
   * `activeTurns()` report, so an owner deciding residency never has to poll
   * them. It must not start a turn, a checkpoint write, or a disposal.
   */
  onActivityChange?: () => void
  eventHub?: RuntimeEventHub
  /**
   * Host-supplied shared store factory. Defaults to the SQLite-backed
   * `RuntimeStore`. See {@link WorkspaceRuntimeStoreFactory}.
   */
  storeFactory?: WorkspaceRuntimeStoreFactory
  /**
   * The first-party MCP entry every launched session receives: the loopback
   * origin serving `/api/claxedo/mcp` and this runtime's credential issuer.
   * Absent, no harness receives the entry — the host that mounts the route is
   * the one that enables injection.
   */
  firstPartyMcpLaunch?: WorkspaceFirstPartyMcpLaunchOptions
}

const log = Log.create({ service: "workspace-runtime" })

function selectionForRunner(runner: RuntimeRunner): RuntimeHarnessSelection {
  const harnessId = runner.access === "native" ? RUNTIME_NATIVE_HARNESS_IDS.find((id) => id === runner.id) : undefined
  if (harnessId) return { kind: "native", harnessId }
  if (runner.access === "connection") return { kind: "connection", connectionId: runner.id }
  throw new WorkspaceHarnessUnavailableError(runner)
}

const defaultStoreFactory: WorkspaceRuntimeStoreFactory = ({ storeRoot }) => openRuntimeStore(storeRoot)

function resolveStoreFactory(options: WorkspaceHostOptions): WorkspaceRuntimeStoreFactory {
  const factory = options.storeFactory ?? defaultStoreFactory
  if (!options.onTurnOutcome) return factory
  return (input) => {
    const store = factory(input)
    const finish = store.finishTurn.bind(store)
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
    return store
  }
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

function requestDirectory(c: { req: { query(name: string): string | undefined } }) {
  return assertTarget(c.req.query("directory") || workspaceDir())
}

export function createWorkspaceHost(options: WorkspaceHostOptions): WorkspaceHost {
  if (options.sessionIdWorkspace && !options.target?.workspaceId) {
    throw new Error("sessionIdWorkspace requires a target workspace: a session's holder is compared with the workspace this host serves")
  }
  const eventHub = options.eventHub ?? createRuntimeEventHub()
  let closeEvents: () => void = () => {}
  const hostFrames = createWorkspaceEventFramesTap()
  const sessionParents: WorkspaceEventParents = {
    parentSessionIdFor: (sessionId) => (store().getSession(sessionId) as { parentID?: string | null } | null)?.parentID ?? undefined,
  }
  const cleanupPresentationObserver = options.onPresentationEvent ? eventHub.subscribeGlobal(options.onPresentationEvent) : () => undefined
  const cleanupRuntimeObserver = options.onRuntimeEvent ? eventHub.subscribeRuntime(options.onRuntimeEvent) : () => undefined
  const env = options.env ?? process.env
  const harnessStateRoot = options.harnessStateRoot ?? defaultHarnessStateRoot(env)
  const storeRoot = options.storeRoot ?? workspaceRuntimeStoreDir(env)
  // Only a native selection is runnable on its own. A connection's provider,
  // command and revision live in a descriptor that arrives with a snapshot, so
  // a connection default stays a selection until `applySnapshot` resolves it.
  let runner = options.harness?.kind === "native" ? runnerForSelection(options.harness) : undefined
  let state: "ready" | "applying" | "error" = "ready"
  let err = ""
  let enabled = false
  let configApplyRevision = 0
  let configApply: RuntimeConfigApplyStatus = { state: "idle", revision: 0 }
  let appliedSignature: string | undefined
  let currentMcp: Record<string, unknown> = {}
  let currentProviderDefinitions: NonNullable<AppliedRuntimeSnapshot["providerDefinitions"]> = []
  let currentAuthRaw: AppliedRuntimeSnapshot["auth"] = { machineOwnerUserId: options.placement.machineOwnerUserId, accounts: {} }
  let currentHarnessLaunch: Record<string, Record<string, unknown>> = {}
  let currentCommands: AppliedRuntimeSnapshot["commands"] = []
  let appliedConnections = new Map<string, RuntimeConnectionDescriptor>()
  const snapshots = createKeyedSerializer<"snapshot">()
  const storeFactory = resolveStoreFactory(options)
  const ownerGeneration = crypto.randomUUID()
  const assignedWorkspaceId = options.target?.workspaceId ?? authoritativeWorkspaceId()
  const launchOwner: LaunchOwnershipOwner = {
    ownerGeneration,
    scope: assignedWorkspaceId ? { kind: "workspace", workspaceId: assignedWorkspaceId } : { kind: "standalone" },
  }
  const durable = workspaceDurableState({ open: () => storeFactory({ storeRoot }), launchOwner, closing: () => closing })
  const { store, launchOwnership, sessionStarts } = durable
  let disposeDeliveries: (() => Promise<void>) | undefined
  let reissueQueuedPrompts: (() => void) | undefined
  let closing = false
  let disposal: Promise<void> | undefined
  const pendingRequests = new Set<Promise<void>>()
  const sessionToolPrompts = new Map<string, {
    harness?: string
    callbackUrl: string
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
  }>()

  function currentRunner(): RuntimeRunner {
    if (!runner) throw new WorkspaceHarnessUnavailableError({ id: "default", access: "unconfigured" })
    return runner
  }

  const resolveSnapshotConnectionSecrets: ConnectionSecretResolver = async ({ descriptor }) => {
    if (Object.keys(descriptor.secretRefs ?? {}).length > 0) {
      throw new WorkspaceHarnessUnavailableError({ id: descriptor.connectionId, access: "connection" })
    }
    return { secrets: {}, secretLeaseGeneration: "none" }
  }

  const launch: LaunchComposer = {
    workspaceId: options.target?.workspaceId ?? workspaceId(),
    projection: (harness) => pluginProjectionFor(harness, {
      generation: `runtime-config:${configApplyRevision}`, mcp: currentMcp, harnessLaunch: currentHarnessLaunch,
    }),
    providerDefinitions: () => currentProviderDefinitions,
    credentials: () => ({ ...options.placement, ...currentAuthRaw, leaseGeneration: `runtime-config:${configApplyRevision}` }),
  }

  type Engine = {
    services: HarnessServices
    transports: ReturnType<typeof createWorkspaceTransports>
    ports: BrokerPorts & { abortProviderTurn(sessionId: string): void }
    runtime: AgentRuntime
    configuration: ReturnType<typeof createSessionConfiguration>
  }
  let engine: Engine | undefined
  const retiredTransports = new Set<Engine["transports"]>()
  const retireTransports = async (transports: Engine["transports"]) => {
    retiredTransports.add(transports)
    await transports.disposeAll()
    retiredTransports.delete(transports)
  }
  const patternEvaluator = createElicitationPatternEvaluator()

  function harnessEngine(): Engine {
    if (engine) return engine
    if (closing) throw new HTTPException(503, { message: "Workspace runtime is disposed" })
    const runtimeStore = store()
    const services = createHarnessServices({
      ownership: launchOwnership(),
      ...(options.processObserver ? { observation: { observer: options.processObserver, ...(options.target ? { workspaceId: options.target.workspaceId } : {}) } } : {}),
      ...(options.transcripts ? { transcripts: options.transcripts } : {}),
      ...(options.firstPartyMcpLaunch ? { firstPartyMcpLaunch: options.firstPartyMcpLaunch } : {}),
      log: { debug: (message, fields) => log.info(message, fields), info: (message, fields) => log.info(message, fields),
        warn: (message, fields) => log.warn(message, fields), error: (message, fields) => log.error(message, fields) },
      clock: { now: () => Date.now(), setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: clearOpaqueTimer },
      patternEvaluator,
      healthChanged: () => healthFeed.changed(),
    })
    void sweepIdleHarnessHomes(harnessStateRoot).catch((error: unknown) => log.warn("Idle harness home sweep failed", { error: String(error) }))
    const composer = createHarnessComposer(services, harnessCompositionOptions({
      env, placement: options.placement, harnessStateRoot, opencodeRoot: `${storeRoot}/opencode`, store,
    }), options.connectionProviders ?? [])
    const transports = createWorkspaceTransports({
      composer,
      connections: () => appliedConnections,
      resolveSecrets: (descriptor, directory, access) => (options.resolveConnectionSecrets ?? resolveSnapshotConnectionSecrets)({
        descriptor, directory, ...(access.authority ? { authority: access.authority } : {}),
        owner: access.owner,
      }),
    })
    const ports = createStoreBrokerPorts(runtimeStore, {
      ownerGeneration,
      patternEvaluator,
      publishers: eventHub,
      reportOwnerFailure: (sessionId, error) => engine?.runtime.recovery.reportOwnerFailure(sessionId, error),
      retainLeasedTurnFailure: (sessionId, turn, error) => {
        if (engine) return engine.runtime.recovery.retainLeasedTurnFailure(sessionId, turn, error)
        log.error("A refused turn terminal has no runtime left to retain it", { sessionId, error: String(error) })
        return false
      },
    })
    const configuration = createSessionConfiguration({
      attached: () => engine?.runtime.attachments.entries() ?? [],
      projection: (attached) => launch.projection(attached.handle.runner),
      credentials: (attached) => sessionCredentials(launch, { owner: attached.owner, config: runtimeStore.getSessionConfig(attached.session.binding.sessionId)! }),
      providerDefinitions: () => currentProviderDefinitions,
      onHeldFailure: (error) => { void failConfigApply(error) },
      retire: async (attached, reason) => {
        const sessionId = attached.session.binding.sessionId
        log.warn("Retiring a session whose owner has no usable account", { sessionId, reason })
        engine?.runtime.attachments.forget(sessionId)
        await attached.handle.transport.close(attached.session)
      },
    })
    const runtime = createAgentRuntime({
      store: runtimeStore, eventHub, transports, ports, ownerGeneration, launch,
      identity: { workspaceId: options.target?.workspaceId ?? "" },
      savedCommands: () => currentCommands,
      afterTurn: (sessionId) => configuration.afterTurn(sessionId),
      ...(options.onActivityChange ? { onActiveTurnChange: options.onActivityChange } : {}),
    })
    engine = { services, transports, ports, runtime, configuration }
    return engine
  }

  async function runtimeForSession() {
    if (closing) throw new HTTPException(503, { message: "Workspace runtime is disposed" })
    await options.beforeHarnessAcquire?.()
    return harnessEngine().runtime
  }

  const healthFeed = createHarnessHealthFeed({
    read: async (sessionId, directory) => {
      const connection = connectionState({ sessionId, directory })
      return { harnessHealth: await sessionHarnessHealth({ sessionId, directory }), ...(connection ? { connectionState: connection } : {}) }
    },
    publish: (directory, properties) => eventHub.publishGlobal({ directory, payload: harnessHealthChanged(properties) }),
    onReadFailure: (sessionId, error) => log.warn("Harness health read failed", { sessionId, error: errorMessage(error) }),
  })

  const checkpoint = createWorkspaceCheckpoint({
    recovery: () => engine?.runtime.recovery,
    turnStarted: (sessionId, directory) => healthFeed.turnStarted(sessionId, directory),
    turnEnded: (sessionId) => healthFeed.turnEnded(sessionId),
    onActivityChange: () => options.onActivityChange?.(),
  })

  function readSessionConfig(sessionId: string) {
    return store().getSessionConfig(sessionId) ?? undefined
  }

  function runnerHealth(): AgentRuntimeHealth {
    const directory = options.target?.directory ?? workspaceDir()
    if (!runner || !engine) return { status: "ok" }
    const handle = engine.transports.composed().find((item) => harnessKey(item.runner) === harnessKey(runner!))
    return handle?.transport.health?.runtime(directory) ?? { status: "ok" }
  }

  function connectionState(input?: { sessionId?: string; directory?: string }): WorkspaceConnectionState | undefined {
    const selection = input?.sessionId ? store().getSessionConfig(input.sessionId)?.harness : runner
    if (selection?.access !== "connection") return undefined
    const directory = input?.directory ?? (input?.sessionId ? store().getSession(input.sessionId)?.directory : undefined) ?? options.target?.directory ?? workspaceDir()
    const handle = engine?.transports.composed().find((item) => item.runner.access === "connection" && item.runner.id === selection.id)
    return { connectionId: selection.id, ...(engine?.runtime.reads.connectionState(input?.sessionId, directory, handle) ?? { state: "configured" as const, processes: [] }) }
  }

  async function sessionHarnessHealth(input: { sessionId: string; directory?: string }): Promise<AgentRuntimeHealth> {
    const directory = input.directory ?? store().getSession(input.sessionId)?.directory ?? options.target?.directory ?? workspaceDir()
    return engine?.runtime.reads.sessionHealth(input.sessionId, directory) ?? { status: "ok" }
  }

  function healthStatus(input: AgentRuntimeHealth): "ok" | "degraded" | "unavailable" {
    if (state === "error") return "unavailable"
    if (state === "applying") return "degraded"
    return input.status
  }

  async function applySnapshot(next: AppliedRuntimeSnapshot) {
    const signature = runtimeSnapshotSignature(next)
    if (appliedSignature !== undefined && signature === appliedSignature && state === "ready"
      && enabled === (next.workspaceHarnessEnabled ?? enabled)) return
    state = "applying"
    enabled = next.workspaceHarnessEnabled ?? enabled
    let nextConnections: Map<string, RuntimeConnectionDescriptor>
    let nextRunner: RuntimeRunner | undefined
    try {
      nextConnections = validateDescriptors(next.connections, connectionConfigHooks(options.connectionProviders))
      for (const [connectionId, previous] of appliedConnections) {
        const updated = nextConnections.get(connectionId)
        if (updated) assertConnectionRevision(updated, previous)
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
    const nextHarnessLaunch = next.harnessLaunch ?? {}
    const projectionChanged = !sameRuntimeMcp(currentMcp, next.mcp) || JSON.stringify(currentHarnessLaunch) !== JSON.stringify(nextHarnessLaunch)
    const providerDefinitionsChanged = JSON.stringify(currentProviderDefinitions) !== JSON.stringify(next.providerDefinitions ?? [])
    const credentialsChanged = !sameAuth(currentAuthRaw, next.auth)
    try {
      revision = configApplyRevision + 1
      acceptedAt = new Date().toISOString()
      configApplyRevision = revision
      configApply = { state: "applying", revision, acceptedAt, updatedAt: acceptedAt, ...(next.defaultHarness ? { harness: next.defaultHarness } : {}) }
      await persistRuntimeConfigApplyStatus({ receiptDir, status: configApply, snapshot: next })
      const previousConnections = appliedConnections
      appliedConnections = nextConnections
      runner = nextRunner
      for (const [connectionId] of previousConnections) {
        if (!nextConnections.get(connectionId)?.enabled) engine?.transports.retireConnection(connectionId)
      }
      currentMcp = next.mcp
      currentAuthRaw = next.auth
      currentProviderDefinitions = next.providerDefinitions ?? []
      currentHarnessLaunch = nextHarnessLaunch
      if (engine) await engine.configuration.apply({ credentials: credentialsChanged, projection: projectionChanged, providerDefinitions: providerDefinitionsChanged })
      currentCommands = next.commands
      state = "ready"
      err = ""
      appliedSignature = signature
      const updatedAt = new Date().toISOString()
      configApply = { state: "applied", revision, ...(acceptedAt ? { acceptedAt } : {}), updatedAt, ...(next.defaultHarness ? { harness: next.defaultHarness } : {}) }
      await persistRuntimeConfigApplyStatus({ receiptDir, status: configApply })
      // The runtime can run a turn from here, which is the earliest a prompt
      // left queued by the previous process can become one.
      reissueQueuedPrompts?.()
    } catch (cause) {
      appliedSignature = undefined
      const updatedAt = new Date().toISOString()
      configApply = { state: "failed", revision, ...(acceptedAt ? { acceptedAt } : {}), updatedAt,
        ...(next.defaultHarness ? { harness: next.defaultHarness } : {}), error: runtimeConfigApplyError(cause) }
      await persistRuntimeConfigApplyStatus({ receiptDir, status: configApply })
        .catch((error: unknown) => log.error("Config apply status could not be persisted", { error: errorMessage(error) }))
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

  /** A held push that failed after its apply returned still fails the revision it belongs to. */
  async function failConfigApply(cause: unknown) {
    log.error("A held configuration push failed", { error: errorMessage(cause) })
    appliedSignature = undefined
    configApply = { ...configApply, state: "failed", updatedAt: new Date().toISOString(), error: runtimeConfigApplyError(cause) }
    await persistRuntimeConfigApplyStatus({ receiptDir: options.configApplyReceiptDir, status: configApply })
      .catch((error: unknown) => log.error("Config apply status could not be persisted", { error: errorMessage(error) }))
  }

  async function apply(next: RuntimeSnapshot) {
    if (closing) throw new HTTPException(503, { message: "Workspace runtime is disposed" })
    const normalized = normalizeRuntimeSnapshot(next)
    if (!normalized) throw new RuntimeConfigApplyError("runtime_config_invalid", "Invalid runtime config snapshot", 409)
    return snapshots.run("snapshot", () => applySnapshot(normalized))
  }

  function mountGate(app: Hono) {
    app.use("*", async (c, next) => {
      // A recovery request is served while this runtime is closing, and it
      // is not something disposal waits for: a wedged session is contained BY
      // cancelling it, so draining that request before tearing down would make
      // the containment and the teardown it contains each other's precondition.
      if (isSessionRecoveryPath(new URL(c.req.url).pathname)) {
        await next()
        return undefined
      }
      if (closing) return c.json({ error: "Workspace runtime is disposed" }, 503)
      const refused = await durable.admit(c.req.method)
      if (refused) return refused
      let finish!: () => void
      const request = new Promise<void>((resolve) => { finish = resolve })
      pendingRequests.add(request)
      try { await next() } finally { pendingRequests.delete(request); finish() }
      return undefined
    })
  }

  function mountEvents(app: Hono, mount: WorkspaceHostMountOptions, sessionAccessPolicy: SessionAccessPolicy): MountedWorkspaceEvents {
    const directory = options.target?.directory ?? workspaceDir()
    const id = options.target?.workspaceId ?? workspaceId()
    if (mount.core) {
      return mountWorkspaceCore(app, mount.core.upgradeWebSocket, {
        directory, workspaceId: id, eventHub, exposure: mount.exposure, sessionAccessPolicy,
        processObserver: options.processObserver, sessionStarts,
        sessionParents: options.sessionParents ?? sessionParents, transcripts: options.transcripts, launchOwnership,
      })
    }
    const events = mountWorkspaceEvents(app, {
      directory, workspaceId: id, eventHub, sessionAccessPolicy, sessionStarts,
      sessionParents: options.sessionParents ?? sessionParents,
      ...(mount.renewalIntervalMs !== undefined ? { renewalIntervalMs: mount.renewalIntervalMs } : {}),
    })
    if (mount.pty) mountWorkspacePty(app, mount.pty.upgradeWebSocket, options.processObserver, sessionAccessPolicy, { ownership: launchOwnership })
    if (mount.process) mountWorkspaceProcess(app, sessionAccessPolicy, { ownership: launchOwnership })
    if (mount.agentHooks) mountWorkspaceAgentHooks(app, sessionAccessPolicy)
    return events
  }

  return {
    mount(app: Hono, mount: WorkspaceHostMountOptions) {
      mountGate(app)
      assertWorkspaceRuntimeExposure({ exposure: mount.exposure, env: process.env })
      const sessionAccessPolicy = options.sessionAccessPolicy
        ?? (mount.exposure.kind === "loopback" ? managedWorkspaceSessionAccessPolicy() : undefined)
      if (!sessionAccessPolicy) throw new Error("Managed workspace session routes require SessionAccessPolicy")
      if (mount.exposure.kind !== "loopback" && mount.exposure.kind !== "embedded" && sessionAccessPolicy.sessionAuthority !== "managed-private") {
        throw new Error("Managed workspace session routes require authority-backed SessionAccessPolicy")
      }
      const events = mountEvents(app, mount, sessionAccessPolicy)
      closeEvents()
      const detachFrames = events.frames.subscribe((frame) => hostFrames.emit(frame))
      closeEvents = () => {
        detachFrames()
        events.close()
      }
      app.get("/api/wr/harness-providers", async (c) => {
        const refused = providerCatalogRefusal(c)
        if (refused) return refused
        const harness = requestedSessionHarness(c.req)
        if (!harness) return c.json(errorBody("harness_required", "Name the harness whose provider catalog to read"), 400)
        const directory = assertTarget(c.req.query("directory") || workspaceDir())
        const runtime = await runtimeForSession()
        const target = { harness, directory, owner: sessionOwner(c) }
        try {
          if (!await runtime.reads.servesProviderCatalog(target)) return c.json(errorBody("provider_catalog_unsupported", `${harness.id} serves no provider catalog`), 400)
          return c.json(await runtime.reads.providerCatalog(target))
        } catch (cause) {
          const refused = harnessUnavailableResponse(c, cause)
          if (refused) return refused
          throw cause
        }
      })
      app.get("/api/wr/harness-config-options", async (c) => {
        let targetRunner: RuntimeRunner
        try {
          targetRunner = requestedSessionHarness(c.req) ?? currentRunner()
        } catch (cause) {
          if (cause instanceof WorkspaceHarnessUnavailableError) return c.json({ ok: false, error: { code: cause.code, message: cause.message } }, 409)
          throw cause
        }
        const directory = assertTarget(c.req.query("directory") || workspaceDir())
        try {
          const runtime = await runtimeForSession()
          const target = { harness: targetRunner, directory, owner: sessionOwner(c) }
          if (await runtime.reads.servesProviderCatalog(target)) {
            const refused = providerCatalogRefusal(c)
            if (refused) return refused
          }
          const preview = await runtime.reads.configOptions(target, c.req.query("model") || undefined)
          if (!preview) {
            return c.json({ ok: false, error: { code: "harness_config_options_unavailable", harness: targetRunner.id,
              message: `${targetRunner.id} does not expose harness config options` } }, 404)
          }
          return c.json(preview)
        } catch (cause) {
          const refused = harnessUnavailableResponse(c, cause)
          if (refused) return refused
          if (cause instanceof PreviewModelInvalidError) return c.json(errorBody("preview_model_invalid", cause.message), 400)
          return c.json({ ok: false, error: { code: "harness_config_options_unavailable", harness: targetRunner.id, message: errorMessage(cause) } }, 502)
        }
      })
      app.get("/vcs", async (c) => c.json(await localVcsInfo(requestDirectory(c))))
      const sessions = mountSessionRoutes({
        runtime: runtimeForSession,
        recovery: () => engine?.runtime.recovery,
        store,
        sessionStarts,
        eventHub,
        sessionAccessPolicy,
        checkpoint,
        currentRunner,
        transcripts: options.transcripts,
        afterCreateSession: options.afterCreateSession,
        sessionIdWorkspace: options.sessionIdWorkspace,
        sessionToolPrompt: (sessionId) => {
          const registration = sessionToolPrompts.get(sessionId)
          return registration ? scopedToolPrompt(sessionId, registration) : undefined
        },
        subagentAdmission: (parentSessionId, observation) => harnessEngine().runtime.subagents.admit(parentSessionId, observation),
      })
      disposeDeliveries = sessions.dispose
      app.route("/", sessions.routes)
      reissueQueuedPrompts = () => {
        const reissue = () => void sessions.recoverQueuedPrompts()
        if (options.target) withWorkspaceTarget(options.target, reissue)
        else reissue()
      }
      if (runner) reissueQueuedPrompts()
    },
    hasSession(sessionId: string) {
      return !!store().getSession(sessionId)
    },
    sessionTime(sessionId: string) {
      const session = store().getSession(sessionId)
      return session ? runtimeSessionTime(session) : undefined
    },
    drivenOnlyByMachineUser(sessionId: string, ownerActorId?: string) {
      const current = store()
      return !!current.getSession(sessionId) && !current.relayedTurnInLineage(sessionId, ownerActorId)
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
        providerDefinitions: currentProviderDefinitions,
        workspaceHarnessEnabled: enabled,
        harnessLaunch,
        commands: currentCommands,
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
        connectionState: connectionState(),
        workspaceHarnessEnabled: enabled,
        configApply,
      }
    },
    readHarnessHealth: sessionHarnessHealth,
    readConnectionState: connectionState,
    capabilities() {
      return workspaceCapabilities(enabled)
    },
    activeTurns() {
      const turns: RecoveryTurnTarget[] = []
      const recovery = engine?.runtime.recovery
      if (!recovery) return turns
      for (const turn of checkpoint.activeTurns()) {
        const target = recovery.inspect(turn.sessionId, turn.directory).target
        if (target) turns.push(target)
      }
      return turns
    },
    ownerGeneration,
    store,
    whenStoreOpens: durable.whenOpened,
    async launchReconciliation() {
      return await durable.launchReconciliation()
    },
    async unresolvedLaunches() {
      if (closing) throw new HTTPException(503, { message: "Workspace runtime is disposed" })
      const ownership = launchOwnership()
      await durable.launchReconciliation()
      return await ownership.listUnresolved(launchOwner.scope)
    },
    activity() {
      const launchSummary = durable.launchSummary()
      return {
        activeTurns: checkpoint.activeTurnCount(),
        activeWrites: checkpoint.detail().activeWrites,
        checkpointState: checkpoint.state(),
        ...(launchSummary
          ? { launches: { examined: launchSummary.examined, live: launchSummary.live,
              retired: launchSummary.retired, unresolved: launchSummary.unresolved.length } }
          : {}),
      }
    },
    async registerSessionTools(input) {
      if (closing) throw new HTTPException(503, { message: "Workspace runtime is disposed" })
      const config = store().getSessionConfig(input.sessionId)
      const directory = store().getSession(input.sessionId)?.directory ?? options.target?.directory ?? workspaceDir()
      const running = harnessEngine()
      const attached = running.runtime.attachments.peek(input.sessionId)
      // A connection's transport exists only under a secret lease, which a
      // registration holds no proof for: until the session is attached, its
      // tools travel in the prompt.
      const handle = attached?.handle
        ?? (config?.harness.access === "native"
          ? await running.transports.forHarness(config.harness, directory, { owner: running.runtime.attachments.owner(input.sessionId) })
          : undefined)
      if (!handle?.transport.sessionTools) {
        sessionToolPrompts.set(input.sessionId, input)
        return
      }
      const { transport, session } = attached ? { transport: attached.handle.transport, session: attached.session }
        : await running.runtime.transportFor(input.sessionId)
      if (!transport.sessionTools) throw new Error(`Session ${input.sessionId} moved to a harness without session tools`)
      sessionToolPrompts.delete(input.sessionId)
      await transport.sessionTools.register(session, {
        tools: input.tools,
        execute: async (call) => {
          if (!input.dispatch) throw new Error("Session tool callback is unavailable")
          const selected = input.tools.find((tool) => tool.name === call.name)
          if (!selected) throw new Error(`Session tool ${call.name} is unregistered`)
          return input.dispatch(selected.callbackUrl ?? input.callbackUrl, { sessionID: input.sessionId, ...call })
        },
      })
    },
    async unregisterSessionTools(sessionId) {
      sessionToolPrompts.delete(sessionId)
      const attached = engine?.runtime.attachments.peek(sessionId)
      if (attached?.handle.transport.sessionTools) await attached.handle.transport.sessionTools.unregister(attached.session)
    },
    checkpoint: {
      detail: checkpoint.detail,
      beginWrite: () => checkpoint.beginWrite(),
      freeze: (policy, freezeOptions) => checkpoint.freeze(policy, freezeOptions),
      async flush() {
        if (checkpoint.state() !== "frozen") throw new Error("workspace_checkpoint_not_frozen")
        await snapshots.run("snapshot", async () => {})
        durable.flush()
      },
      async scrub() {
        if (checkpoint.state() !== "frozen") throw new Error("workspace_checkpoint_not_frozen")
        const retired = engine
        engine = undefined
        appliedSignature = undefined
        if (retired) await retireTransports(retired.transports)
      },
      async resume() {
        if (closing) throw new HTTPException(503, { message: "Workspace runtime is disposed" })
        return checkpoint.resume()
      },
      async restoreReconcile(input) {
        if (closing) throw new HTTPException(503, { message: "Workspace runtime is disposed" })
        if (!Number.isSafeInteger(input.epoch) || input.epoch < 1 || !input.checkpointId) throw new Error("workspace_checkpoint_reconcile_invalid")
        return checkpoint.restoreReconcile(input.epoch)
      },
    },
    dispose() {
      if (disposal) return disposal
      closing = true
      healthFeed.dispose()
      const deliveriesDone = disposeDeliveries?.()
      checkpoint.abortAll()
      engine?.runtime.abortStarts()
      // Transport teardown starts first: a pending create, an unanswered
      // request or a running turn may only settle once its harness is stopped.
      const transportsDone = Promise.all([engine?.transports.disposeAll(), ...[...retiredTransports].map(retireTransports)])
      disposal = (async () => {
        const [, runtimeResult] = await Promise.all([
          transportsDone,
          (async () => {
            await Promise.allSettled([snapshots.run("snapshot", async () => {}), ...pendingRequests])
            return engine?.runtime.dispose()
          })(),
          deliveriesDone,
        ])
        if (runtimeResult && !runtimeResult.ok) throw runtimeResult.error
        checkpoint.clear()
        cleanupPresentationObserver()
        cleanupRuntimeObserver()
        closeEvents()
        sessionToolPrompts.clear()
        durable.close()
        engine = undefined
      })()
      void disposal.catch((error) => {
        disposal = undefined
        log.error("Workspace shutdown failed", { error })
      })
      return disposal
    },
  }
}

async function localVcsInfo(directory: string) {
  const gitLine = async (args: string[]) => {
    try {
      return (await runGit(args, directory)).trim() || undefined
    } catch {
      return undefined
    }
  }
  const [branch, remoteHead] = await Promise.all([
    gitLine(["branch", "--show-current"]),
    gitLine(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
  ])
  return {
    ...(branch ? { branch } : {}),
    ...(remoteHead ? { default_branch: remoteHead.replace(/^origin\//, "") } : {}),
  }
}
