import { describe, expect, test } from "bun:test"
import {
  parseRecoveryOutcome,
  type RecoveryFacts,
  type RecoveryOperation,
  type RecoveryOutcome,
  type RecoveryRequest,
  type RecoveryTurnTarget,
  recoveryTargetsMatch,
} from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeRecovery, AgentRuntimeRecoveryInspection } from "@claxedo/agent-sdk-runtime"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { createSessionRoutes } from "./session-core"

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
    getSession: async (binding) => ({ id: binding.sessionId }),
    createSession: async () => ({ id: SESSION }),
    updateSession: async (binding) => ({ id: binding.sessionId }),
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

  test("a host with no owner for the session says so instead of starting one", async () => {
    const inspected = await routes().request(`http://localhost/session/${SESSION}/recovery`)
    expect(inspected.status).toBe(503)
    expect(await inspected.json()).toMatchObject({ error: { code: "recovery_owner_unavailable" } })

    const submitted = await post(routes(), submitRequest())
    expect(submitted.status).toBe(503)
    expect(parseRecoveryOutcome(await submitted.text())).toMatchObject({ kind: "refused", refusal: { kind: "unavailable" } })
  })

  test("the abort route is gone", async () => {
    const response = await routes(recoveryDouble({ target: TARGET }).owner)
      .request(`http://localhost/session/${SESSION}/abort`, { method: "POST" })
    expect(response.status).toBe(404)
  })
})
