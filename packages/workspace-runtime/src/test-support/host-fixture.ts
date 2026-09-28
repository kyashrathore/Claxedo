import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { RecoveryOperation, RecoveryOutcome, RecoveryRequest, RecoveryTurnTarget, SessionHarness } from "@claxedo/agent-runtime-contract"
import type { HarnessTransport, TurnActor, TurnOrigin } from "@claxedo/harness/contract"
import { createStoreBrokerPorts } from "../broker-ports"
import type { AgentRuntimeRecovery, CreateAgentRuntimeInput, RecoveryCaller } from "../host/contracts"
import type { LaunchComposer } from "../host/launch"
import { createAgentRuntime, type AgentRuntime } from "../host/runtime"
import type { HarnessHandle, TransportResolver } from "../host/transports"
import { createRuntimeEventHub, type RuntimeEventHub } from "../projection/runtime-event-hub"
import { RuntimeStore } from "../store"
import type { FakeTurn } from "./fake-transport"

export const MACHINE_OWNER: TurnActor = { kind: "machine-owner" }
export const LOOPBACK_ORIGIN: TurnOrigin = { actor: MACHINE_OWNER, via: "loopback", reissued: false }

function isResolver(input: HostFixtureInput["transports"]): input is TransportResolver {
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
  }
}

export function testLaunch(workspaceId: string, users: string[] = []): LaunchComposer {
  return {
    workspaceId,
    projection: () => ({ generation: "test", mcpServers: [], pluginRoots: [], notApplied: [] }),
    credentials: () => ({ accounts: Object.fromEntries(users.map((user) => [user, { openai: { baseUrl: "https://fixture.example", placeholder: `fixture-${user}`, authMode: "api-key" as const } }])), machineOwnerUserId: "test-owner", placement: "loopback", canUseOwnLogin: true, leaseGeneration: "test" }),
  }
}

export function tempStoreRoot(prefix = "host-fixture-") {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

export type HostFixtureInput = {
  launch?: LaunchComposer
  /** A store the test owns and closes itself; the fixture opens one in a temp root otherwise. */
  store?: RuntimeStore
  transports: Record<string, HarnessTransport> | TransportResolver
  workspaceId?: string
  ownerGeneration?: string
  subscriberBufferSize?: number
  recovery?: CreateAgentRuntimeInput["recovery"]
  identity?: CreateAgentRuntimeInput["identity"]
  afterTurn?: (sessionId: string) => Promise<void>
}

export type HostFixture = {
  store: RuntimeStore
  eventHub: RuntimeEventHub
  runtime: AgentRuntime
  ownerGeneration: string
  /** Disposes the runtime and, when the fixture opened the store, closes it and removes its root. */
  dispose: () => Promise<void>
}

/**
 * A host composed the way `createWorkspaceHost.harnessEngine()` composes it:
 * broker ports over the real store, the store's own event hub, and the
 * transports the test scripted in place of the workspace's composed ones.
 */
export function createHostFixture(input: HostFixtureInput): HostFixture {
  const root = input.store ? undefined : tempStoreRoot()
  const store = input.store ?? new RuntimeStore(root)
  const eventHub = createRuntimeEventHub()
  const workspaceId = input.workspaceId ?? "ws"
  const ownerGeneration = input.ownerGeneration ?? `owner_${randomUUID()}`
  const transports = isResolver(input.transports) ? input.transports : transportsById(input.transports)
  let runtime: AgentRuntime | undefined
  const ports = createStoreBrokerPorts(store, {
    ownerGeneration,
    patternEvaluator: async () => {},
    publishers: eventHub,
    reportOwnerFailure: (sessionId, error) => runtime?.recovery.reportOwnerFailure(sessionId, error),
  })
  runtime = createAgentRuntime({
    store, eventHub, transports, ports, ownerGeneration,
    launch: input.launch ?? testLaunch(workspaceId),
    identity: input.identity ?? { workspaceId },
    ...(input.subscriberBufferSize !== undefined ? { subscriberBufferSize: input.subscriberBufferSize } : {}),
    ...(input.recovery ? { recovery: input.recovery } : {}),
    ...(input.afterTurn ? { afterTurn: input.afterTurn } : {}),
  })
  return {
    store, eventHub, runtime, ownerGeneration,
    dispose: async () => {
      await runtime.dispose()
      if (!root) return
      store.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export function sessionCreate(overrides: { id?: string; directory?: string; harness?: SessionHarness; workspaceId?: string } = {}) {
  return {
    ...(overrides.id ? { id: overrides.id } : {}),
    workspaceId: overrides.workspaceId ?? "ws",
    directory: overrides.directory ?? "/repo",
    harness: overrides.harness ?? { id: "pi", access: "native" as const },
    owner: MACHINE_OWNER,
    origin: LOOPBACK_ORIGIN,
  }
}

export type TurnControl = {
  finish: () => void
  fail: (message: string) => void
  events: AsyncIterable<AgentRuntimeEvent>
}

/** A turn whose end the test decides: `finish` yields the terminal event, `fail` throws out of the stream. */
export function controlledTurn(sessionId: string): TurnControl {
  let settle!: (error?: string) => void
  const ended = new Promise<string | undefined>((resolve) => { settle = resolve })
  return {
    finish: () => settle(undefined),
    fail: (message) => settle(message),
    events: {
      async *[Symbol.asyncIterator]() {
        const failure = await ended
        if (failure) throw new Error(failure)
        yield { type: "finish", sessionId }
      },
    },
  }
}

export function promptText(turn: FakeTurn) {
  return turn.turn.prompt.parts.map((part) => ("text" in part ? part.text : "")).join("")
}

export async function until(condition: () => boolean, label = "condition") {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  if (!condition()) throw new Error(`condition never held: ${label}`)
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

export async function collectUntilFinish<T extends { payload: { type: string } }>(events: AsyncIterable<T>) {
  const out: T[] = []
  for await (const event of events) {
    out.push(event)
    if (event.payload.type === "finish" || event.payload.type === "session.idle" || event.payload.type === "session.error") return out
  }
  return out
}

export const RECOVERY_TEST_CALLER: RecoveryCaller = { callerId: "test-caller", authority: "session" }

export function cancelTurnRequest(target: RecoveryTurnTarget, overrides: Partial<RecoveryRequest> = {}): RecoveryRequest {
  return {
    requestId: `req_${randomUUID()}`,
    action: "cancel_turn",
    target,
    scopeRevision: "1",
    attempt: 1,
    ...overrides,
  }
}

/** Stop a session's current turn the way a caller does: read its identity, then send it back. */
export async function cancelRuntimeTurn(
  runtime: { recovery: AgentRuntimeRecovery },
  sessionId: string,
  overrides: Partial<RecoveryRequest> = {},
): Promise<RecoveryOutcome> {
  const target = runtime.recovery.inspect(sessionId).target
  if (!target) throw new Error(`Session ${sessionId} has no admitted turn to cancel`)
  return await runtime.recovery.submit(cancelTurnRequest(target, overrides), RECOVERY_TEST_CALLER)
}

/** The operation a submit answered with, or a failure naming the refusal it returned. */
export function submittedOperation(outcome: RecoveryOutcome): RecoveryOperation {
  if (outcome.kind === "refused") throw new Error(`recovery refused: ${outcome.refusal.kind} ${outcome.refusal.message}`)
  return outcome.operation
}
