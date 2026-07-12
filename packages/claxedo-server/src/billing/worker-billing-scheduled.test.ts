import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * Worker `scheduled` handler × billing reconciliation wiring: the Cloudflare
 * Cron Trigger that drives the D13 sandbox GC also drives the D5 billing
 * sweep. Contract: the sweep runs AFTER a successful GC with the Worker env,
 * and — being throw-free by design — can never fail the cron run itself
 * (that is reconcile.ts's own contract, tested in reconcile.test.ts).
 */

const appFetch = vi.fn(async () => new Response("ok"))
const runScheduledBillingReconciliation = vi.fn(async () => undefined)

vi.mock("../control-plane/hosted-services", () => ({
  composeHostedControlPlane: vi.fn(() => ({})),
  HostedWorkerCompositionError: class HostedWorkerCompositionError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message)
    }
  },
}))

vi.mock("../hosted-app", () => ({
  createHostedApp: vi.fn(() => ({ fetch: appFetch })),
}))

vi.mock("./reconcile", () => ({
  runScheduledBillingReconciliation: (env: unknown) => runScheduledBillingReconciliation(env as never),
}))

type ScheduledWorker = {
  scheduled: (
    controller: { cron: string; scheduledTime: number },
    env: Record<string, string | undefined>,
    ctx: { waitUntil: (p: Promise<unknown>) => void; passThroughOnException: () => void },
  ) => Promise<void>
}

const controller = { cron: "*/15 * * * *", scheduledTime: 0 }
const runtimeCtx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() })

beforeEach(() => {
  appFetch.mockClear()
  appFetch.mockImplementation(async () => new Response("ok"))
  runScheduledBillingReconciliation.mockClear()
})

describe("worker scheduled billing sweep", () => {
  test("runs the billing reconciliation with the Worker env after the GC dispatch", async () => {
    const worker = (await import("../worker")).default as unknown as ScheduledWorker
    const env = { CLAXEDO_RUNTIME_ADMIN_TOKEN: "admin_secret", CLAXEDO_POLAR_ACCESS_TOKEN: "polar_tok" }

    await worker.scheduled(controller, env, runtimeCtx())

    expect(appFetch).toHaveBeenCalledTimes(1)
    expect(runScheduledBillingReconciliation).toHaveBeenCalledTimes(1)
    expect(runScheduledBillingReconciliation).toHaveBeenCalledWith(env)
  })

  test("a failed GC still records the cron failure; the billing sweep waits for the next run", async () => {
    const worker = (await import("../worker")).default as unknown as ScheduledWorker
    appFetch.mockImplementation(async () => new Response("nope", { status: 501 }))

    await expect(
      worker.scheduled(controller, { CLAXEDO_RUNTIME_ADMIN_TOKEN: "admin_secret" }, runtimeCtx()),
    ).rejects.toThrow("501")
    // The Convex-side flag persists, so skipping this run loses nothing.
    expect(runScheduledBillingReconciliation).not.toHaveBeenCalled()
  })
})
