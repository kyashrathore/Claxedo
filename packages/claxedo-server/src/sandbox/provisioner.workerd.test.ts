import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import { applyControlPlaneBaseline } from "../test-support/control-plane-migrations"
import { hostedWorkerCompatibility, wranglerBundle } from "../test-support/hosted-worker-bundle"
import type { SandboxStartAnswer } from "../workspace/sandbox-start"
import { FIXTURE_OUTCOME_HELD_MS } from "./fixtures/provisioner-outcome-held"

const FIXTURE_WORKER = fileURLToPath(new URL("./fixtures/provisioner-worker.fixture.ts", import.meta.url))
const ORIGIN = "https://api.test"

let miniflare: Miniflare

beforeAll(async () => {
  miniflare = new Miniflare({
    ...hostedWorkerCompatibility(),
    modules: [{ type: "ESModule", path: "worker.js", contents: wranglerBundle(FIXTURE_WORKER) }],
    d1Databases: ["CONTROL_PLANE_DB"],
    durableObjects: { SANDBOX_PROVISIONER: { className: "SandboxProvisioner", useSQLite: true } },
  })
  await applyControlPlaneBaseline((await miniflare.getD1Database("CONTROL_PLANE_DB")) as unknown as D1Database)
}, 180_000)

afterAll(async () => {
  await miniflare?.dispose()
})

async function start(workspaceId: string, request: { retry?: true } = {}): Promise<SandboxStartAnswer> {
  const response = await miniflare.dispatchFetch(`${ORIGIN}/start?ws=${workspaceId}${request.retry ? "&retry=1" : ""}`, { method: "POST" })
  expect(response.status).toBe(200)
  return (await response.json()) as SandboxStartAnswer
}

async function refresh(workspaceId: string): Promise<SandboxStartAnswer> {
  const response = await miniflare.dispatchFetch(`${ORIGIN}/refresh?ws=${workspaceId}`, { method: "POST" })
  expect(response.status).toBe(200)
  return (await response.json()) as SandboxStartAnswer
}

async function inFlight(workspaceId: string): Promise<SandboxStartAnswer | null> {
  return (await (await miniflare.dispatchFetch(`${ORIGIN}/in-flight?ws=${workspaceId}`)).json()) as SandboxStartAnswer | null
}

async function target(workspaceId: string) {
  return (await (await miniflare.dispatchFetch(`${ORIGIN}/target?ws=${workspaceId}`)).json()) as Record<string, unknown>
}

async function driverCalls(workspaceId: string) {
  return ((await (await miniflare.dispatchFetch(`${ORIGIN}/driver-calls?ws=${workspaceId}`)).json()) as { calls: number }).calls
}

async function redeliver(workspaceId: string) {
  expect((await miniflare.dispatchFetch(`${ORIGIN}/redeliver?ws=${workspaceId}`, { method: "POST" })).status).toBe(200)
}

async function fixKey(workspaceId: string) {
  return ((await (await miniflare.dispatchFetch(`${ORIGIN}/fix-key?ws=${workspaceId}`, { method: "POST" })).json()) as { lifted: boolean }).lifted
}

async function renewals(workspaceId: string) {
  return ((await (await miniflare.dispatchFetch(`${ORIGIN}/renewals?ws=${workspaceId}`)).json()) as { renewals: number }).renewals
}

/** The failures the provisioner counted before each idle read of the workspace, in order. */
async function watches(workspaceId: string) {
  return ((await (await miniflare.dispatchFetch(`${ORIGIN}/watches?ws=${workspaceId}`)).json()) as { watches: number[] }).watches
}

/** The steps the workspace owner's clients were told of, in order. */
async function notices(workspaceId: string) {
  return ((await (await miniflare.dispatchFetch(`${ORIGIN}/notices?ws=${workspaceId}`)).json()) as { notices: string[] }).notices
}

