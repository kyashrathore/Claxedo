import { describe, it, expect } from "vitest"
import { createWakes, type Wake, type Wakes, type WakeDriver } from "@claxedo/wakes"
import { SqliteWakeStore } from "@claxedo/wakes/sqlite"
import {
  WakeLane,
  dispatchWakeLaneNudge,
  wakeLaneName,
  type WakeLaneNamespace,
  type WakeLaneStorage,
} from "./wake-lane.cf"

function fakeStorage(): WakeLaneStorage & { alarm: number | null; data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    alarm: null,
    async get<T>(key: string) {
      return data.get(key) as T | undefined
    },
    async put(key: string, value: unknown) {
      data.set(key, value)
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key)
    },
    async getAlarm() {
      return this.alarm
    },
    async setAlarm(scheduledTime: number) {
      this.alarm = scheduledTime
    },
  }
}

function nudgeRequest(serialKey: string | null, fireAt: number) {
  return new Request("https://wake-lane.internal/nudge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serialKey, fireAt }),
  })
}

function laneHarness(input: {
  now?: () => number
  runDue?: (key?: string | null) => Promise<{ fired: number; nextAt?: number }>
  captureDriver?: (driver: WakeDriver) => void
  report?: (e: unknown) => void
}) {
  const storage = fakeStorage()
  const lane = new WakeLane({ storage }, {}, {
    now: input.now ?? (() => 1_000_000),
    reportError: ((e: unknown) => input.report?.(e)) as never,
    createWakes: (_env, inDoDriver) => {
      input.captureDriver?.(inDoDriver)
      return { runDue: input.runDue ?? (async () => ({ fired: 0 })) } as unknown as Wakes
    },
  })
  return { storage, lane }
}

describe("WakeLane nudge", () => {
  it("persists the lane key and arms the alarm at max(now, fireAt)", async () => {
    const { storage, lane } = laneHarness({ now: () => 1_000 })
    expect((await lane.fetch(nudgeRequest("org:a", 500))).status).toBe(204)
    expect(storage.data.get("lane")).toBe("org:a")
    expect(storage.alarm).toBe(1_000) // past fireAt clamps to now

    storage.alarm = null
    await lane.fetch(nudgeRequest("org:a", 5_000))
    expect(storage.alarm).toBe(5_000) // future fireAt arms a precise timer
  })

  it("earliest alarm wins; later hints never postpone", async () => {
    const { storage, lane } = laneHarness({ now: () => 1_000 })
    await lane.fetch(nudgeRequest("org:a", 2_000))
    await lane.fetch(nudgeRequest("org:a", 9_000))
    expect(storage.alarm).toBe(2_000)
    await lane.fetch(nudgeRequest("org:a", 1_500))
    expect(storage.alarm).toBe(1_500)
  })

  it("rejects a hint whose lane key does not match the persisted identity", async () => {
    const { lane } = laneHarness({})
    await lane.fetch(nudgeRequest("org:a", 1))
    expect((await lane.fetch(nudgeRequest("org:b", 1))).status).toBe(409)
  })

  it("supports the null lane via its sentinel name", () => {
    expect(wakeLaneName(null)).not.toBe(wakeLaneName("null"))
  })
})

