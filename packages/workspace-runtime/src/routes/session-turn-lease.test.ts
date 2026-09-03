import { describe, expect, test } from "bun:test"
import type { SessionAccessPolicy } from "../session-access-policy"
import { SESSION_TURN_LEASE_TTL_MS } from "@claxedo/workspace-relay-protocol"
import { acquireSessionTurnLease } from "./session-turn-lease"

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
    authorize: async () => ({ allowed: true }),
    authorizePrefix: async () => ({ allowed: true }),
    filterSessions: async (input) => input.sessionIds,
    registerSession: async () => ({ allowed: true }),
    ...overrides,
  }
}

describe("durable session turn lease controller", () => {
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
      onLost: () => { losses += 1 },
      now: () => localNow,
    })
    expect(acquisition.acquired).toBe(true)
    if (!acquisition.acquired) return

    localNow = started + SESSION_TURN_LEASE_TTL_MS
    expect(acquisition.lease.valid()).toBe(false)
    expect(acquisition.lease.signal.aborted).toBe(true)
    expect(losses).toBe(1)
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
      onLost: () => { losses += 1 },
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
      onLost: () => {},
    })
    expect(acquisition.acquired).toBe(true)
    if (!acquisition.acquired) return

    await new Promise((resolve) => setTimeout(resolve, 65))
    expect(renewals).toBe(1)
    await expect(acquisition.lease.release()).resolves.toEqual({ released: true })
    expect(released).toEqual(["proof_2"])
    expect(acquisition.lease.valid()).toBe(false)
  })
})
