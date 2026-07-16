import { describe, expect, test } from "vitest"
import {
  WorkGraphSettler,
  createCloudflareSettlementDispatcher,
  settlementTenantKey,
  type WorkGraphSettlerStorage,
} from "./cloudflare-settlement-dispatcher"

const tenant = { organizationId: "org-a", ownerUserId: "user-a" }

class MemoryStorage implements WorkGraphSettlerStorage {
  readonly values = new Map<string, unknown>()
  readonly alarms: number[] = []
  alarm: number | null = null
  tenantWrites = 0

  async get<T>(key: string) {
    return this.values.get(key) as T | undefined
  }

  async put(key: string, value: unknown) {
    if (key === "tenant") this.tenantWrites += 1
    this.values.set(key, value)
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key)
  }

  async getAlarm() {
    return this.alarm
  }

  async setAlarm(scheduledTime: number) {
    this.alarm = scheduledTime
    this.alarms.push(scheduledTime)
  }
}

describe("Cloudflare WorkGraph settlement dispatcher", () => {
  test("routes a collision-safe tenant identity through the current request waitUntil", async () => {
    const calls: Array<{ id: string; tenant: typeof tenant }> = []
    const work: Promise<unknown>[] = []
    const dispatcher = createCloudflareSettlementDispatcher({
      namespace: {
        idFromName: (name) => name,
        get: (id) => ({
          fetch: async (request) => {
            calls.push({ id: String(id), tenant: await request.json() as typeof tenant })
            return new Response(null, { status: 204 })
          },
        }),
      },
      waitUntil: (promise) => work.push(promise),
    })

    dispatcher.nudge(tenant)

    expect(work).toHaveLength(1)
    await Promise.all(work)
    expect(calls).toEqual([{ id: JSON.stringify(["org-a", "user-a"]), tenant }])
    expect(settlementTenantKey({ organizationId: "org:a", ownerUserId: "user" })).not.toBe(
      settlementTenantKey({ organizationId: "org", ownerUserId: "a:user" }),
    )
  })

  test("coalesces repeated nudges into one immediate alarm and persists the tenant once", async () => {
    const storage = new MemoryStorage()
    const settler = new WorkGraphSettler(
      { storage },
      {},
      { now: () => 1_000, settle: async () => ({ unsettled: false }) },
    )

    await Promise.all(Array.from({ length: 5 }, () => nudge(settler)))

    expect(storage.alarms).toEqual([1_000])
    expect(storage.tenantWrites).toBe(1)
    expect(storage.values.get("tenant")).toEqual(tenant)
  })

  test("re-arms partial settlement with exponential backoff capped at thirty seconds", async () => {
    const storage = new MemoryStorage()
    let now = 0
    const settler = new WorkGraphSettler(
      { storage },
      {},
      { now: () => now, settle: async () => ({ unsettled: true }) },
    )
    await nudge(settler)
    storage.alarms.length = 0

    for (const instant of [0, 1_000, 3_000, 7_000, 15_000, 31_000, 61_000]) {
      now = instant
      await settler.alarm()
    }

    expect(storage.alarms).toEqual([1_000, 3_000, 7_000, 15_000, 31_000, 61_000, 91_000])
  })

  test("keeps an explicit retry pending across capped intermediate alarms", async () => {
    const storage = new MemoryStorage()
    let now = 0
    const results = [{ unsettled: true, retryAfterMs: 60_000 }, { unsettled: false }, { unsettled: false }]
    const settler = new WorkGraphSettler(
      { storage },
      {},
      { now: () => now, settle: async () => results.shift() },
    )
    await nudge(settler)
    storage.alarms.length = 0

    await settler.alarm()
    now = 30_000
    await settler.alarm()
    now = 60_000
    await settler.alarm()

    expect(storage.alarms).toEqual([30_000, 60_000])
    expect(storage.values.has("settlementStartedAt")).toBe(false)
  })

  test("keeps production launch activity warm while a provisioning retry becomes due", async () => {
    const storage = new MemoryStorage()
    let now = 0
    const results = [
      { launched: [{ settled: true }], results: [] },
      { launched: [], results: [] },
    ]
    const settler = new WorkGraphSettler(
      { storage },
      {},
      { now: () => now, settle: async () => results.shift() },
    )
    await nudge(settler)
    storage.alarms.length = 0

    await settler.alarm()
    now = 1_000
    await settler.alarm()

    expect(storage.alarms).toEqual([1_000, 3_000])
  })

  test("loads the persisted tenant after a simulated Durable Object restart", async () => {
    const storage = new MemoryStorage()
    await new WorkGraphSettler(
      { storage },
      {},
      { now: () => 100, settle: async () => ({ unsettled: false }) },
    ).fetch(nudgeRequest())
    const settled: Array<typeof tenant> = []

    await new WorkGraphSettler(
      { storage },
      {},
      {
        now: () => 100,
        settle: async (value) => {
          settled.push(value)
          return { unsettled: false }
        },
      },
    ).alarm()

    expect(settled).toEqual([tenant])
  })

  test("stops self-rearming after ten minutes so the cron backstop owns recovery", async () => {
    const storage = new MemoryStorage()
    let now = 0
    const settler = new WorkGraphSettler(
      { storage },
      {},
      { now: () => now, settle: async () => ({ unsettled: true }) },
    )
    await nudge(settler)
    await settler.alarm()
    storage.alarms.length = 0

    now = 10 * 60_000 + 1
    await settler.alarm()

    expect(storage.alarms).toEqual([])
    expect(storage.values.has("settlementStartedAt")).toBe(false)
  })
})

function nudge(settler: WorkGraphSettler) {
  return settler.fetch(nudgeRequest())
}

function nudgeRequest() {
  return new Request("https://workgraph-settler.internal/nudge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(tenant),
  })
}