describe("WakeLane alarm", () => {
  it("drains the lane: runs runDue(serialKey) until nothing fires", async () => {
    const calls: Array<string | null | undefined> = []
    const fires = [1, 1, 0]
    const { storage, lane } = laneHarness({
      runDue: async (key) => {
        calls.push(key)
        return { fired: fires.shift() ?? 0 }
      },
    })
    await lane.fetch(nudgeRequest("org:a", 1))
    await lane.alarm()
    expect(calls).toEqual(["org:a", "org:a", "org:a"])
    expect(storage.data.has("laneBackoffMs")).toBe(false) // progress cleared
  })

  it("re-arms at the lane's next obligation as the store reports it", async () => {
    const clock = { t: 1_000 }
    const results = [
      { fired: 0, nextAt: 31_000 },
      { fired: 1 },
      { fired: 0, nextAt: 600_000 },
    ]
    const { storage, lane } = laneHarness({
      now: () => clock.t,
      runDue: async () => results.shift() ?? { fired: 0 },
    })
    await lane.fetch(nudgeRequest("org:a", clock.t))

    storage.alarm = null
    await lane.alarm()
    expect(storage.alarm).toBe(31_000)

    clock.t = 31_000
    storage.alarm = null
    await lane.alarm()
    expect(results).toHaveLength(0)
    expect(storage.alarm).toBe(600_000) // a boundary later than this alarm still gets armed
  })

  it("arms nothing once the lane owes no further work", async () => {
    const { storage, lane } = laneHarness({ runDue: async () => ({ fired: 0 }) })
    await lane.fetch(nudgeRequest("org:a", 1))
    storage.alarm = null
    await lane.alarm()
    expect(storage.alarm).toBeNull()
  })

  it("yields and resumes immediately when a lane is still firing at the round cap", async () => {
    let calls = 0
    const { storage, lane } = laneHarness({
      now: () => 1_000,
      runDue: async () => {
        calls++
        return { fired: 1 }
      },
    })
    await lane.fetch(nudgeRequest("org:a", 1))
    storage.alarm = null
    await lane.alarm()
    expect(calls).toBe(50)
    expect(storage.alarm).toBe(1_000)
  })

  it("does nothing when never nudged (no persisted lane key)", async () => {
    const calls: unknown[] = []
    const { lane } = laneHarness({
      runDue: async (key) => {
        calls.push(key)
        return { fired: 0 }
      },
    })
    await lane.alarm()
    expect(calls).toEqual([])
  })

  it("a failing drain reports, backs off with an alarm, and gives up after the window", async () => {
    const reported: unknown[] = []
    const clock = { t: 1_000_000 }
    const { storage, lane } = laneHarness({
      now: () => clock.t,
      runDue: async () => {
        throw new Error("authority down")
      },
      report: (e) => void reported.push(e),
    })
    await lane.fetch(nudgeRequest("org:a", 1))

    storage.alarm = null // the platform consumes the alarm before invoking alarm()
    await lane.alarm()
    expect(reported).toHaveLength(1)
    expect(storage.alarm).toBe(clock.t + 1_000) // min backoff

    clock.t += 1_000
    storage.alarm = null
    await lane.alarm()
    expect(storage.alarm).toBe(clock.t + 2_000) // doubled

    clock.t += 15 * 60_000 // beyond the lane window
    storage.alarm = null
    await lane.alarm()
    expect(storage.data.has("laneStartedAt")).toBe(false) // gave up; sweep owns it
  })

  it("sink-scheduled retries re-arm this object's own alarm via the in-DO driver", async () => {
    let driver: WakeDriver | undefined
    const { storage, lane } = laneHarness({
      now: () => 1_000,
      captureDriver: (d) => (driver = d),
    })
    await lane.fetch(nudgeRequest("org:a", 1))
    storage.alarm = null
    await lane.alarm() // composes the engine, capturing the in-DO driver
    driver!.nudge({ serialKey: "org:a", fireAt: 4_000 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(storage.alarm).toBe(4_000)
  })
})

const WS = "ws1"

/**
 * The hosted composition end to end: the real engine over a real store, one
 * `WakeLane` object per key reached through the real `dispatchWakeLaneNudge`,
 * and a clock that only moves when the platform would deliver an alarm. No
 * sweep exists here, so every terminal state these tests reach is one the
 * lane objects reached on their own.
 */
function hostedCluster() {
  const clock = { t: 1_000_000 }
  const store = new SqliteWakeStore()
  const settled: string[] = []
  const reported: unknown[] = []
  const crashOnce = new Set<string>()
  const objects = new Map<string, { storage: ReturnType<typeof fakeStorage>; lane: WakeLane }>()
  const inFlight: Array<Promise<unknown>> = []

  const sinks = {
    settle: async (wake: Wake) => {
      if (crashOnce.delete(wake.id)) throw new Error(`crash firing ${wake.id}`)
      settled.push(wake.id)
    },
  }

  function laneObject(name: string) {
    const existing = objects.get(name)
    if (existing) return existing
    const storage = fakeStorage()
    const made = {
      storage,
      lane: new WakeLane({ storage }, {}, {
        now: () => clock.t,
        reportError: ((error: unknown) => void reported.push(error)) as never,
        createWakes: (_env, inDoDriver) =>
          createWakes({ store, sinks, authorize: () => false, driver: inDoDriver, now: () => clock.t }),
      }),
    }
    objects.set(name, made)
    return made
  }

  const namespace: WakeLaneNamespace = {
    idFromName: (name) => name,
    get: (id) => ({ fetch: (request: Request) => laneObject(id as string).lane.fetch(request) }),
  }

  // The worker request path: creates go through an engine whose driver
  // dispatches hints at the lane objects.
  const worker = createWakes({
    store,
    sinks,
    authorize: () => false,
    now: () => clock.t,
    driver: { nudge: (hint) => void inFlight.push(dispatchWakeLaneNudge(namespace, hint)) },
  })

  async function settleHints() {
    while (inFlight.length > 0) await Promise.all(inFlight.splice(0))
  }

  const alarmOf = (name: string) => objects.get(name)?.storage.alarm ?? null

  async function fireAlarm(name: string) {
    const object = laneObject(name)
    object.storage.alarm = null // the platform consumes the alarm before invoking alarm()
    await object.lane.alarm()
    await settleHints()
  }

  /** Deliver every alarm due at or before `untilMs`, earliest first. */
  async function runAlarmsUntil(untilMs: number) {
    for (let step = 0; step < 100; step++) {
      await settleHints()
      let next: { name: string; at: number } | undefined
      for (const [name, object] of objects) {
        const at = object.storage.alarm
        if (at === null || at > untilMs) continue
        if (!next || at < next.at) next = { name, at }
      }
      if (!next) return
      clock.t = Math.max(clock.t, next.at)
      await fireAlarm(next.name)
    }
    throw new Error("the alarm queue never settled")
  }

  return { clock, store, worker, settled, reported, crashOnce, alarmOf, fireAlarm, runAlarmsUntil, settleHints }
}

describe("hosted lane flow", () => {
  it("re-derives a later deadline that an earlier fire alarm discarded", async () => {
    const c = hostedCluster()
    const t0 = c.clock.t
    const fire = await c.worker.schedule({
      workspaceId: WS, kind: "settle", serialKey: "org:a", at: t0 + 60_000, intent: {},
    })
    const deadline = await c.worker.watch({
      workspaceId: WS, kind: "settle", serialKey: "org:a", eventKey: "never", intent: {}, expiresAt: t0 + 600_000,
    })
    await c.settleHints()
    // Earliest wins: the deadline hint lands behind the fire alarm and is lost.
    expect(c.alarmOf("org:a")).toBe(t0 + 60_000)

    await c.runAlarmsUntil(t0 + 60_000)
    expect(c.settled).toEqual([fire.wakeId])
    expect(c.alarmOf("org:a")).toBe(t0 + 600_000) // recovered from the store, not the hint

    await c.runAlarmsUntil(t0 + 600_000)
    expect(c.settled).toEqual([fire.wakeId, deadline.wakeId])
    expect((await c.store.get(deadline.wakeId))!.state).toBe("expired")
    expect(await c.store.countLive(WS)).toBe(0)
    expect(c.alarmOf("org:a")).toBeNull() // drained: the lane arms nothing further
  })

  it("carries a crashed fire through backoff and the lease boundary to completion", async () => {
    const c = hostedCluster()
    const t0 = c.clock.t
    const { wakeId } = await c.worker.schedule({
      workspaceId: WS, kind: "settle", serialKey: "org:a", at: t0 + 1_000, intent: {},
    })
    c.crashOnce.add(wakeId)

    await c.runAlarmsUntil(t0 + 1_000)
    expect(c.settled).toEqual([])
    expect(c.reported).toHaveLength(1)
    expect((await c.store.get(wakeId))!.state).toBe("firing")
    expect(c.alarmOf("org:a")).toBe(t0 + 2_000) // minimum backoff

    // The backoff pass makes no progress — the lease is still live — so the
    // lane re-arms at the boundary where reclaim becomes possible.
    await c.runAlarmsUntil(t0 + 2_000)
    expect(c.settled).toEqual([])
    expect(c.alarmOf("org:a")).toBe(t0 + 31_000)

    await c.runAlarmsUntil(t0 + 31_000)
    expect(c.settled).toEqual([wakeId])
    expect((await c.store.get(wakeId))!.state).toBe("fired")
    expect(c.alarmOf("org:a")).toBeNull()
  })

  it("keeps lanes isolated: one object's drain never fires another lane's work", async () => {
    const c = hostedCluster()
    const t0 = c.clock.t
    const common = { workspaceId: WS, kind: "settle", at: t0 + 1_000, intent: {} } as const
    const a = await c.worker.schedule({ ...common, serialKey: "org:a" })
    const b = await c.worker.schedule({ ...common, serialKey: "org:b" })
    const unlaned = await c.worker.schedule(common)
    await c.settleHints()
    expect(c.alarmOf(wakeLaneName(null))).toBe(t0 + 1_000)

    c.clock.t = t0 + 1_000
    await c.fireAlarm("org:a")
    expect(c.settled).toEqual([a.wakeId])
    expect((await c.store.get(b.wakeId))!.state).toBe("pending")
    expect((await c.store.get(unlaned.wakeId))!.state).toBe("pending")

    await c.runAlarmsUntil(t0 + 1_000)
    expect([...c.settled].sort()).toEqual([a.wakeId, b.wakeId, unlaned.wakeId].sort())
    expect(await c.store.countLive(WS)).toBe(0)
  })
})

describe("Worker-side driver", () => {
  it("dispatches the hint to the lane's DO and surfaces non-OK", async () => {
    const requests: Array<{ name: string; body: unknown }> = []
    const namespace: WakeLaneNamespace = {
      idFromName: (name) => name,
      get: (id) => ({
        fetch: async (request: Request) => {
          requests.push({ name: id as string, body: await request.json() })
          return new Response(null, { status: 204 })
        },
      }),
    }
    await dispatchWakeLaneNudge(namespace, { serialKey: "org:a", fireAt: 7 })
    expect(requests).toEqual([{ name: "org:a", body: { serialKey: "org:a", fireAt: 7 } }])

    const failing: WakeLaneNamespace = {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => new Response("boom", { status: 500 }) }),
    }
    await expect(dispatchWakeLaneNudge(failing, { serialKey: null, fireAt: 1 })).rejects.toThrow("500")
  })
})
