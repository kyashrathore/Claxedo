import { describe, expect, test } from "bun:test"
import type { SessionAccessPolicy, SessionTurnLeaseDecision } from "../session-access-policy"
import { SESSION_TURN_LEASE_TTL_MS } from "@claxedo/workspace-relay-protocol"
import { DEFAULT_RECOVERY_BUDGETS, type RecoveryFacts, type RecoveryOutcome, type RecoveryOperationState, type RecoveryTurnTarget } from "@claxedo/agent-runtime-contract"
import { acquireSessionTurnLease } from "./session-turn-lease"

const target: RecoveryTurnTarget = {
  scope: "turn",
  workspaceId: "ws_1",
  sessionId: "ses_1",
  turnId: "msg_1",
  ownerGeneration: "lease_1",
}

function facts(observedAt: number): RecoveryFacts {
  return {
    execution: { value: "terminal", source: "fixture", observedAt, generation: "lease_1" },
    cleanup: { value: "verified_clear", source: "fixture", observedAt, generation: "lease_1" },
    persistence: { value: "committed", source: "fixture", observedAt, generation: "lease_1" },
  }
}

function contained(state: RecoveryOperationState = "succeeded"): RecoveryOutcome {
  const at = Date.now()
  return {
    kind: "operation",
    operation: {
      operationId: "op_1",
      requestId: "req_1",
      target,
      action: "cancel_turn",
      scopeRevision: "lease_1",
      attempt: 1,
      state,
      phase: "graceful_cancel",
      phaseDeadlineAt: at + 1_000,
      facts: facts(at),
      cleanupErrors: [],
      nextActions: [],
      receipt: "durable",
      createdAt: at,
      updatedAt: at,
    },
  }
}

const access = {
  actor: { actorId: "actor_1", actorKind: "human" as const },
  authority: {
    managed: true as const,
    workspaceId: "ws_1",
    orgId: "org_1",
    role: "editor" as const,
  },
  operation: "prompt" as const,
  sessionId: "ses_1",
}

function policy(overrides: Partial<SessionAccessPolicy>): SessionAccessPolicy {
  return {
    sessionAuthority: "managed-private",
    authorizeSessionStartStatus: () => ({ allowed: false as const, status: 403 as const, code: "startup_not_tested", message: "Startup is not admitted by this fixture" }),
    authorizeSessionStart: () => ({ allowed: false as const, status: 403 as const, code: "startup_not_tested", message: "Startup is not admitted by this fixture" }),
    authorize: async () => ({ allowed: true }),
    authorizePrefix: async () => ({ allowed: true }),
    filterSessions: async (input) => input.sessionIds,
    registerSession: async () => ({ allowed: true }),
    ...overrides,
  }
}

