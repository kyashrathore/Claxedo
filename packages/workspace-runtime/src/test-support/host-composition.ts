import type { SessionHarness } from "@claxedo/agent-runtime-contract"
import type { HarnessTransport } from "@claxedo/harness/contract"
import { createStoreBrokerPorts } from "../broker-ports"
import type { CreateAgentRuntimeInput } from "../host/contracts"
import type { LaunchComposer } from "../host/launch"
import { createAgentRuntime, type AgentRuntime } from "../host/runtime"
import type { HarnessHandle, TransportResolver } from "../host/transports"
import { createRuntimeEventHub, type RuntimeEventHub } from "../projection/runtime-event-hub"
import type { RuntimeStore } from "../store"

function isResolver(input: HostCompositionInput["transports"]): input is TransportResolver {
  return typeof (input as TransportResolver).forHarness === "function" && typeof (input as TransportResolver).composed === "function"
}

export function transportHandle(runner: SessionHarness, transport: HarnessTransport): HarnessHandle {
  return { key: `${runner.access}:${runner.id}`, runner, kind: transport.kind, transport, locality: "local", retired: () => false, pin: () => () => {} }
}

/** A resolver over transports keyed by harness id, the way a test names them. */
export function transportsById(transports: Record<string, HarnessTransport>): TransportResolver {
  const handles = new Map<string, HarnessHandle>()
  return {
    async forHarness(harness) {
      const held = handles.get(harness.id)
      if (held) return held
      const transport = transports[harness.id]
      if (!transport) throw new Error(`No transport is composed for harness ${harness.id}`)
      const handle = transportHandle(harness, transport)
      handles.set(harness.id, handle)
      return handle
    },
    composed: () => [...handles.values()],
    onRetire: () => () => {},
  }
}

export function testLaunch(workspaceId: string, users: string[] = []): LaunchComposer {
  return {
    workspaceId,
    projection: () => ({ generation: "test", mcpServers: [], pluginRoots: [], notApplied: [] }),
    credentials: () => ({ accounts: Object.fromEntries(users.map((user) => [user, { openai: { baseUrl: "https://fixture.example", placeholder: `fixture-${user}`, authMode: "api-key" as const } }])), machineOwnerUserId: "test-owner", placement: "loopback", canUseOwnLogin: true, leaseGeneration: "test" }),
  }
}

export type HostCompositionInput = {
  store: RuntimeStore
  launch?: LaunchComposer
  transports: Record<string, HarnessTransport> | TransportResolver
  workspaceId?: string
  ownerGeneration?: string
  subscriberBufferSize?: number
  recovery?: CreateAgentRuntimeInput["recovery"]
  identity?: CreateAgentRuntimeInput["identity"]
  afterTurn?: (sessionId: string) => Promise<void>
}

export type HostComposition = {
  store: RuntimeStore
  eventHub: RuntimeEventHub
  runtime: AgentRuntime
  ownerGeneration: string
}

/**
 * A host composed the way `createWorkspaceHost.harnessEngine()` composes it:
 * broker ports over the given store, the store's own event hub, and the
 * transports the test scripted in place of the workspace's composed ones.
 * It reaches no Node builtin, so a Durable Object composes the same host.
 */
export function composeHost(input: HostCompositionInput): HostComposition {
  const { store } = input
  const eventHub = createRuntimeEventHub()
  const workspaceId = input.workspaceId ?? "ws"
  const ownerGeneration = input.ownerGeneration ?? `owner_${crypto.randomUUID()}`
  const transports = isResolver(input.transports) ? input.transports : transportsById(input.transports)
  let runtime: AgentRuntime | undefined
  const ports = createStoreBrokerPorts(store, {
    ownerGeneration,
    patternEvaluator: async () => {},
    publishers: eventHub,
    reportOwnerFailure: (sessionId, error) => runtime?.recovery.reportOwnerFailure(sessionId, error),
    retainLeasedTurnFailure: (sessionId, turn, error) => runtime?.recovery.retainLeasedTurnFailure(sessionId, turn, error) ?? false,
  })
  runtime = createAgentRuntime({
    store, eventHub, transports, ports, ownerGeneration,
    launch: input.launch ?? testLaunch(workspaceId),
    identity: input.identity ?? { workspaceId },
    savedCommands: () => [],
    ...(input.subscriberBufferSize !== undefined ? { subscriberBufferSize: input.subscriberBufferSize } : {}),
    ...(input.recovery ? { recovery: input.recovery } : {}),
    ...(input.afterTurn ? { afterTurn: input.afterTurn } : {}),
  })
  return { store, eventHub, runtime, ownerGeneration }
}
