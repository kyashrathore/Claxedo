import { describe, expect, test } from "bun:test"
import {
  parseRecoveryOutcome,
  type RecoveryFacts,
  type RecoveryOperation,
  type RecoveryOutcome,
  type RecoveryRequest,
  type RecoveryTurnTarget,
  recoveryTargetsMatch,
  type AgentExecutionBinding,
} from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeRecovery, AgentRuntimeRecoveryInspection } from "@claxedo/agent-sdk-runtime"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import type { AgentRuntime } from "@claxedo/agent-sdk-runtime"
import type { SessionAccessPolicy } from "../session-access-policy"
import { runRuntimePromptTurn } from "../session/service"
import { JSON_BODY_LIMIT_BYTES } from "./http"
import { acquireSessionTurnLease } from "./session-turn-lease"
import { captureTurnTarget, containLostTurn, createSessionRoutes } from "./session-core"

const SESSION = "session_1"

const TARGET: RecoveryTurnTarget = {
  scope: "turn",
  workspaceId: "ws_1",
  sessionId: SESSION,
  turnId: "msg_1",
  ownerGeneration: "lease_1",
}

function facts(): RecoveryFacts {
  const observedAt = 1_000
  return {
    execution: { value: "terminal", source: "fixture", observedAt, generation: "lease_1" },
    cleanup: { value: "verified_clear", source: "fixture", observedAt, generation: "lease_1" },
    persistence: { value: "committed", source: "fixture", observedAt, generation: "lease_1" },
  }
}

function operation(request: RecoveryRequest, state: RecoveryOperation["state"] = "succeeded"): RecoveryOperation {
  return {
    operationId: "op_1",
    requestId: request.requestId,
    target: request.target,
    action: request.action,
    scopeRevision: request.scopeRevision,
    attempt: request.attempt,
    state,
    phase: "graceful_cancel",
    phaseDeadlineAt: 2_000,
    facts: facts(),
    cleanupErrors: [],
    nextActions: [],
    receipt: "durable",
    createdAt: 1_000,
    updatedAt: 1_000,
  }
}

function inspection(target?: RecoveryTurnTarget): AgentRuntimeRecoveryInspection {
  return {
    sessionId: SESSION,
    ...(target ? { target } : {}),
    facts: facts(),
    health: { status: "ok" },
    failures: [],
    operations: [],
    queued: 0,
  }
}

function adapter(): AgentHarnessAdapter {
  return {
    instructionChannel: "none",
    getSession: async (binding: AgentExecutionBinding) => ({ id: binding.sessionId }),
    createSession: async () => ({ id: SESSION }),
    updateSession: async (binding: AgentExecutionBinding) => ({ id: binding.sessionId }),
    getSessionConfig: async () => ({
      harness: { id: "codex", access: "native" },
      model: { providerID: "test", modelID: "fixture" },
      agent: "build",
      variant: null,
    }),
    updateSessionConfig: async () => ({ harness: { id: "codex", access: "native" }, agent: null, variant: null }),
    deleteSession: async () => {},
    readHarnessCapabilities: () => ({ harness: "codex" }) as never,
    executeTurn: () => (async function* () {})(),
    getMessages: async () => [],
    dispose: () => {},
  } as unknown as AgentHarnessAdapter
}

type RecoveryDouble = {
  owner: AgentRuntimeRecovery
  submitted: Array<{ request: RecoveryRequest; callerId: string; authority: string }>
  reads: Array<{ operationId: string; callerId: string }>
  inspected: string[]
}

function recoveryDouble(input: {
  target?: RecoveryTurnTarget
  answer?: (request: RecoveryRequest) => RecoveryOutcome
  read?: RecoveryOutcome
} = {}): RecoveryDouble {
  const submitted: RecoveryDouble["submitted"] = []
  const reads: RecoveryDouble["reads"] = []
  const inspected: string[] = []
  return {
    submitted,
    reads,
    inspected,
    owner: {
      inspect: (sessionId) => {
        inspected.push(sessionId)
        return inspection(input.target)
      },
      submit: async (request, caller) => {
        submitted.push({ request, callerId: caller.callerId, authority: caller.authority })
        return input.answer?.(request) ?? { kind: "operation", operation: operation(request) }
      },
      read: (operationId, caller) => {
        reads.push({ operationId, callerId: caller.callerId })
        return input.read
      },
    },
  }
}

