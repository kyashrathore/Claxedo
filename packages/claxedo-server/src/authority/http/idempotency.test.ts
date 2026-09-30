import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"
import {
  createIdempotencyCoordinator,
  IDEMPOTENCY_INFLIGHT_TTL_MS,
  IDEMPOTENCY_TTL_MS,
  IdempotencyCapacityError,
  IdempotencyConflictError,
  idempotencyCacheKey,
  memoryIdempotencyStore,
  parseIdempotencyKey,
  d1ProjectionCommandIdempotency,
  type DurableIdempotencyStore,
} from "./idempotency"
import { controlPlaneMigrations, miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../test-support/control-plane-migrations"

let clock = 1_800_000_000_000
beforeEach(() => {
  vi.spyOn(Date, "now").mockImplementation(() => clock)
})
afterEach(() => {
  vi.restoreAllMocks()
})

function registerKey(key: string) {
  return idempotencyCacheKey({
    operation: "register",
    principal: "signed:issuer|user_1",
    workspaceId: "ws_1",
    sessionId: "session_1",
    key,
  })
}

let d1: ControlPlaneDatabase
beforeAll(async () => {
  d1 = await miniflareControlPlaneDatabase(controlPlaneMigrations())
})
afterAll(async () => {
  await d1.dispose()
})

/** Moves a store's own clock: the process clock for memory, and for D1 every stored deadline, since its clock is the database's. */
async function ageD1Rows(ms: number) {
  await d1.database.prepare("update projection_command_idempotency set expires_at = expires_at - ?").bind(ms).run()
}

const stores: Array<[string, () => Promise<DurableIdempotencyStore>, (ms: number) => Promise<void>]> = [
  ["memory", async () => memoryIdempotencyStore(), async (ms) => {
    clock += ms
  }],
  ["D1", async () => {
    await d1.database.prepare("delete from projection_command_idempotency").run()
    return d1ProjectionCommandIdempotency(d1.database)
  }, ageD1Rows],
]

describe.each(stores)("instances sharing one %s idempotency store", (_name, createStore, advance) => {
  test("a duplicate command runs once and the second instance replays its response", async () => {
    const store = await createStore()
    const run = vi.fn(async () => ({ ok: true, maxEventOrdinal: 7 }))
    const key = registerKey("replay")

    await expect(createIdempotencyCoordinator(store).run(key, run, "fp")).resolves.toEqual({ ok: true, maxEventOrdinal: 7 })
    await expect(createIdempotencyCoordinator(store).run(key, run, "fp")).resolves.toEqual({ ok: true, maxEventOrdinal: 7 })
    expect(run).toHaveBeenCalledTimes(1)

    const separate = vi.fn(async () => ({ ok: true }))
    await createIdempotencyCoordinator(memoryIdempotencyStore()).run(key, separate, "fp")
    await createIdempotencyCoordinator(memoryIdempotencyStore()).run(key, separate, "fp")
    expect(separate).toHaveBeenCalledTimes(2)
  })

  test("an instance arriving while another runs the command is refused, not run", async () => {
    const store = await createStore()
    const deferred = Promise.withResolvers<{ ok: true }>()
    const run = vi.fn(() => deferred.promise)
    const key = registerKey("in-flight")

    const pending = createIdempotencyCoordinator(store).run(key, run, "fp")
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    await expect(createIdempotencyCoordinator(store).run(key, run, "fp"))
      .rejects.toMatchObject({ status: 409, code: "control_plane_idempotency_in_flight" })
    expect(run).toHaveBeenCalledTimes(1)

    deferred.resolve({ ok: true })
    await expect(pending).resolves.toEqual({ ok: true })
  })

  test("a claim abandoned past its lease is taken over and the command completes once", async () => {
    const store = await createStore()
    const key = registerKey("abandoned")
    const abandoned = Promise.withResolvers<{ ok: string }>()
    const started = vi.fn(() => abandoned.promise)
    const late = createIdempotencyCoordinator(store).run(key, started, "fp")
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1))

    await advance(IDEMPOTENCY_INFLIGHT_TTL_MS - 1_000)
    const early = vi.fn(async () => ({ ok: "early" }))
    await expect(createIdempotencyCoordinator(store).run(key, early, "fp")).rejects.toMatchObject({ status: 409 })
    expect(early).not.toHaveBeenCalled()

    await advance(1_000)
    const takeover = vi.fn(async () => ({ ok: "taker" }))
    await expect(createIdempotencyCoordinator(store).run(key, takeover, "fp")).resolves.toEqual({ ok: "taker" })
    expect(takeover).toHaveBeenCalledTimes(1)

    abandoned.resolve({ ok: "abandoned" })
    await expect(late).resolves.toEqual({ ok: "abandoned" })
    const replay = vi.fn(async () => ({ ok: "again" }))
    await expect(createIdempotencyCoordinator(store).run(key, replay, "fp")).resolves.toEqual({ ok: "taker" })
    expect(replay).not.toHaveBeenCalled()
  })

  test("instances racing to take over one lapsed claim run the command once", async () => {
    const store = await createStore()
    const key = registerKey("race")
    const hung = vi.fn(() => new Promise(() => {}))
    void createIdempotencyCoordinator(store).run(key, hung, "fp")
    await vi.waitFor(() => expect(hung).toHaveBeenCalledTimes(1))
    await advance(IDEMPOTENCY_INFLIGHT_TTL_MS)

    const gate = Promise.withResolvers<void>()
    const run = vi.fn(async () => {
      await gate.promise
      return { ok: true }
    })
    const racers = Promise.allSettled(Array.from({ length: 4 }, () => createIdempotencyCoordinator(store).run(key, run, "fp")))
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    gate.resolve()
    const settled = await racers
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  test("the same key with a different payload conflicts", async () => {
    const store = await createStore()
    const key = registerKey("payload")
    const run = vi.fn(async () => ({ ok: true }))
    await createIdempotencyCoordinator(store).run(key, run, "fingerprint-a")
    await expect(createIdempotencyCoordinator(store).run(key, run, "fingerprint-b"))
      .rejects.toMatchObject({ status: 409, code: "control_plane_idempotency_payload_mismatch" })
    expect(run).toHaveBeenCalledTimes(1)
  })

  test("a failed run releases its claim so the retry runs", async () => {
    const store = await createStore()
    const key = registerKey("failure")
    await expect(createIdempotencyCoordinator(store).run(key, async () => {
      throw new Error("unavailable")
    }, "fp")).rejects.toThrow("unavailable")
    await expect(createIdempotencyCoordinator(store).run(key, async () => "recovered", "fp")).resolves.toBe("recovered")
  })

  test("a recorded result is replayed until its TTL, then the key runs again", async () => {
    const store = await createStore()
    const key = registerKey("ttl")
    const run = vi.fn(async () => ({ ok: true }))
    await createIdempotencyCoordinator(store).run(key, run, "fp")
    await advance(IDEMPOTENCY_TTL_MS - 1_000)
    await createIdempotencyCoordinator(store).run(key, run, "fp")
    expect(run).toHaveBeenCalledTimes(1)
    await advance(1_000)
    await createIdempotencyCoordinator(store).run(key, run, "other-payload")
    expect(run).toHaveBeenCalledTimes(2)
  })

  test("a store failure refuses the command instead of running it", async () => {
    const store = await createStore()
    vi.spyOn(store, "begin").mockRejectedValue(new Error("store unavailable"))
    const run = vi.fn(async () => ({ ok: true }))
    await expect(createIdempotencyCoordinator(store).run(registerKey("store-down"), run, "fp")).rejects.toThrow("store unavailable")
    expect(run).not.toHaveBeenCalled()
  })
})

describe("D1 projection command idempotency rows", () => {
  async function rows(database: D1Database) {
    const result = await database.prepare("select cache_key from projection_command_idempotency order by cache_key").all<{ cache_key: string }>()
    return result.results.map((row) => row.cache_key)
  }

  test("expired results and lapsed claims are deleted when the next command begins", async () => {
    await d1.database.prepare("delete from projection_command_idempotency").run()
    const store = d1ProjectionCommandIdempotency(d1.database)
    const hang = () => {
      const started = vi.fn(() => new Promise(() => {}))
      return { started, done: () => vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1)) }
    }
    const completed = registerKey("completed")!
    const lapsed = registerKey("lapsed")!
    const live = registerKey("live")!
    const next = registerKey("next")!
    await createIdempotencyCoordinator(store).run(completed, async () => ({ ok: true }), "fp")
    const lapsedRun = hang()
    void createIdempotencyCoordinator(store).run(lapsed, lapsedRun.started, "fp")
    await lapsedRun.done()
    expect(await rows(d1.database)).toEqual([completed, lapsed].toSorted())

    await ageD1Rows(IDEMPOTENCY_INFLIGHT_TTL_MS)
    const liveRun = hang()
    void createIdempotencyCoordinator(store).run(live, liveRun.started, "fp")
    await liveRun.done()
    expect(await rows(d1.database)).toEqual([completed, live].toSorted())

    await ageD1Rows(IDEMPOTENCY_TTL_MS - IDEMPOTENCY_INFLIGHT_TTL_MS)
    await createIdempotencyCoordinator(store).run(next, async () => ({ ok: true }), "fp")
    expect(await rows(d1.database)).toEqual([next])
  })

  test("an instance whose clock runs ahead neither takes over nor prunes a claim still inside its lease by database time", async () => {
    await d1.database.prepare("delete from projection_command_idempotency").run()
    const store = d1ProjectionCommandIdempotency(d1.database)
    const held = registerKey("held")!
    const hung = vi.fn(() => new Promise(() => {}))
    void createIdempotencyCoordinator(store).run(held, hung, "fp")
    await vi.waitFor(() => expect(hung).toHaveBeenCalledTimes(1))

    clock += IDEMPOTENCY_TTL_MS * 2
    const ahead = vi.fn(async () => ({ ok: "ahead" }))
    await expect(createIdempotencyCoordinator(store).run(held, ahead, "fp"))
      .rejects.toMatchObject({ status: 409, code: "control_plane_idempotency_in_flight" })
    await createIdempotencyCoordinator(store).run(registerKey("other")!, async () => ({ ok: true }), "fp")
    expect(ahead).not.toHaveBeenCalled()
    expect(await rows(d1.database)).toEqual([held, registerKey("other")!].toSorted())
  })
})

