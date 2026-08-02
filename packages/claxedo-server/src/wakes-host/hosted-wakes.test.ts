import { describe, it, expect } from "vitest"
import type { SettlementTenant } from "../workgraph-host/settlement-dispatcher"
import { SqliteWakeStore } from "@claxedo/wakes/sqlite"
import {
  WORKGRAPH_CONTROL_KIND,
  WORKGRAPH_MASTER_KIND,
  WORKGRAPH_SETTLE_KIND,
  composeHostedWakes,
  parseSettleTenant,
  parseMasterIntent,
  settleRetryDelayMs,
  nextDailyMasterRun,
  workGraphControlWake,
  workGraphSettleWake,
  workGraphMasterWake,
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

describe("workGraphControlWake", () => {
  it("shapes a control wake on a dedicated `${tenant}:control` lane", () => {
    const settle = workGraphSettleWake(TENANT, 1_000)
    const control = workGraphControlWake(TENANT, 1_000)
    expect(control.kind).toBe(WORKGRAPH_CONTROL_KIND)
    expect(control.at).toBe(1_000)
    expect(control.intent).toEqual(TENANT)
    // Distinct lane from settle => its own idle ClaxedoWakeLane DO instance.
    expect(control.serialKey).toBe(`${settle.serialKey}:control`)
    expect(control.serialKey).not.toBe(settle.serialKey)
    expect(parseSettleTenant(JSON.stringify(control.intent))).toEqual(TENANT)
  })

  it("fires through the registered control sink, isolated from settle", async () => {
    const store = new SqliteWakeStore()
    const controlled: unknown[] = []
    const settled: unknown[] = []
    const wakes = composeHostedWakes({} as HostedWorkerEnv, { nudge: () => {} }, {
      now: () => 1_000,
      store,
      settle: async (tenant) => void settled.push(tenant),
      control: async (tenant) => void controlled.push(tenant),
    })
    const wake = workGraphControlWake(TENANT, 1_000)
    await wakes.schedule(wake)
    expect((await wakes.runDue(wake.serialKey)).fired).toBe(1)
    expect(controlled).toEqual([TENANT])
    expect(settled).toEqual([]) // the settle sink is never invoked on the control lane
  })
})

describe("workGraphMasterWake", () => {
  const intent = { ...TENANT, streamId: "stream_1", trigger: "task_settled" as const }

  it("uses one serial lane per Stream and round-trips its trigger", () => {
    const wake = workGraphMasterWake(intent, 1_000)
    expect(wake).toMatchObject({ kind: WORKGRAPH_MASTER_KIND, at: 1_000, intent })
    expect(wake.serialKey).toContain("stream_1")
    expect(parseMasterIntent(JSON.stringify(intent))).toEqual(intent)
    expect(() => parseMasterIntent("{}")).toThrow(/Stream identity/)
  })

  it("fires through the registered master sink", async () => {
    const store = new SqliteWakeStore()
    const turns: unknown[] = []
    const wakes = composeHostedWakes({} as HostedWorkerEnv, { nudge: () => {} }, {
      now: () => 1_000,
      store,
      settle: async () => ({}),
      master: async (value) => void turns.push(value),
    })
    const wake = workGraphMasterWake(intent, 1_000)
    await wakes.schedule(wake)
    expect((await wakes.runDue(wake.serialKey)).fired).toBe(1)
    expect(turns).toEqual([intent])
  })

  it("computes the next 06:00 UTC scheduled rebase strictly after the prior turn", () => {
    expect(nextDailyMasterRun("daily@06:00Z", Date.UTC(2026, 6, 19, 5, 59))).toBe(Date.UTC(2026, 6, 19, 6))
    expect(nextDailyMasterRun("daily@06:00Z", Date.UTC(2026, 6, 19, 6))).toBe(Date.UTC(2026, 6, 20, 6))
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