function routes(owner?: AgentRuntimeRecovery) {
  return createSessionRoutes({
    resolveAdapter: () => adapter(),
    resolveDirectory: () => undefined,
    publishGlobal: () => {},
    ...(owner ? { resolveRecoveryOwner: () => owner } : {}),
  })
}

function submitRequest(overrides: Partial<RecoveryRequest> = {}): RecoveryRequest {
  return {
    requestId: "req_1",
    action: "cancel_turn",
    target: TARGET,
    scopeRevision: "lease_1",
    attempt: 1,
    ...overrides,
  } as RecoveryRequest
}

function post(app: ReturnType<typeof routes>, body: unknown, sessionId = SESSION) {
  return app.request(`http://localhost/session/${sessionId}/recovery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("session recovery routes", () => {
  test("inspection answers the owner's view of the session", async () => {
    const owner = recoveryDouble({ target: TARGET })
    const response = await routes(owner.owner).request(`http://localhost/session/${SESSION}/recovery`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(inspection(TARGET) as never)
    expect(owner.inspected).toEqual([SESSION])
  })

  test("a submit carries the caller's target through HTTP unchanged", async () => {
    const owner = recoveryDouble({ target: TARGET })
    const response = await post(routes(owner.owner), submitRequest())

    expect(response.status).toBe(200)
    const outcome = parseRecoveryOutcome(await response.text())
    expect(outcome.kind).toBe("operation")
    expect(owner.submitted).toHaveLength(1)
    // The identity the owner fences on survived JSON, the route and the
    // parser: anything less and a stale request could not be told from a live
    // one on the other side.
    expect(recoveryTargetsMatch(owner.submitted[0]!.request.target, TARGET)).toBe(true)
    expect(owner.submitted[0]!.request).toEqual(submitRequest())
  })

  test("the caller identity comes from the request's verified claims, not its body", async () => {
    const owner = recoveryDouble({ target: TARGET })
    const response = await post(routes(owner.owner), { ...submitRequest(), callerId: "someone-else" })

    expect(response.status).toBe(200)
    expect(owner.submitted[0]!.callerId).toBe("provenance:loopback-direct")
    expect(owner.submitted[0]!.authority).toBe("session")
    expect(owner.submitted[0]!.request).not.toHaveProperty("callerId")
  })

  test("a refusal keeps its kind and reaches the caller under the status that classifies it", async () => {
    const cases = [
      [{ kind: "generation_conflict", message: "replaced", current: TARGET }, 409],
      [{ kind: "intent_conflict", message: "same id, other intent", requestId: "req_1" }, 409],
      [{ kind: "scope_changed", message: "wider", scopeRevision: "rev_2", preview: { sessions: [SESSION], resources: [], summary: "one session" } }, 409],
      [{ kind: "receipt_expired", message: "gone", requestId: "req_1" }, 410],
      [{ kind: "unauthorized", message: "no" }, 403],
      [{ kind: "unavailable", message: "closing" }, 503],
      [{ kind: "version_update_required", message: "upgrade", contractVersion: 2 }, 426],
    ] as const

    for (const [refusal, status] of cases) {
      const owner = recoveryDouble({ target: TARGET, answer: () => ({ kind: "refused", refusal } as RecoveryOutcome) })
      const response = await post(routes(owner.owner), submitRequest())

      expect(response.status, refusal.kind).toBe(status)
      const outcome = parseRecoveryOutcome(await response.text())
      expect(outcome, refusal.kind).toEqual({ kind: "refused", refusal } as RecoveryOutcome)
    }
  })

  test("an operation that did not succeed is still a 200 operation, not an error", async () => {
    const owner = recoveryDouble({
      target: TARGET,
      answer: (request) => ({ kind: "operation", operation: operation(request, "needs_action") }),
    })
    const response = await post(routes(owner.owner), submitRequest())

    expect(response.status).toBe(200)
    const outcome = parseRecoveryOutcome(await response.text())
    expect(outcome).toMatchObject({ kind: "operation", operation: { state: "needs_action" } })
  })

  test("an invalid request is refused at the boundary with its contract code and never reaches the owner", async () => {
    const cases: Array<[unknown, string]> = [
      [{ ...submitRequest(), action: "explode" }, "invalid_action"],
      [{ ...submitRequest(), attempt: 0 }, "invalid_attempt"],
      [{ ...submitRequest(), target: { ...TARGET, ownerGeneration: "" } }, "missing_generation"],
      [{ ...submitRequest(), requestId: "" }, "invalid_request_id"],
      [{ ...submitRequest(), action: "cancel_turn", target: { scope: "session", workspaceId: "ws_1", sessionId: SESSION, ownerGeneration: "g" } }, "scope_mismatch"],
      ["not an object", "invalid_payload"],
    ]

    for (const [body, code] of cases) {
      const owner = recoveryDouble({ target: TARGET })
      const response = await post(routes(owner.owner), body)

      expect(response.status, code).toBe(400)
      expect(await response.json(), code).toMatchObject({
        error: { code: "recovery_request_invalid", details: { code } },
      })
      expect(owner.submitted, code).toEqual([])
    }
  })

  test("session authority cannot escalate to a harness or a machine", async () => {
    const cases: Array<[string, unknown]> = [
      ["retire_harness", { ...submitRequest(), action: "retire_harness", target: { scope: "harness", workspaceId: "ws_1", harnessKey: "codex_1", ownerGeneration: "g" } }],
      ["drain_daemon", { ...submitRequest(), action: "drain_daemon", target: { scope: "machine", machineId: "m_1", ownerGeneration: "g" } }],
      ["stop_daemon", { ...submitRequest(), action: "stop_daemon", target: { scope: "machine", machineId: "m_1", ownerGeneration: "g" } }],
    ]

    for (const [action, body] of cases) {
      const owner = recoveryDouble({ target: TARGET })
      const response = await post(routes(owner.owner), body)

      expect(response.status, action).toBe(403)
      expect(parseRecoveryOutcome(await response.text()), action).toMatchObject({ kind: "refused", refusal: { kind: "unauthorized" } })
      expect(owner.submitted, action).toEqual([])
    }
  })

  test("a target naming another session is refused before the owner sees it", async () => {
    const owner = recoveryDouble({ target: TARGET })
    const response = await post(routes(owner.owner), submitRequest({ target: { ...TARGET, sessionId: "session_2" } }))

    expect(response.status).toBe(403)
    expect(parseRecoveryOutcome(await response.text())).toMatchObject({
      kind: "refused",
      refusal: { kind: "unauthorized", message: "Recovery target names session session_2, not session_1" },
    })
    expect(owner.submitted).toEqual([])
  })

  test("reading an operation is caller-authorized and answers the owner's outcome", async () => {
    const read: RecoveryOutcome = { kind: "operation", operation: operation(submitRequest(), "failed") }
    const owner = recoveryDouble({ target: TARGET, read })
    const response = await routes(owner.owner).request(`http://localhost/session/${SESSION}/recovery/operations/op_1`)

    expect(response.status).toBe(200)
    expect(parseRecoveryOutcome(await response.text())).toEqual(read)
    expect(owner.reads).toEqual([{ operationId: "op_1", callerId: "provenance:loopback-direct" }])
  })

  test("an operation id this owner never held is not reported as an expired receipt", async () => {
    const owner = recoveryDouble({ target: TARGET })
    const response = await routes(owner.owner).request(`http://localhost/session/${SESSION}/recovery/operations/op_unknown`)

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: "recovery_operation_unknown" } })
  })

  test("a host with no owner for the session refuses all three the same way", async () => {
    const answers = [
      await routes().request(`http://localhost/session/${SESSION}/recovery`),
      await routes().request(`http://localhost/session/${SESSION}/recovery/operations/op_1`),
      await post(routes(), submitRequest()),
    ]

    for (const answer of answers) {
      expect(answer.status, answer.url).toBe(503)
      // One representation across the three, so a caller decodes every
      // non-200 body the same way instead of throwing on one of them.
      expect(parseRecoveryOutcome(await answer.text()), answer.url).toEqual({
        kind: "refused",
        refusal: { kind: "unavailable", message: `No runtime owns session ${SESSION} on this host` },
      })
    }
  })

  test("inspection is asked under the directory the request resolved", async () => {
    const directories: Array<string | undefined> = []
    const owner = recoveryDouble({ target: TARGET })
    const app = createSessionRoutes({
      resolveAdapter: () => adapter(),
      resolveDirectory: () => "/repo/main",
      publishGlobal: () => {},
      resolveRecoveryOwner: () => ({
        ...owner.owner,
        inspect: (sessionId, directory) => { directories.push(directory); return owner.owner.inspect(sessionId) },
      }),
    })

    expect((await app.request(`http://localhost/session/${SESSION}/recovery`)).status).toBe(200)
    expect(directories).toEqual(["/repo/main"])
  })

  test("a recovery body past the size bound is refused as one, not as a server fault", async () => {
    const owner = recoveryDouble({ target: TARGET })
    const oversized = await routes(owner.owner).request(`http://localhost/session/${SESSION}/recovery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...submitRequest(), scopeRevision: "x".repeat(JSON_BODY_LIMIT_BYTES + 1) }),
    })

    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toMatchObject({ error: { code: "request_body_too_large" } })
    expect(owner.submitted).toEqual([])
  })

  test("the abort route is gone", async () => {
    const response = await routes(recoveryDouble({ target: TARGET }).owner)
      .request(`http://localhost/session/${SESSION}/abort`, { method: "POST" })
    expect(response.status).toBe(404)
  })
})