/** Polls `read` until `settled` admits its answer, within 10 s. */
async function until<T>(read: () => Promise<T>, settled: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const value = await read()
    if (settled(value)) return value
    if (Date.now() >= deadline) throw new Error(`still not settled: ${JSON.stringify(value)}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

describe("a sandbox start on workerd", () => {
  test("answers before the driver finishes, and the lease ends ready with no request open", async () => {
    const begun = Date.now()
    const answer = await start("ws_slow_1500")
    expect(Date.now() - begun).toBeLessThan(1_500)
    expect(answer).toMatchObject({ status: "provisioning", epoch: 1 })
    expect(await target("ws_slow_1500")).toMatchObject({ status: "unavailable", leaseStatus: "acquiring" })

    expect(await until(() => target("ws_slow_1500"), (lease) => lease.status === "ready")).toMatchObject({
      status: "ready",
      epoch: 1,
      sandboxId: "sandbox_ws_slow_1500",
      hostId: "host_ws_slow_1500",
    })
    expect(await driverCalls("ws_slow_1500")).toBe(1)
  })

  test("every start on a lease whose runtime answers reports the ready target, with no driver step", async () => {
    await start("ws_slow_1")
    await until(() => target("ws_slow_1"), (lease) => lease.status === "ready")

    expect(await until(() => start("ws_slow_1"), (answer) => answer.status === "ready")).toMatchObject({ status: "ready", epoch: 1 })
    expect(await start("ws_slow_1")).toMatchObject({ status: "ready", epoch: 1 })
    expect(await start("ws_slow_1")).toMatchObject({ status: "ready", epoch: 1 })
    expect(await driverCalls("ws_slow_1")).toBe(1)
  })

  test("a start on a ready lease whose runtime does not answer resumes it on the same epoch, a held ready outcome notwithstanding", async () => {
    await start("ws_slow_1_asleep")
    await until(() => target("ws_slow_1_asleep"), (lease) => lease.status === "ready")

    const resumed = await start("ws_slow_1_asleep")
    expect(resumed).toMatchObject({ status: "provisioning", epoch: 1, bootMode: "resume" })
    expect(resumed).not.toHaveProperty("opened")
    expect(await until(() => start("ws_slow_1_asleep"), (answer) => answer.status === "ready")).toMatchObject({ status: "ready", epoch: 1 })
    expect(await driverCalls("ws_slow_1_asleep")).toBe(2)
  })

  test("a read sees the run in flight while it runs, and nothing once the lease settled", async () => {
    expect(await inFlight("ws_slow_1500_read")).toBeNull()
    expect(await start("ws_slow_1500_read")).toMatchObject({ status: "provisioning", epoch: 1 })
    expect(await inFlight("ws_slow_1500_read")).toMatchObject({ status: "provisioning", epoch: 1 })

    await until(() => target("ws_slow_1500_read"), (lease) => lease.status === "ready")
    expect(await until(() => inFlight("ws_slow_1500_read"), (answer) => answer === null)).toBeNull()
    expect(await driverCalls("ws_slow_1500_read")).toBe(1)
  })

  test("concurrent polls share one run, and both read it ready once it settles", async () => {
    const [first, second] = await Promise.all([start("ws_slow_300_pair"), start("ws_slow_300_pair")])
    expect(first).toMatchObject({ status: "provisioning", epoch: 1 })
    expect(second).toMatchObject({ status: "provisioning", epoch: 1 })

    await until(() => target("ws_slow_300_pair"), (lease) => lease.status === "ready")
    const settled = await until(() => Promise.all([start("ws_slow_300_pair"), start("ws_slow_300_pair")]), (answers) => answers.every((answer) => answer.status === "ready"))
    expect(settled).toHaveLength(2)
    expect(await driverCalls("ws_slow_300_pair")).toBe(1)
  })

  test("a refresh runs the driver for a live sandbox again, and a start meanwhile joins that run", async () => {
    await start("ws_slow_300_refreshed")
    await until(() => start("ws_slow_300_refreshed"), (answer) => answer.status === "ready")

    expect(await refresh("ws_slow_300_refreshed")).toMatchObject({ status: "provisioning", epoch: 1 })
    expect(await start("ws_slow_300_refreshed")).toMatchObject({ status: "provisioning", epoch: 1 })
    expect(await until(() => start("ws_slow_300_refreshed"), (answer) => answer.status === "ready")).toMatchObject({ status: "ready", epoch: 1 })
    expect(await driverCalls("ws_slow_300_refreshed")).toBe(2)
  })

  test("an outcome nobody collected while it was held is not the answer to a later start, which begins its own run", async () => {
    await start("ws_slow_1_left_asleep")
    await until(() => target("ws_slow_1_left_asleep"), (lease) => lease.status === "ready")
    await new Promise((resolve) => setTimeout(resolve, FIXTURE_OUTCOME_HELD_MS + 200))

    const later = await start("ws_slow_1_left_asleep")
    expect(later).toMatchObject({ status: "provisioning", epoch: 1 })
    expect(later).not.toHaveProperty("opened")
    expect(await until(() => start("ws_slow_1_left_asleep"), (answer) => answer.status === "ready")).toMatchObject({ status: "ready", epoch: 1 })
    expect(await driverCalls("ws_slow_1_left_asleep")).toBe(2)
  })

  test("a step that throws after the lease went ready ends the run with that error, and a person's retry runs its own", async () => {
    expect(await start("ws_step_throws")).toMatchObject({ status: "provisioning", epoch: 1 })
    const thrown = await until(() => start("ws_step_throws"), (answer) => answer.status !== "provisioning")
    expect(thrown).toMatchObject({ status: "unavailable", error: "runtime_provision_failed: the runtime refused its settings", epoch: 1 })
    expect(await target("ws_step_throws")).toMatchObject({ status: "ready", epoch: 1 })

    expect(await start("ws_step_throws", { retry: true })).toMatchObject({ status: "provisioning", epoch: 1 })
    expect(await until(() => start("ws_step_throws"), (answer) => answer.status !== "provisioning")).toMatchObject({ status: "ready", epoch: 1 })
    expect(await driverCalls("ws_step_throws")).toBe(2)
  })

  test("a ready sandbox whose delivered placeholders expire is delivered them again from the alarm, with no driver step, until it stops serving", async () => {
    await start("ws_renew_2")
    await until(() => target("ws_renew_2"), (lease) => lease.status === "ready")
    expect(await until(() => renewals("ws_renew_2"), (count) => count >= 2)).toBe(2)
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(await renewals("ws_renew_2")).toBe(2)
    expect(await driverCalls("ws_renew_2")).toBe(1)
    expect(await start("ws_renew_2")).toMatchObject({ status: "ready", epoch: 1 })
  })

  test("a redelivery pushes a serving sandbox's settings at once, with no driver step and no run a read would see", async () => {
    await start("ws_renew_1")
    await until(() => target("ws_renew_1"), (lease) => lease.status === "ready")
    expect(await until(() => renewals("ws_renew_1"), (count) => count >= 1)).toBe(1)

    await redeliver("ws_renew_1")
    expect(await renewals("ws_renew_1")).toBe(2)
    expect(await inFlight("ws_renew_1")).toBeNull()
    expect(await driverCalls("ws_renew_1")).toBe(1)
    expect(await start("ws_renew_1")).toMatchObject({ status: "ready", epoch: 1 })
  })

  test("a ready sandbox whose host reads no idleness has it read from the alarm until a read stops it, and the next start resumes it", async () => {
    await start("ws_watch_3")
    await until(() => target("ws_watch_3"), (lease) => lease.status === "ready")
    expect(await until(() => target("ws_watch_3"), (lease) => lease.status === "unavailable" && lease.leaseStatus === "stopped")).toMatchObject({ leaseStatus: "stopped" })
    expect(await watches("ws_watch_3")).toEqual([0, 0, 0])
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(await watches("ws_watch_3")).toHaveLength(3)
    expect(await driverCalls("ws_watch_3")).toBe(1)
    expect(await until(() => start("ws_watch_3"), (answer) => answer.status === "ready")).toMatchObject({ status: "ready", epoch: 2 })
    expect(await driverCalls("ws_watch_3")).toBe(2)
  })

  test("an idle read that throws is counted and tried again, and the count reaches the read that stops the sandbox as unreachable", async () => {
    await start("ws_watchfail_2")
    expect(await until(() => target("ws_watchfail_2"), (lease) => lease.status === "unavailable" && lease.leaseStatus === "stopped")).toMatchObject({ leaseStatus: "stopped" })
    expect(await watches("ws_watchfail_2")).toEqual([0, 1, 2])
  })

  test("polls a driver that asks to be polled, from the alarm, until it is ready", async () => {
    expect(await start("ws_poll_2")).toMatchObject({ status: "provisioning", epoch: 1 })
    await until(() => target("ws_poll_2"), (lease) => lease.status === "ready")
    expect(await driverCalls("ws_poll_2")).toBe(3)
  })

  test("a runtime whose boot failed ends the start failed with the boot's reason, and is not retried", async () => {
    expect(await start("ws_boot_fail")).toMatchObject({ status: "provisioning", epoch: 1 })
    const failed = await until(() => start("ws_boot_fail"), (answer) => answer.status !== "provisioning")
    expect(failed).toMatchObject({ status: "unavailable", error: "runtime_boot_failed: the image has no runtime", epoch: 1 })
    expect(await target("ws_boot_fail")).toMatchObject({
      status: "unavailable",
      failure: { kind: "boot", message: "the image has no runtime", retrying: false },
    })
    expect(await driverCalls("ws_boot_fail")).toBe(1)
  })

  test("a lease stopped while its run was inside the driver is nobody's failure: the next start begins the run the lease needs, at once", async () => {
    expect(await start("ws_stopped_under")).toMatchObject({ status: "provisioning", epoch: 1 })
    expect(await until(() => inFlight("ws_stopped_under"), (answer) => answer === null)).toBeNull()
    expect(await target("ws_stopped_under")).toMatchObject({ status: "unavailable", leaseStatus: "stopped" })

    const next = await start("ws_stopped_under")
    expect(next).toMatchObject({ status: "provisioning", epoch: 2 })
    expect(next).not.toHaveProperty("opened")
    expect(await until(() => start("ws_stopped_under"), (answer) => answer.status === "ready")).toMatchObject({ status: "ready", epoch: 2 })
    expect(await driverCalls("ws_stopped_under")).toBe(2)
  })

  test("a provider failure is retried from the alarm after the lease's own delay, on a fresh epoch the run follows", async () => {
    expect(await start("ws_flaky")).toMatchObject({ status: "provisioning", epoch: 1 })
    expect(await until(() => target("ws_flaky"), (lease) => lease.status === "ready")).toMatchObject({ status: "ready", epoch: 2 })
    expect(await driverCalls("ws_flaky")).toBe(2)
    expect(await until(() => start("ws_flaky"), (answer) => answer.status === "ready")).toMatchObject({ status: "ready", epoch: 2 })
  })

  test("a start that spends its retry budget ends with the provider's refusal, every start in the cooldown is told it with less time left, and a fixed key starts the next at once", async () => {
    const reason = "provider_key_refused:scripted: the key was rejected (unauthorized)"
    expect(await start("ws_key_refused")).toMatchObject({ status: "provisioning", epoch: 1 })
    const exhausted = await until(() => start("ws_key_refused"), (answer) => answer.status !== "provisioning")
    expect(exhausted).toMatchObject({ status: "unavailable", exhausted: true, error: reason, epoch: 4 })
    expect(await inFlight("ws_key_refused")).toBeNull()
    expect(await driverCalls("ws_key_refused")).toBe(4)
    const first = (exhausted as { retryAfterMs: number }).retryAfterMs
    expect(first).toBeGreaterThan(50_000)
    expect(first).toBeLessThanOrEqual(60_000)

    await new Promise((resolve) => setTimeout(resolve, 50))
    const later = await start("ws_key_refused")
    expect(later).toMatchObject({ status: "unavailable", exhausted: true, error: reason })
    expect((later as { retryAfterMs: number }).retryAfterMs).toBeLessThan(first)
    expect(await driverCalls("ws_key_refused")).toBe(4)

    expect(await fixKey("ws_key_refused")).toBe(true)
    expect(await start("ws_key_refused")).toMatchObject({ status: "provisioning", epoch: 5 })
    expect(await until(() => start("ws_key_refused"), (answer) => answer.status === "ready")).toMatchObject({ status: "ready", epoch: 5 })
    expect(await driverCalls("ws_key_refused")).toBe(5)
  })

  test("a start refused at the provider's daily start limit ends at once, every connect after it is told why with no retry, and only a person's retry runs the driver again", async () => {
    expect(await start("ws_day_limited_1")).toMatchObject({ status: "provisioning", epoch: 1 })
    const ended = await until(() => start("ws_day_limited_1"), (answer) => answer.status !== "provisioning")
    expect(ended).toMatchObject({ status: "unavailable", exhausted: true, error: expect.stringContaining("daily start limit (200) is used up; try again later.") })
    expect(ended).not.toHaveProperty("retryAfterMs")
    expect(await Promise.all([start("ws_day_limited_1"), start("ws_day_limited_1")])).toEqual([ended, ended])
    expect(await inFlight("ws_day_limited_1")).toBeNull()
    expect(await driverCalls("ws_day_limited_1")).toBe(1)
    expect(await start("ws_day_limited_1", { retry: true })).toMatchObject({ status: "provisioning", epoch: 2 })
    expect(await until(() => start("ws_day_limited_1"), (answer) => answer.status === "ready")).toMatchObject({ status: "ready", epoch: 2 })
    expect(await driverCalls("ws_day_limited_1")).toBe(2)
  })

  test("a start refused at the provider's hourly start limit waits out the hour, and every poll that joins it is told the time left", async () => {
    expect(await start("ws_hour_limited")).toMatchObject({ status: "provisioning", epoch: 1 })
    const waiting = await until(() => start("ws_hour_limited"), (answer) => answer.status !== "provisioning" || answer.failure !== undefined)
    expect(waiting).toMatchObject({ status: "provisioning", joined: true, failure: expect.stringContaining("hourly start limit (60) is used up.") })
    const left = (waiting as { retryAfterMs: number }).retryAfterMs
    expect(left).toBeGreaterThan(3_590_000)
    expect(left).toBeLessThanOrEqual(3_600_000)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(((await start("ws_hour_limited")) as { retryAfterMs: number }).retryAfterMs).toBeLessThan(left)
    expect(await driverCalls("ws_hour_limited")).toBe(1)
  })

  test("while a run waits out a failed step's retry, every poll that joins it is told that step's failure, and a step that succeeds clears it", async () => {
    expect(await start("ws_flaky_3")).toMatchObject({ status: "provisioning", epoch: 1 })
    const retrying = await until(() => start("ws_flaky_3"), (answer) => answer.status !== "provisioning" || answer.failure !== undefined)
    expect(retrying).toMatchObject({ status: "provisioning", joined: true, failure: "provider_failed:scripted: provider hiccup" })
    expect(await inFlight("ws_flaky_3")).toMatchObject({ status: "provisioning", failure: "provider_failed:scripted: provider hiccup" })
    expect(await until(() => start("ws_flaky_3"), (answer) => answer.status === "ready")).toMatchObject({ status: "ready", epoch: 4 })
    expect(await inFlight("ws_flaky_3")).toBeNull()
  })
})

describe("the workspace owner's clients on workerd", () => {
  test("are told a start began, and that it is ready once it settles; a poll that joins it or finds it live tells nothing", async () => {
    expect(await start("ws_slow_1000_notice")).toMatchObject({ status: "provisioning", epoch: 1 })
    expect(await until(() => notices("ws_slow_1000_notice"), (steps) => steps.length > 0)).toEqual(["starting"])
    expect(await start("ws_slow_1000_notice")).toMatchObject({ status: "provisioning", joined: true })
    expect(await until(() => notices("ws_slow_1000_notice"), (steps) => steps.length > 1)).toEqual(["starting", "ready"])
    expect(await until(() => start("ws_slow_1000_notice"), (answer) => answer.status === "ready")).toMatchObject({ status: "ready" })
    expect(await notices("ws_slow_1000_notice")).toEqual(["starting", "ready"])
  })

  test("are told a start whose boot failed ended in error", async () => {
    await start("ws_boot_fail_notice")
    expect(await until(() => notices("ws_boot_fail_notice"), (steps) => steps.length > 1)).toEqual(["starting", "error"])
  })

  test("are told a lease stopped under its run is stopped, not failed", async () => {
    await start("ws_stopped_under_notice")
    expect(await until(() => notices("ws_stopped_under_notice"), (steps) => steps.length > 1)).toEqual(["starting", "stopped"])
  })
})
