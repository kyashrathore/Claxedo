import { describe, expect, test, vi } from "vitest"
import {
  WorkGraphSettler,
  createCloudflareSettlementDispatcher,
  type WorkGraphSettlerStorage,
} from "./settlement-dispatcher.cf"
import { settlementTenantKey } from "../../workgraph-host/settlement-dispatcher"

const tenant = { organizationId: "org-a", ownerUserId: "user-a" }

class MemoryStorage implements WorkGraphSettlerStorage {
  readonly values = new Map<string, unknown>()
  readonly alarms: number[] = []
  alarm: number | null = null
  alarmReads = 0
  tenantReadFailures = 0
  tenantWrites = 0

  async get<T>(key: string) {
    if (key === "tenant" && this.tenantReadFailures > 0) {
      this.tenantReadFailures -= 1
      throw new Error("storage unavailable")
    }
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
    this.alarmReads += 1
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

  test("reports rejected and unsuccessful nudges without rejecting waitUntil work", async () => {
    const errors: unknown[] = []
    const work: Promise<unknown>[] = []
    const responses = [
      async () => new Response("unavailable", { status: 503 }),
      async () => { throw new Error("network unavailable") },
    ]
    const dispatcher = createCloudflareSettlementDispatcher({
      namespace: {
        idFromName: (name) => name,
        get: () => ({ fetch: () => responses.shift()!() }),
      },
      waitUntil: (promise) => work.push(promise),
      reportError: (error) => { errors.push(error) },
    })

    expect(() => dispatcher.nudge(tenant)).not.toThrow()
    expect(() => dispatcher.nudge(tenant)).not.toThrow()
    await expect(Promise.all(work)).resolves.toEqual([undefined, undefined])
    expect(errors.map(String)).toEqual(expect.arrayContaining([
      "Error: WorkGraph settler nudge failed: 503 unavailable",
      "Error: network unavailable",
    ]))
  })

  test("isolates a throwing nudge reporter", async () => {
    const work: Promise<unknown>[] = []
    const dispatcher = createCloudflareSettlementDispatcher({
      namespace: {
        idFromName: (name) => name,
        get: () => ({ fetch: async () => new Response(null, { status: 500 }) }),
      },
      waitUntil: (promise) => work.push(promise),
      reportError: vi.fn(() => { throw new Error("reporting failed") }),
    })

    dispatcher.nudge(tenant)
    await expect(Promise.all(work)).resolves.toEqual([undefined])
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
    expect(storage.alarmReads).toBe(1)
    expect(storage.tenantWrites).toBe(1)
    expect(storage.values.get("tenant")).toEqual(tenant)
  })

  test("keeps an already-due alarm and pulls a future alarm forward", async () => {
    const due = new MemoryStorage()
    due.alarm = 999
    const future = new MemoryStorage()
    future.alarm = 1_001

    await nudge(new WorkGraphSettler({ storage: due }, {}, { now: () => 1_000 }))
    await nudge(new WorkGraphSettler({ storage: future }, {}, { now: () => 1_000 }))

    expect(due.alarms).toEqual([])
    expect(future.alarms).toEqual([1_000])
  })

  test("rejects a tenant that conflicts with the persisted Durable Object identity", async () => {
    const storage = new MemoryStorage()
    const settler = new WorkGraphSettler({ storage }, {}, { now: () => 1_000 })
    await nudge(settler)

    await expect(settler.fetch(nudgeRequest({ organizationId: "org-b", ownerUserId: "user-b" }))).rejects.toThrow(
      "tenant does not match its persisted identity",
    )
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
      await runAlarm(settler, storage)
    }

    expect(storage.alarms).toEqual([1_000, 3_000, 7_000, 15_000, 31_000, 61_000, 91_000])
  })

  test("keeps an explicit retry pending across capped intermediate alarms", async () => {
    const storage = new MemoryStorage()
    let now = 0
    const results = [{ settled: true, retryAfterMs: 60_000 }, { settled: true }, { settled: true }]
    const settler = new WorkGraphSettler(
      { storage },
      {},
      { now: () => now, settle: async () => results.shift() },
    )
    await nudge(settler)
    storage.alarms.length = 0

    await runAlarm(settler, storage)
    now = 30_000
    await runAlarm(settler, storage)
    now = 60_000
    await runAlarm(settler, storage)

    expect(storage.alarms).toEqual([30_000, 60_000])
    expect(storage.values.has("settlementStartedAt")).toBe(false)
  })

  test("schedules backoff from settlement completion rather than alarm invocation", async () => {
    const storage = new MemoryStorage()
    let now = 0
    const settler = new WorkGraphSettler(
      { storage },
      {},
      {
        now: () => now,
        settle: async () => {
          now = 5_000
          return { unsettled: true }
        },
      },
    )
    await nudge(settler)
    storage.alarms.length = 0

    await runAlarm(settler, storage)

    expect(storage.alarms).toEqual([6_000])
  })

  test("preserves a fresh immediate nudge while an alarm computes its retry", async () => {
    const storage = new MemoryStorage()
    let begin!: () => void
    const started = new Promise<void>((resolve) => { begin = resolve })
    let finish!: (value: unknown) => void
    const settled = new Promise((resolve) => { finish = resolve })
    const settler = new WorkGraphSettler(
      { storage },
      {},
      { now: () => 1_000, settle: () => { begin(); return settled } },
    )
    await nudge(settler)
    storage.alarms.length = 0

    const alarm = runAlarm(settler, storage)
    await started
    await nudge(settler)
    finish({ unsettled: true })
    await alarm

    expect(storage.alarms).toEqual([1_000])
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

    await runAlarm(settler, storage)
    now = 1_000
    await runAlarm(settler, storage)

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

    const restarted = new WorkGraphSettler(
      { storage },
      {},
      {
        now: () => 100,
        settle: async (value) => {
          settled.push(value)
          return { unsettled: false }
        },
      },
    )
    await runAlarm(restarted, storage)

    expect(settled).toEqual([tenant])
  })

  test("retries tenant storage after a transient read failure", async () => {
    const storage = new MemoryStorage()
    storage.tenantReadFailures = 1
    const settler = new WorkGraphSettler({ storage }, {}, { now: () => 100 })

    await expect(nudge(settler)).rejects.toThrow("storage unavailable")
    await expect(nudge(settler)).resolves.toMatchObject({ status: 204 })
    expect(storage.values.get("tenant")).toEqual(tenant)
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
    await runAlarm(settler, storage)
    storage.alarms.length = 0

    now = 10 * 60_000 + 1
    await runAlarm(settler, storage)

    expect(storage.alarms).toEqual([])
    expect(storage.values.has("settlementStartedAt")).toBe(false)
  })
})

function nudge(settler: WorkGraphSettler) {
  return settler.fetch(nudgeRequest())
}

function runAlarm(settler: WorkGraphSettler, storage: MemoryStorage) {
  // Cloudflare reports no current alarm from inside the running handler unless
  // another event has scheduled one since this invocation began.
  storage.alarm = null
  return settler.alarm()
}

function nudgeRequest(value = tenant) {
  return new Request("https://workgraph-settler.internal/nudge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  })
}
