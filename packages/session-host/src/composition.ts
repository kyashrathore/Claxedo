import type { SessionHarness } from "@claxedo/agent-runtime-contract"
import type { HarnessServices, PluginProjection } from "@claxedo/harness/contract"
import { PiDurableTransport, type PiPlacement, type PiTurnContext } from "@claxedo/harness/pi-durable"
import {
  composeSessionRoutes, createAgentRuntime, createSessionCore, createRuntimeEventHub, createStoreBrokerPorts, durableObjectSqliteDatabase,
  pluginProjectionFor, RuntimeStore, sessionCredentials, sessionEventDeliveryPolicy, type DurableObjectSqlStorage, type LaunchComposer,
  type SessionAccessPolicy, type TransportResolver,
} from "@claxedo/session-core"
import { createRelayHostAuthMiddleware, type RelayHostAuthOptions } from "@claxedo/session-core/relay-host"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import { Hono } from "hono"
import type { HeldTurn } from "./turn-delivery"

/** The session-core label of the one place a session host's session lives; its files are the workspace machine's. */
export const SESSION_HOST_DIRECTORY = "/workspace"

const PI: SessionHarness = { id: "pi", access: "native" }
const NO_PROJECTION: PluginProjection = { generation: "none", mcpServers: [], pluginRoots: [], notApplied: [] }

export type SessionHostCompositionInput = {
  root: string
  workspaceId: string
  storage: DurableObjectSqlStorage
  key: RelayHostAuthOptions["key"]
  policy: SessionAccessPolicy
  placement: PiPlacement
  held: () => HeldTurn | undefined
  beforeDelete: (sessionId: string, credential: string | undefined) => Promise<void>
}

function launchFromTurn(workspaceId: string, held: () => HeldTurn | undefined): LaunchComposer {
  return {
    workspaceId,
    projection: (harness) => {
      const turn = held()
      return turn ? pluginProjectionFor(harness, { ...turn.delivery.plugins, generation: turn.generation }) : NO_PROJECTION
    },
    credentials: () => {
      const turn = held()
      if (!turn) return undefined
      const { machineOwnerUserId, direct } = turn.delivery.auth
      return { machineOwnerUserId, accounts: {}, ...(direct ? { direct } : {}), placement: "cloud", canUseOwnLogin: false, leaseGeneration: turn.key }
    },
    providerDefinitions: () => held()?.delivery.providerDefinitions ?? [],
  }
}

function services(clock: HarnessServices["clock"]): HarnessServices {
  return {
    recordHomeUse: async () => {},
    spawn: async () => { throw new Error("A session host starts no process; its tools run on the workspace machine") },
    firstPartyMcp: () => undefined,
    healthChanged: () => {},
    patternEvaluator: async () => {},
    log: console,
    clock,
  }
}

function piOnly(transport: PiDurableTransport): TransportResolver {
  const handle = { key: "native:pi", runner: PI, kind: transport.kind, transport, locality: "remote" as const, retired: () => false, pin: () => () => {} }
  return {
    forHarness: async (harness) => {
      if (harness.id !== PI.id || harness.access !== PI.access) throw new Error(`A session host runs Pi, not ${harness.access} ${harness.id}`)
      return handle
    },
    composed: () => [handle],
    onRetire: () => () => {},
  }
}

/**
 * One session host's session core: the store on the object's SQLite, Pi as
 * its only harness, and the shared session routes and event stream behind the
 * relay's host token, authorized by the control plane.
 */
export function composeSessionHost(input: SessionHostCompositionInput) {
  const { root, workspaceId, policy } = input
  const store = new RuntimeStore({ db: durableObjectSqliteDatabase(input.storage), location: sessionHostId(root), flush: () => {} })
  const eventHub = createRuntimeEventHub()
  const ownerGeneration = `session-host_${crypto.randomUUID()}`
  const launch = launchFromTurn(workspaceId, input.held)
  const ports = createStoreBrokerPorts(store, {
    ownerGeneration, patternEvaluator: async () => {}, publishers: eventHub,
    reportOwnerFailure: (sessionId, error) => runtime.recovery.reportOwnerFailure(sessionId, error),
    retainLeasedTurnFailure: (sessionId, turn, error) => runtime.recovery.retainLeasedTurnFailure(sessionId, turn, error),
  })
  const runtime = createAgentRuntime({
    log: console, store, eventHub, transports: piOnly(new PiDurableTransport(services(ports.clock), input.placement)), ports, ownerGeneration, launch,
    identity: { workspaceId }, savedCommands: () => [],
  })
  const core = createSessionCore({
    eventHub,
    placement: {
      workspaceId, directory: SESSION_HOST_DIRECTORY, normalizeDirectory: (path) => path.trim(), canonicalDirectory: (path) => path,
      containsDirectory: (dir, candidate) => candidate === dir, sessionIdWorkspace: () => undefined,
    },
  })
  const sessions = composeSessionRoutes({
    core, runtime: async () => runtime, recovery: () => runtime.recovery, store: () => store, sessionStarts: store.sessionStarts,
    sessionAccessPolicy: policy, currentRunner: () => PI,
    deriveChildSessionId: () => { throw new Error("A session host's Pi session has no subagents") },
    subagentAdmission: (parentSessionId, observation) => runtime.subagents.admit(parentSessionId, observation),
    backgroundWork: (sessionId) => ports.backgroundWork.read(sessionId),
    beforeDeleteSession: ({ sessionId, credential }) => input.beforeDelete(sessionId, credential),
  })
  const events = core.events({
    directory: SESSION_HOST_DIRECTORY, workspaceId, policy: sessionEventDeliveryPolicy(policy), sessionAccessPolicy: policy, sessionStarts: store.sessionStarts,
  })
  const app = new Hono()
    .use("*", createRelayHostAuthMiddleware({ key: input.key, workspaceId, hostId: sessionHostId(root) }))
    .get("/api/wr/events", events)
    .route("/", sessions.routes)
  const turnContext = async (): Promise<PiTurnContext> => {
    const owner = store.sessionOwner(root)
    const config = store.getSessionConfig(root)
    if (!owner || !config) throw new Error(`Session ${root} is not in this session host`)
    return { credentials: sessionCredentials(launch, { owner, config }), projection: launch.projection(config.harness),
      providerDefinitions: launch.providerDefinitions?.() ?? [] }
  }
  return { store, runtime, sessions, app, turnContext }
}

export type SessionHost = ReturnType<typeof composeSessionHost>
