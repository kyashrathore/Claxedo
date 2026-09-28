import type { RecoveryTurnTarget } from "@claxedo/agent-runtime-contract"
import { DEFAULT_RECOVERY_BUDGETS, type AgentTurnOutcome } from "@claxedo/agent-runtime-contract"
import type { CompatEnvelope } from "@claxedo/agent-sdk-runtime/compat-events"
import type { BrokerPorts } from "@claxedo/harness/broker"
import { createHarnessComposer } from "@claxedo/harness/compose"
import type { CustomHarnessProvider } from "@claxedo/harness/providers"
import type { HarnessServices, MachineLoginPolicy } from "@claxedo/harness/contract"
import type { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { clearOpaqueTimer } from "@claxedo/helpers"
import { volatileLaunchOwnership, type LaunchOwnershipOwner } from "@claxedo/process-ownership/launch"
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
import { createAgentRuntime, type AgentRuntime, type AgentRuntimeHealth, type LaunchComposer } from "../host/runtime"
import { Log } from "../log"
import type { ProcessObserver } from "../managed-processes/process-observer"
import { reconcileLaunchOwnership, type LaunchOwnershipReconciliation } from "../ownership/reconcile-launch-ownership"
import { createRuntimeEventHub, type RuntimeEventEnvelope, type RuntimeEventHub } from "../projection/runtime-event-hub"
import { normalizeRuntimeSnapshot, requestedSessionHarness, RUNTIME_NATIVE_HARNESS_IDS, RuntimeConfigApplyError, type AppliedRuntimeSnapshot, type RuntimeConnectionDescriptor, type RuntimeHarnessSelection, type RuntimeSnapshot } from "../routes/config"
import { createWorkspaceEventFramesTap, type WorkspaceEventParents } from "../routes/events"
import { isSessionRecoveryPath, sessionOwner } from "../routes/session-core"
import { managedWorkspaceSessionAccessPolicy, type SessionAccessPolicy } from "../session-access-policy"
import { RuntimeStore } from "../store"
import { runGit } from "../git"
import { assertTarget, authoritativeWorkspaceId, withWorkspaceTarget, workspaceDir, workspaceId, type WorkspaceTarget } from "../target"
import { createWorkspaceCheckpoint } from "./checkpoint"
import { createSessionConfiguration } from "./configure"
import { mountWorkspaceCore, mountWorkspaceAgentHooks, mountWorkspaceEvents, mountWorkspaceProcess, mountWorkspacePty, type MountedWorkspaceEvents, type WorkspaceTranscriptRoutesOptions } from "./core"
import type { RuntimeConfigApplyStatus, WorkspaceConnectionState, WorkspaceHost, WorkspaceHostMountOptions } from "./host"
import { mountSessionRoutes } from "./session-routes"
import { assertConnectionRevision, connectionConfigHooks, errorMessage, harnessKey, persistRuntimeConfigApplyStatus, runnerForSelection, runtimeConfigApplyError, runtimeSnapshotSignature, sameAuth, sameRuntimeMcp, validateDescriptors, type RuntimeRunner } from "./snapshot"
import { createWorkspaceTransports } from "./transports"
import type { ConnectionSecretResolver } from "@claxedo/agent-sdk-runtime"

export type { RuntimeRunner } from "./snapshot"

export type WorkspaceRuntimeStore = RuntimeStore

export type WorkspaceRuntimeStoreFactory = (input: { storeRoot?: string }) => WorkspaceRuntimeStore

export type { ConnectionSecretResolver } from "@claxedo/agent-sdk-runtime"

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

const defaultStoreFactory: WorkspaceRuntimeStoreFactory = ({ storeRoot }) => new RuntimeStore(storeRoot)

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

function mcpStatus(config: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(config).map((name) => [name, { status: "disabled" }]))
}