describe("durable session turn lease controller", () => {
  test("invalid authority leases never admit an execution", async () => {
    const now = Date.now()
    for (const invalid of [
      { expiresAt: Number.NaN }, { expiresAt: Number.POSITIVE_INFINITY },
      { acquiredAt: Number.NaN }, { acquiredAt: now + 2_000 },
      { fencingToken: 0 }, { fencingToken: 1.5 }, { fencingToken: Number.POSITIVE_INFINITY },
      { leaseId: " " }, { turnId: "another-turn" },
    ]) {
      const acquisition = await acquireSessionTurnLease({
        policy: policy({
          acquireTurn: () => ({ allowed: true, turnId: "msg_invalid", leaseId: "proof",
            fencingToken: 1, acquiredAt: now, expiresAt: now + 1_000, ...invalid }),
          renewTurn: async () => { throw new Error("Invalid admission must not renew") },
          releaseTurn: async () => ({ released: true }),
        }), access, turnId: "msg_invalid", onLost: () => contained(), now: () => now,
      })
      expect(acquisition).toMatchObject({ acquired: false, decision: { code: "session_turn_authority_invalid_response" } })
    }
  })

  test("an invalid renewal stops the admitted producer", async () => {
    let lost!: () => void
    const loss = new Promise<void>((resolve) => { lost = resolve })
    const started = Date.now()
    const acquisition = await acquireSessionTurnLease({
      policy: policy({
        acquireTurn: () => ({ allowed: true, turnId: "msg_renew", leaseId: "proof", fencingToken: 1,
          acquiredAt: started, expiresAt: started + 200 }),
        renewTurn: () => ({ allowed: true, turnId: "msg_renew", leaseId: "proof_invalid", fencingToken: 1,
          acquiredAt: started, expiresAt: Number.POSITIVE_INFINITY }),
        releaseTurn: async () => ({ released: true }),
      }), access, turnId: "msg_renew", onLost: () => { lost(); return contained() },
    })
    expect(acquisition.acquired).toBe(true)
    if (!acquisition.acquired) return
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([loss, new Promise<void>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Invalid renewal did not stop execution")), 400)
      })])
      expect(acquisition.lease.lost()).toBe(true)
      expect(acquisition.lease.signal.aborted).toBe(true)
      expect(acquisition.lease.valid()).toBe(false)
    } finally {
      clearTimeout(timeout)
      await acquisition.lease.release()
    }
  })

  test("caps a control-plane clock-ahead lease at the local authority TTL", async () => {
    const started = Date.now()
    let localNow = started
    let losses = 0
    const acquisition = await acquireSessionTurnLease({
      policy: policy({
        acquireTurn: async (input) => ({
          allowed: true,
          turnId: input.turnId,
          leaseId: "proof_clock_ahead",
          fencingToken: 1,
          acquiredAt: started,
          expiresAt: started + 10 * SESSION_TURN_LEASE_TTL_MS,
        }),
        renewTurn: async () => await new Promise(() => {}),
        releaseTurn: async () => ({ released: true }),
      }),
      access,
      turnId: "msg_clock_ahead",
      onLost: () => { losses += 1; return contained() },
      now: () => localNow,
    })
    expect(acquisition.acquired).toBe(true)
    if (!acquisition.acquired) return

    localNow = started + SESSION_TURN_LEASE_TTL_MS
    expect(acquisition.lease.valid()).toBe(false)
    expect(acquisition.lease.signal.aborted).toBe(true)
    expect(losses).toBe(1)
  })

  test("a renewal response cannot revive a lease past its local deadline", async () => {
    const started = Date.now()
    let localNow = started
    let finishRenewal!: (value: SessionTurnLeaseDecision) => void
    let renewalStarted!: () => void
    const renewing = new Promise<void>((resolve) => { renewalStarted = resolve })
    let losses = 0
    const acquisition = await acquireSessionTurnLease({
      policy: policy({
        acquireTurn: () => ({ allowed: true, turnId: "msg_delayed", leaseId: "proof_1",
          fencingToken: 1, acquiredAt: started, expiresAt: started + 200 }),
        renewTurn: () => {
          renewalStarted()
          return new Promise((resolve) => { finishRenewal = resolve })
        },
        releaseTurn: async () => ({ released: true }),
      }), access, turnId: "msg_delayed", now: () => localNow, onLost: () => { losses += 1; return contained() },
    })
    expect(acquisition.acquired).toBe(true)
    if (!acquisition.acquired) return
    try {
      await renewing
      // The wall clock crosses the old deadline before the expiry timer runs.
      localNow = started + 250
      finishRenewal({ allowed: true, turnId: "msg_delayed", leaseId: "proof_2",
        fencingToken: 1, acquiredAt: started, expiresAt: localNow + 1_000 })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(acquisition.lease.valid()).toBe(false)
      expect(acquisition.lease.signal.aborted).toBe(true)
      expect(losses).toBe(1)
    } finally {
      await acquisition.lease.release()
    }
  })

  test("synchronous renewal and cleanup errors still stop the producer", async () => {
    const started = Date.now()
    let losses = 0
    let renewals = 0
    const acquisition = await acquireSessionTurnLease({
      policy: policy({
        acquireTurn: () => ({ allowed: true, turnId: "msg_throw", leaseId: "proof_1",
          fencingToken: 1, acquiredAt: started, expiresAt: started + 200 }),
        renewTurn: () => { renewals += 1; throw new Error("authority unavailable") },
        releaseTurn: async () => ({ released: true }),
      }), access, turnId: "msg_throw", onLost: (): RecoveryOutcome => { losses += 1; throw new Error("cleanup failed") },
    })
    expect(acquisition.acquired).toBe(true)
    if (!acquisition.acquired) return
    try {
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(acquisition.lease.lost()).toBe(true)
      expect(acquisition.lease.signal.aborted).toBe(true)
      expect(renewals).toBe(1)
      expect(losses).toBe(1)
    } finally {
      await acquisition.lease.release()
    }
  })

  test("hard-stops the producer at expiry even while renewal is stalled", async () => {
    let losses = 0
    let renewals = 0
    const started = Date.now()
    const acquisition = await acquireSessionTurnLease({
      policy: policy({
        acquireTurn: async (input) => ({
          allowed: true,
          turnId: input.turnId,
          leaseId: "proof_1",
          fencingToken: 1,
          acquiredAt: started,
          expiresAt: started + 70,
        }),
        renewTurn: async () => {
          renewals += 1
          return await new Promise(() => {})
        },
        releaseTurn: async () => ({ released: true }),
      }),
      access,
      turnId: "msg_1",
      onLost: () => { losses += 1; return contained() },
    })
    expect(acquisition.acquired).toBe(true)
    if (!acquisition.acquired) return

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(renewals).toBe(1)
    expect(acquisition.lease.valid()).toBe(false)
    expect(acquisition.lease.lost()).toBe(true)
    expect(acquisition.lease.signal.aborted).toBe(true)
    expect(losses).toBe(1)
    await expect(acquisition.lease.release()).resolves.toEqual({ released: false })
  })

  test("rotates the renewable proof and releases only the latest authority lease", async () => {
    const released: string[] = []
    let renewals = 0
    const started = Date.now()
    const acquisition = await acquireSessionTurnLease({
      policy: policy({
        acquireTurn: async (input) => ({
          allowed: true,
          turnId: input.turnId,
          leaseId: "proof_1",
          fencingToken: 4,
          acquiredAt: started,
          expiresAt: started + 80,
        }),
        renewTurn: async (input) => {
          renewals += 1
          return {
            allowed: true,
            turnId: input.turnId,
            leaseId: `proof_${renewals + 1}`,
            fencingToken: input.fencingToken,
            acquiredAt: started,
            expiresAt: Date.now() + 200,
          }
        },
        releaseTurn: async (input) => {
          released.push(input.leaseId)
          return { released: true }
        },
      }),
      access,
      turnId: "msg_2",
      onLost: () => contained(),
    })
    expect(acquisition.acquired).toBe(true)
    if (!acquisition.acquired) return

    await new Promise((resolve) => setTimeout(resolve, 65))
    expect(renewals).toBe(1)
    await expect(acquisition.lease.release()).resolves.toEqual({ released: true })
    expect(released).toEqual(["proof_2"])
    expect(acquisition.lease.valid()).toBe(false)
  })
  test("keeps what containment reached, whatever it reached", async () => {
    const cases: Array<[string, () => Promise<RecoveryOutcome> | RecoveryOutcome, (result: unknown) => void]> = [
      ["a containment that stopped the turn", () => contained(), (result) => {
        expect(result).toMatchObject({ outcome: { kind: "operation", operation: { state: "succeeded" } } })
      }],
      ["a containment the owner refused", () => ({ kind: "refused", refusal: { kind: "generation_conflict", message: "replaced" } }), (result) => {
        expect(result).toMatchObject({ outcome: { kind: "refused", refusal: { kind: "generation_conflict" } } })
      }],
      ["a containment that rejected", () => Promise.reject(new Error("runtime is gone")), (result) => {
        expect(result).toMatchObject({ error: "runtime is gone" })
      }],
      ["a containment that threw synchronously", (): RecoveryOutcome => { throw new Error("adapter exploded") }, (result) => {
        expect(result).toMatchObject({ error: "adapter exploded" })
      }],
    ]
    for (const [name, onLost, assert] of cases) {
      const acquisition = await expiringLease(onLost)
      expect(acquisition.acquired, name).toBe(true)
      if (!acquisition.acquired) continue
      try {
        await new Promise((resolve) => setTimeout(resolve, 60))
        expect(acquisition.lease.lost(), name).toBe(true)
        const result = acquisition.lease.lossResult()
        expect(result, name).toBeDefined()
        expect(result!.at, name).toBeGreaterThan(0)
        assert(result)
      } finally {
        await acquisition.lease.release()
      }
    }
  })

  test("a containment that outruns the graceful-cancel budget is recorded as unresolved, and a late success does not rewrite it", async () => {
    let clock = Date.now()
    const started = clock
    let settle!: (outcome: RecoveryOutcome) => void
    const acquisition = await acquireSessionTurnLease({
      policy: policy({
        acquireTurn: () => ({ allowed: true, turnId: "msg_slow", leaseId: "proof", fencingToken: 1,
          acquiredAt: started, expiresAt: started + 20 }),
        renewTurn: async () => await new Promise(() => {}),
        releaseTurn: async () => ({ released: true }),
      }),
      access,
      turnId: "msg_slow",
      onLost: () => new Promise<RecoveryOutcome>((resolve) => { settle = resolve }),
      now: () => clock,
    })
    expect(acquisition.acquired).toBe(true)
    if (!acquisition.acquired) return
    try {
      clock = started + 21
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(acquisition.lease.lost()).toBe(true)
      expect(acquisition.lease.lossResult()).toBeUndefined()

      clock = started + 21 + DEFAULT_RECOVERY_BUDGETS.gracefulCancelMs
      await Bun.sleep(DEFAULT_RECOVERY_BUDGETS.gracefulCancelMs + 20)
      const expired = acquisition.lease.lossResult()
      expect(expired).toMatchObject({ error: `Containing the lost turn exceeded ${DEFAULT_RECOVERY_BUDGETS.gracefulCancelMs}ms` })

      settle(contained())
      await Bun.sleep(5)
      expect(acquisition.lease.lossResult()).toEqual(expired)
    } finally {
      await acquisition.lease.release()
    }
  }, DEFAULT_RECOVERY_BUDGETS.gracefulCancelMs + 5_000)
})

function expiringLease(onLost: () => Promise<RecoveryOutcome> | RecoveryOutcome) {
  const started = Date.now()
  return acquireSessionTurnLease({
    policy: policy({
      acquireTurn: () => ({ allowed: true, turnId: "msg_lost", leaseId: "proof", fencingToken: 1,
        acquiredAt: started, expiresAt: started + 30 }),
      renewTurn: async () => await new Promise(() => {}),
      releaseTurn: async () => ({ released: true }),
    }),
    access,
    turnId: "msg_lost",
    onLost,
  })
}