describe("one coordinator", () => {
  test("coalesces concurrent requests for one key onto one run", async () => {
    const coordinator = createIdempotencyCoordinator(memoryIdempotencyStore())
    const deferred = Promise.withResolvers<string>()
    const run = vi.fn(() => deferred.promise)
    const first = coordinator.run("coalesce", run)
    const second = coordinator.run("coalesce", run)
    deferred.resolve("done")
    await expect(Promise.all([first, second])).resolves.toEqual(["done", "done"])
    expect(run).toHaveBeenCalledTimes(1)
  })

  test("refuses new distinct work at pending capacity without evicting an existing key, and recovers after the deadline", async () => {
    const coordinator = createIdempotencyCoordinator(memoryIdempotencyStore())
    const pending = Array.from({ length: 1_000 }, () => Promise.withResolvers<number>())
    const runs = pending.map((deferred) => vi.fn(() => deferred.promise))
    const promises = runs.map((run, index) => coordinator.run(`pending:${index}`, run))
    await vi.waitFor(() => expect(runs[999]).toHaveBeenCalledTimes(1))

    const overflow = vi.fn(async () => "overflow")
    await expect(coordinator.run("pending:overflow", overflow)).rejects.toBeInstanceOf(IdempotencyCapacityError)
    expect(overflow).not.toHaveBeenCalled()
    const duplicate = coordinator.run("pending:0", runs[0])
    expect(runs[0]).toHaveBeenCalledTimes(1)

    clock += IDEMPOTENCY_INFLIGHT_TTL_MS
    await expect(coordinator.run("pending:recovered", async () => "served")).resolves.toBe("served")

    pending.forEach((deferred) => deferred.resolve(0))
    await expect(Promise.all([...promises, duplicate])).resolves.toHaveLength(1_001)
  })

  test("rejects a concurrent reuse of a key with a different payload", async () => {
    const coordinator = createIdempotencyCoordinator(memoryIdempotencyStore())
    const deferred = Promise.withResolvers<string>()
    const pending = coordinator.run("payload", () => deferred.promise, "[1]")
    await expect(coordinator.run("payload", async () => "other", "[2]")).rejects.toBeInstanceOf(IdempotencyConflictError)
    deferred.resolve("done")
    await expect(pending).resolves.toBe("done")
  })

  test("validates raw keys and separates cache entries by authenticated principal", async () => {
    expect(parseIdempotencyKey("k".repeat(256))).toHaveLength(256)
    expect(() => parseIdempotencyKey("k".repeat(257))).toThrow("at most 256 characters")
    expect(() => parseIdempotencyKey(" ".repeat(257))).toThrow("at most 256 characters")

    const coordinator = createIdempotencyCoordinator(memoryIdempotencyStore())
    const run = vi.fn(async () => "done")
    const key = (principal: string) => idempotencyCacheKey({
      operation: "register",
      principal,
      workspaceId: "ws_1",
      sessionId: "session_1",
      key: "request_1",
    })
    await coordinator.run(key("signed:issuer|user_1"), run)
    await coordinator.run(key("signed:issuer|user_1"), run)
    await coordinator.run(key("signed:issuer|user_2"), run)
    expect(run).toHaveBeenCalledTimes(2)
  })
})