export function createWorkspaceHost(options: WorkspaceHostOptions): WorkspaceHost {
  const eventHub = options.eventHub ?? createRuntimeEventHub()
  let closeEvents: () => void = () => {}
  const hostFrames = createWorkspaceEventFramesTap()
  const sessionParents: WorkspaceEventParents = {
    parentSessionIdFor: (sessionId) => (store().getSession(sessionId) as { parentID?: string | null } | null)?.parentID ?? undefined,
  }
  const cleanupCompatObserver = options.onCompatEvent ? eventHub.subscribeGlobal(options.onCompatEvent) : () => undefined
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
  let currentAuthRaw: AppliedRuntimeSnapshot["auth"] = { machineOwnerUserId: options.placement.machineOwnerUserId, accounts: {} }
  let currentHarnessLaunch: Record<string, Record<string, unknown>> = {}
  let appliedConnections = new Map<string, RuntimeConnectionDescriptor>()
  let applyQueue = Promise.resolve()
  const storeFactory = resolveStoreFactory(options)
  let sessionConfigStore: WorkspaceRuntimeStore | undefined
  let launchReconciliation: Promise<LaunchOwnershipReconciliation> | undefined
  let launchOwnershipSummary: LaunchOwnershipReconciliation | undefined
  const ownerGeneration = crypto.randomUUID()
  const assignedWorkspaceId = options.target?.workspaceId ?? authoritativeWorkspaceId()
  const launchOwner: LaunchOwnershipOwner = {
    ownerGeneration,
    scope: assignedWorkspaceId ? { kind: "workspace", workspaceId: assignedWorkspaceId } : { kind: "standalone" },
  }
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

  function store() {
    if (!sessionConfigStore) {
      if (closing) throw new HTTPException(503, { message: "Workspace runtime is disposed" })
      sessionConfigStore = storeFactory({ storeRoot })
      const ownership = sessionConfigStore.launchOwnership(launchOwner)
      // Started before anything else this store does, because until it has
      // run the processes of a previous owner still hold this workspace's
      // ports, working directories and agent session storage, and nothing
      // else in the system is looking for them.
      launchReconciliation = reconcileLaunchOwnership(ownership, {
        currentOwnerGeneration: ownerGeneration,
        scope: launchOwner.scope,
        budgets: DEFAULT_RECOVERY_BUDGETS,
      }).then((summary) => {
        launchOwnershipSummary = summary
        return summary
      })
      sessionConfigStore.recoverBusySessions()
    }
    return sessionConfigStore
  }

  async function assertLaunchAdmission() {
    store()
    if (!launchReconciliation) return
    const summary = await launchReconciliation
    if (summary.unresolved.length === 0) return
    throw new HTTPException(503, {
      message: `workspace_launch_unreconciled: ${summary.unresolved
        .map((row) => `${row.launchId} (${row.outcome}: ${row.reason})`)
        .join("; ")}`,
    })
  }

  function launchOwnership() {
    return store().launchOwnership(launchOwner) ?? volatileLaunchOwnership(launchOwner)
  }

  const resolveSnapshotConnectionSecrets: ConnectionSecretResolver = async ({ descriptor }) => {
    if (Object.keys(descriptor.secretRefs ?? {}).length > 0) {
      throw new WorkspaceHarnessUnavailableError({ id: descriptor.connectionId, access: "connection" })
    }
    return { secrets: {}, secretLeaseGeneration: `runtime-config:${configApplyRevision}` }
  }

  const launch: LaunchComposer = {
    workspaceId: options.target?.workspaceId ?? workspaceId(),
    projection: (harness) => pluginProjectionFor(harness, {
      generation: `runtime-config:${configApplyRevision}`, mcp: currentMcp, harnessLaunch: currentHarnessLaunch,
    }),
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
  const patternEvaluator = createElicitationPatternEvaluator()

  function harnessEngine(): Engine {
    if (engine) return engine
    if (closing) throw new HTTPException(503, { message: "Workspace runtime is disposed" })
    const runtimeStore = store()
    const services = createHarnessServices({
      ownership: launchOwnership(),
      ...(options.transcripts ? { transcripts: options.transcripts } : {}),
      ...(options.firstPartyMcpLaunch ? { firstPartyMcpLaunch: options.firstPartyMcpLaunch } : {}),
      log: { debug: (message, fields) => log.info(message, fields), info: (message, fields) => log.info(message, fields),
        warn: (message, fields) => log.warn(message, fields), error: (message, fields) => log.error(message, fields) },
      clock: { now: () => Date.now(), setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: clearOpaqueTimer },
      patternEvaluator,
    })
    void sweepIdleHarnessHomes(harnessStateRoot).catch((error: unknown) => log.warn("Idle harness home sweep failed", { error: String(error) }))
    const composer = createHarnessComposer(services, harnessCompositionOptions({
      env, placement: options.placement, harnessStateRoot, opencodeRoot: `${storeRoot}/opencode`, store,
    }), options.connectionProviders ?? [])
    const transports = createWorkspaceTransports({
      composer,
      connections: () => appliedConnections,
      resolveSecrets: (descriptor, directory) => (options.resolveConnectionSecrets ?? resolveSnapshotConnectionSecrets)({ descriptor, directory }),
    })
    const ports = createStoreBrokerPorts(runtimeStore, {
      ownerGeneration,
      patternEvaluator,
      publishers: eventHub,
      reportOwnerFailure: (sessionId, error) => engine?.runtime.recovery.reportOwnerFailure(sessionId, error),
    })
    const configuration = createSessionConfiguration({
      attached: () => engine?.runtime.attachments.entries() ?? [],
      projection: (attached) => launch.projection(attached.handle.runner),
      credentials: (attached) => sessionCredentials(launch, { owner: attached.owner, config: runtimeStore.getSessionConfig(attached.session.binding.sessionId)! }),
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
      afterTurn: (sessionId) => configuration.afterTurn(sessionId),
    })
    engine = { services, transports, ports, runtime, configuration }
    return engine
  }

  async function runtimeForSession() {
    if (closing) throw new HTTPException(503, { message: "Workspace runtime is disposed" })
    await options.beforeHarnessAcquire?.()
    return harnessEngine().runtime
  }

  const checkpoint = createWorkspaceCheckpoint({
    recovery: () => engine?.runtime.recovery,
    afterTurnScope: () => {},
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
      currentHarnessLaunch = nextHarnessLaunch
      if (engine) await engine.configuration.apply({ credentials: credentialsChanged, projection: projectionChanged })
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
    const pending = applyQueue.then(() => applySnapshot(normalized), () => applySnapshot(normalized))
    applyQueue = pending.catch(() => {})
    return pending
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
      if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
        try {
          await assertLaunchAdmission()
        } catch (error) {
          if (!(error instanceof HTTPException)) throw error
          return c.json({ error: error.message }, 503)
        }
      }
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
        processObserver: options.processObserver, sessionStarts: store().sessionStarts,
        sessionParents: options.sessionParents ?? sessionParents, transcripts: options.transcripts, launchOwnership,
      })
    }
    const events = mountWorkspaceEvents(app, {
      directory, workspaceId: id, eventHub, sessionAccessPolicy, sessionStarts: store().sessionStarts,
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
          const requested = c.req.query("model") || undefined
          const preview = await runtime.reads.configOptions({ harness: targetRunner, directory, owner: sessionOwner(c) },
            requested ? { providerID: harnessKey(targetRunner), modelID: requested } : undefined)
          if (!preview) {
            return c.json({ ok: false, error: { code: "harness_config_options_unavailable", harness: targetRunner.id,
              message: `${targetRunner.id} does not expose harness config options` } }, 404)
          }
          return c.json(preview)
        } catch (cause) {
          const refused = harnessUnavailableResponse(c, cause)
          if (refused) return refused
          return c.json({ ok: false, error: { code: "harness_config_options_unavailable", harness: targetRunner.id, message: errorMessage(cause) } }, 502)
        }
      })
      app.get("/mcp", async (c) => c.json(mcpStatus(currentMcp)))
      app.get("/vcs", async (c) => c.json(await localVcsInfo(requestDirectory(c))))
      const sessions = mountSessionRoutes({
        runtime: runtimeForSession,
        recovery: () => engine?.runtime.recovery,
        store,
        eventHub,
        sessionAccessPolicy,
        checkpoint,
        currentRunner,
        transcripts: options.transcripts,
        afterCreateSession: options.afterCreateSession,
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
        connectionState: connectionState(),
        workspaceHarnessEnabled: enabled,
        configApply,
      }
    },
    async readHarnessHealth(input) {
      const directory = input.directory ?? store().getSession(input.sessionId)?.directory ?? options.target?.directory ?? workspaceDir()
      return engine?.runtime.reads.sessionHealth(input.sessionId, directory) ?? { status: "ok" }
    },
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
    async launchReconciliation() {
      return await launchReconciliation
    },
    async unresolvedLaunches() {
      if (closing) throw new HTTPException(503, { message: "Workspace runtime is disposed" })
      const ownership = store().launchOwnership(launchOwner)
      await launchReconciliation
      return await ownership.listUnresolved(launchOwner.scope)
    },
    activity() {
      return {
        activeTurns: checkpoint.activeTurnCount(),
        activeWrites: checkpoint.detail().activeWrites,
        checkpointState: checkpoint.state(),
        ...(launchOwnershipSummary
          ? { launches: { examined: launchOwnershipSummary.examined, live: launchOwnershipSummary.live,
              retired: launchOwnershipSummary.retired, unresolved: launchOwnershipSummary.unresolved.length } }
          : {}),
      }
    },
    async registerSessionTools(input) {
      if (closing) throw new HTTPException(503, { message: "Workspace runtime is disposed" })
      const config = store().getSessionConfig(input.sessionId)
      const directory = store().getSession(input.sessionId)?.directory ?? options.target?.directory ?? workspaceDir()
      const running = harnessEngine()
      const handle = config ? await running.transports.forHarness(config.harness, directory) : undefined
      if (!handle?.transport.sessionTools) {
        sessionToolPrompts.set(input.sessionId, input)
        return
      }
      const { transport, session } = await running.runtime.transportFor(input.sessionId)
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
        await applyQueue
        sessionConfigStore?.flush()
      },
      async scrub() {
        if (checkpoint.state() !== "frozen") throw new Error("workspace_checkpoint_not_frozen")
        appliedSignature = undefined
        await engine?.transports.disposeAll()
        engine = undefined
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
      const deliveriesDone = disposeDeliveries?.()
      checkpoint.abortAll()
      // Transport teardown starts first: a pending create, an unanswered
      // request or a running turn may only settle once its harness is stopped.
      const transportsDone = engine?.transports.disposeAll()
      disposal = (async () => {
        await Promise.allSettled([applyQueue, ...pendingRequests])
        await Promise.all([deliveriesDone, engine?.runtime.dispose(), transportsDone])
        checkpoint.clear()
        cleanupCompatObserver()
        cleanupRuntimeObserver()
        closeEvents()
        sessionToolPrompts.clear()
        sessionConfigStore?.close()
        sessionConfigStore = undefined
        engine = undefined
      })()
      void disposal.catch((error) => log.error("Workspace shutdown failed", { error }))
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
