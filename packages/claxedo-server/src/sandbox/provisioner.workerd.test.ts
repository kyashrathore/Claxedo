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

async function start(workspaceId: string): Promise<SandboxStartAnswer> {
  const response = await miniflare.dispatchFetch(`${ORIGIN}/start?ws=${workspaceId}`, { method: "POST" })
  expect(response.status).toBe(200)
  return (await response.json()) as SandboxStartAnswer
}

async function target(workspaceId: string) {
  return (await (await miniflare.dispatchFetch(`${ORIGIN}/target?ws=${workspaceId}`)).json()) as Record<string, unknown>
}

async function driverCalls(workspaceId: string) {
  return ((await (await miniflare.dispatchFetch(`${ORIGIN}/driver-calls?ws=${workspaceId}`)).json()) as { calls: number }).calls
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

  test("the start after the lease settled reports the ready target once; the next one resumes it on the same epoch", async () => {
    await start("ws_slow_1")
    await until(() => target("ws_slow_1"), (lease) => lease.status === "ready")

    expect(await until(() => start("ws_slow_1"), (answer) => answer.status === "ready")).toMatchObject({ status: "ready", epoch: 1 })

    const resumed = await start("ws_slow_1")
    expect(resumed).toMatchObject({ status: "provisioning", epoch: 1 })
    expect(resumed).not.toHaveProperty("opened")
    expect(await until(() => start("ws_slow_1"), (answer) => answer.status === "ready")).toMatchObject({ status: "ready", epoch: 1 })
    expect(await driverCalls("ws_slow_1")).toBe(2)
  })

  test("an outcome nobody collected while it was held is not the answer to a later start, which begins its own run", async () => {
    await start("ws_slow_1_left")
    await until(() => target("ws_slow_1_left"), (lease) => lease.status === "ready")
    await new Promise((resolve) => setTimeout(resolve, FIXTURE_OUTCOME_HELD_MS + 200))

    const later = await start("ws_slow_1_left")
    expect(later).toMatchObject({ status: "provisioning", epoch: 1 })
    expect(later).not.toHaveProperty("opened")
    expect(await until(() => start("ws_slow_1_left"), (answer) => answer.status === "ready")).toMatchObject({ status: "ready", epoch: 1 })
    expect(await driverCalls("ws_slow_1_left")).toBe(2)
  })

  test("a step that throws after the lease went ready ends the run with that error, and the next start runs its own", async () => {
    expect(await start("ws_step_throws")).toMatchObject({ status: "provisioning", epoch: 1 })
    const thrown = await until(() => start("ws_step_throws"), (answer) => answer.status !== "provisioning")
    expect(thrown).toMatchObject({ status: "unavailable", error: "runtime_provision_failed: the runtime refused its settings", epoch: 1 })
    expect(await target("ws_step_throws")).toMatchObject({ status: "ready", epoch: 1 })

    expect(await start("ws_step_throws")).toMatchObject({ status: "provisioning", epoch: 1 })
    expect(await until(() => start("ws_step_throws"), (answer) => answer.status !== "provisioning")).toMatchObject({ status: "ready", epoch: 1 })
    expect(await driverCalls("ws_step_throws")).toBe(2)
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

  test("a provider failure is retried from the alarm after the lease's own delay", async () => {
    expect(await start("ws_flaky")).toMatchObject({ status: "provisioning", epoch: 1 })
    await until(() => target("ws_flaky"), (lease) => lease.status === "ready")
    expect(await driverCalls("ws_flaky")).toBe(2)
  })
})