/**
 * The owner's real rule, so the assertions below mean something: a request
 * naming a turn other than the admitted one is refused, and every accepted
 * submit is retained where inspection reports it.
 */
function generationCheckedOwner(admitted: () => RecoveryTurnTarget | undefined) {
  const operations: RecoveryOperation[] = []
  const seen: RecoveryRequest[] = []
  const owner: AgentRuntimeRecovery = {
    inspect: (sessionId) => ({ ...inspection(admitted()), sessionId, operations: [...operations] }),
    submit: async (request) => {
      seen.push(request)
      const current = admitted()
      if (!current || !recoveryTargetsMatch(request.target, current)) {
        return {
          kind: "refused",
          refusal: {
            kind: "generation_conflict",
            message: "that turn is no longer the admitted one",
            ...(current ? { current } : {}),
          },
        }
      }
      const accepted = operation(request)
      operations.push(accepted)
      return { kind: "operation", operation: accepted }
    },
    read: (operationId) => {
      const found = operations.find((row) => row.operationId === operationId)
      return found ? { kind: "operation", operation: found } : undefined
    },
  }
  return { owner, operations, seen }
}

function leaseAuthority(input: { revoke: boolean }): SessionAccessPolicy {
  const started = Date.now()
  return {
    sessionAuthority: "managed-private",
    authorizeSessionStartStatus: () => ({ allowed: false as const, status: 403 as const, code: "not_tested", message: "no" }),
    authorizeSessionStart: () => ({ allowed: false as const, status: 403 as const, code: "not_tested", message: "no" }),
    authorize: async () => ({ allowed: true }),
    authorizePrefix: async () => ({ allowed: true }),
    filterSessions: async (row) => row.sessionIds,
    registerSession: async () => ({ allowed: true }),
    acquireTurn: (row) => ({
      allowed: true,
      turnId: row.turnId,
      leaseId: `lease_${row.turnId}`,
      fencingToken: 1,
      acquiredAt: started,
      expiresAt: started + (input.revoke ? 40 : 60_000),
    }),
    renewTurn: async () => await new Promise(() => {}),
    releaseTurn: async () => ({ released: true }),
  }
}

