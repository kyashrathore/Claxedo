import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { RecoveryOperation, RecoveryOutcome, RecoveryRequest, RecoveryTurnTarget, SessionHarness } from "@claxedo/agent-runtime-contract"
import type { TurnActor, TurnOrigin } from "@claxedo/harness/contract"
import type { AgentRuntimeRecovery, RecoveryCaller, RuntimeStore } from "@claxedo/session-core"
import { openRuntimeStore } from "../store-file"
import type { FakeTurn } from "./fake-transport"
import { composeHost, type HostComposition, type HostCompositionInput } from "./host-composition"

export const MACHINE_OWNER: TurnActor = { kind: "machine-owner" }
export const LOOPBACK_ORIGIN: TurnOrigin = { actor: MACHINE_OWNER, via: "loopback", reissued: false }

export function tempStoreRoot(prefix = "host-fixture-") {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

export type HostFixtureInput = Omit<HostCompositionInput, "store"> & {
  /** A store the test owns and closes itself; the fixture opens one in a temp root otherwise. */
  store?: RuntimeStore
}

export type HostFixture = HostComposition & {
  /** Disposes the runtime and, when the fixture opened the store, closes it and removes its root. */
  dispose: () => Promise<void>
}

export function createHostFixture(input: HostFixtureInput): HostFixture {
  const root = input.store ? undefined : tempStoreRoot()
  const store = input.store ?? openRuntimeStore(root)
  const host = composeHost({ ...input, store })
  return {
    ...host,
    dispose: async () => {
      await host.runtime.dispose()
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
