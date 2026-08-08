import { describe, it, expect } from "vitest"
import type { Wakes, WakeDriver } from "@claxedo/wakes"
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
  runDue?: (key?: string | null) => Promise<{ fired: number }>
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

  it("re-arms at the authoritative firing-lease boundary when the lane is still blocked", async () => {
    const clock = { t: 1_000 }
    const results = [
      { fired: 0, blockedUntil: 31_000 },
      { fired: 1 },
      { fired: 0 },
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
        throw new Error("convex down")
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
