import { describe, it, expect } from "vitest"
import type { SettlementTenant } from "../workgraph-host/settlement-dispatcher"
import { SqliteWakeStore } from "@claxedo/wakes/sqlite"
import {
  WORKGRAPH_SETTLE_KIND,
  composeHostedWakes,
  parseSettleTenant,
  settleRetryDelayMs,
  workGraphSettleWake,
} from "./hosted-wakes"
import type { HostedWorkerEnv } from "../control-plane/hosted-services"

const TENANT: SettlementTenant = { organizationId: "org_1", ownerUserId: "user_1" }

describe("workGraphSettleWake", () => {
  it("shapes the dirty-flag wake: lane = tenant key, no engine idempotency key", () => {
    const wake = workGraphSettleWake(TENANT, 1_000)
    expect(wake.kind).toBe(WORKGRAPH_SETTLE_KIND)
    expect(wake.serialKey).toContain("org_1")
    expect(wake.serialKey).toContain("user_1")
    expect(wake.at).toBe(1_000)
    expect(wake.intent).toEqual(TENANT)
    expect("idempotencyKey" in wake).toBe(false) // forever-dedup would swallow later commands
  })

  it("parseSettleTenant round-trips and rejects junk", () => {
    expect(parseSettleTenant(JSON.stringify(TENANT))).toEqual(TENANT)
    expect(() => parseSettleTenant("null")).toThrow(/tenant/)
    expect(() => parseSettleTenant('{"organizationId":"x"}')).toThrow(/tenant/)
  })
})

describe("settleRetryDelayMs", () => {
  it("settled results ask for no retry", () => {
    expect(settleRetryDelayMs({ launched: [], results: [{ settled: true, state: "completed" }] })).toBeUndefined()
  })

  it("provisioning/unsettled results ask for a clamped retry", () => {
    expect(settleRetryDelayMs({ results: [{ state: "provisioning" }] })).toBe(1_000)
    expect(settleRetryDelayMs({ nested: { retryAfterMs: 15_000 } })).toBe(15_000)
    expect(settleRetryDelayMs({ retryAfterMs: 120_000 })).toBe(30_000) // capped
    expect(settleRetryDelayMs({ launched: [{ settled: true, state: "running" }] })).toBe(1_000)
  })
})

describe("composeHostedWakes", () => {
  function harness(settleResults: unknown[]) {
    const clock = { t: 1_000_000 }
    const store = new SqliteWakeStore()
    const settled: SettlementTenant[] = []
    const nudges: Array<{ serialKey: string | null; fireAt: number }> = []
    const wakes = composeHostedWakes(
      {} as HostedWorkerEnv,
      { nudge: (hint) => void nudges.push(hint) },
      {
        now: () => clock.t,
        store,
        settle: async (tenant) => {
          settled.push(tenant)
          return settleResults.shift() ?? {}
        },
      },
    )
    return { clock, store, settled, nudges, wakes }
  }

  it("fires a settle wake through the tenant-scoped settle", async () => {
    const { clock, wakes, settled } = harness([{ results: [{ settled: true }] }])
    const shape = workGraphSettleWake(TENANT, clock.t)
    await wakes.schedule({ ...shape })
    expect((await wakes.runDue(shape.serialKey)).fired).toBe(1)
    expect(settled).toEqual([TENANT])
  })

  it("an unsettled result schedules a durable retry wake on the same lane and nudges it", async () => {
    const { clock, wakes, nudges, settled } = harness([
      { results: [{ state: "provisioning", retryAfterMs: 5_000 }] },
      { results: [{ settled: true }] },
    ])
    const shape = workGraphSettleWake(TENANT, clock.t)
    await wakes.schedule({ ...shape })
    nudges.length = 0

    expect((await wakes.runDue(shape.serialKey)).fired).toBe(1)
    // retry wake exists in the future on the same lane, and the driver was hinted
    expect(nudges).toHaveLength(1)
    expect(nudges[0]!.serialKey).toBe(shape.serialKey)
    expect(nudges[0]!.fireAt).toBe(clock.t + 5_000)
    expect((await wakes.runDue(shape.serialKey)).fired).toBe(0) // not due yet

    clock.t += 5_000
    expect((await wakes.runDue(shape.serialKey)).fired).toBe(1)
    expect(settled).toHaveLength(2)
  })

  it("fails closed without Convex configuration", () => {
    expect(() => composeHostedWakes({} as HostedWorkerEnv, { nudge: () => {} })).toThrow(/Convex/)
  })
})