describe("containing a turn whose lease was revoked", () => {
  test("submits the turn admission handed back, not whichever turn the owner is running now", async () => {
    const replacement = { ...TARGET, turnId: "msg_2", ownerGeneration: "lease_2" }
    const running = generationCheckedOwner(() => replacement)
    const lostTurn = captureTurnTarget()
    // A's admission, captured before B replaced it.
    lostTurn.set(TARGET)

    const outcome = await containLostTurn({
      runtime: running.owner,
      sessionId: SESSION,
      target: lostTurn.get(),
      caller: { callerId: "actor:a", authority: "session" },
    })

    expect(running.seen).toHaveLength(1)
    expect(running.seen[0]!.target).toEqual(TARGET)
    expect(running.seen[0]!.action).toBe("cancel_turn")
    expect(running.seen[0]!.scopeRevision).toBe(TARGET.ownerGeneration)
    // The replacement is untouched: the owner refused A's request rather than
    // cancelling B under it.
    expect(outcome).toMatchObject({ kind: "refused", refusal: { kind: "generation_conflict", current: replacement } })
    expect(running.operations).toEqual([])
  })

  test("the captured target comes from admission, and a queued prompt has none", async () => {
    for (const [delivery, expected] of [["start", TARGET], ["queue", undefined]] as const) {
      const lostTurn = captureTurnTarget()
      const runtime = {
        turns: {
          start: async (turn: { sessionId: string; messageId?: string }) => ({
            sessionId: turn.sessionId,
            userMessageId: turn.messageId ?? "msg_1",
            assistantMessageId: "assistant_1",
            delivery,
            // The runtime names no turn for a prompt it parked: the turn
            // holding the session belongs to another caller.
            ...(delivery === "start" ? { target: TARGET } : {}),
            prompt: { parts: [], userMessageId: turn.messageId ?? "msg_1", assistantMessageId: "assistant_1", agent: "build", model: { providerID: "test", modelID: "fixture" } },
          }),
          whenIdle: async () => ({ abandon: () => {} }),
        },
        events: { subscribe: () => (async function* () {})(), list: async () => [] },
      } as unknown as AgentRuntime

      await runRuntimePromptTurn({
        runtime,
        sessionId: SESSION,
        directory: undefined,
        body: { messageID: "msg_1", parts: [{ type: "text", text: "go" }], delivery: delivery === "queue" ? "queue" : undefined },
        publishGlobal: () => {},
        onTurnTarget: lostTurn.set,
      })

      expect(lostTurn.get(), delivery).toEqual(expected)
    }
  })

  test("a lease revoked before any turn was admitted contains nothing and says so", async () => {
    const idle = generationCheckedOwner(() => undefined)

    const outcome = await containLostTurn({
      runtime: idle.owner,
      sessionId: SESSION,
      target: captureTurnTarget().get(),
      caller: { callerId: "actor:a", authority: "session" },
    })

    expect(idle.seen).toEqual([])
    expect(outcome).toMatchObject({ kind: "refused", refusal: { kind: "generation_conflict" } })
  })

  test("an owner that cannot record the cancellation answers the lease instead of rejecting at it", async () => {
    const broken: AgentRuntimeRecovery = {
      inspect: () => inspection(TARGET),
      submit: async () => { throw new Error("operation store is gone") },
      read: () => undefined,
    }

    const outcome = await containLostTurn({
      runtime: broken,
      sessionId: SESSION,
      target: TARGET,
      caller: { callerId: "actor:a", authority: "session" },
    })

    expect(outcome).toMatchObject({
      kind: "refused",
      refusal: { kind: "unavailable", message: expect.stringContaining("operation store is gone") },
    })
  })

  test("a revoked lease keeps the containment outcome, and inspection reports the operation it opened", async () => {
    const admitted = generationCheckedOwner(() => TARGET)
    const acquired = await acquireSessionTurnLease({
      policy: leaseAuthority({ revoke: true }),
      access: { operation: "prompt", sessionId: SESSION },
      turnId: TARGET.turnId,
      onLost: () => containLostTurn({
        runtime: admitted.owner,
        sessionId: SESSION,
        target: TARGET,
        caller: { callerId: "actor:a", authority: "session" },
      }),
    })
    expect(acquired.acquired).toBe(true)
    if (!acquired.acquired) return
    try {
      await Bun.sleep(80)
      expect(acquired.lease.lost()).toBe(true)
      expect(acquired.lease.lossResult()).toMatchObject({ outcome: { kind: "operation", operation: { action: "cancel_turn" } } })
      // The lease is per-request; the runtime is what a later inspection asks.
      const inspected = admitted.owner.inspect(SESSION)
      expect(inspected.operations.map((row) => row.action)).toEqual(["cancel_turn"])
      expect(inspected.operations[0]!.target).toEqual(TARGET)
    } finally {
      await acquired.lease.release()
    }
  })
})
