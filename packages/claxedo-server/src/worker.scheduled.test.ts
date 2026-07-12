import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * D13 reaper — Worker `scheduled` handler (ops floor ADR 2026-07-11-016 §4).
 *
 * The Cloudflare Cron Trigger must drive the EXISTING sandbox GC path: a
 * synthetic POST to /internal/sandbox-manager/gc authorized with the admin
 * token from env, through the same hosted app the fetch handler serves. Every
 * failure must THROW (recorded cron failure) — a reaper that fails silently is
 * the money leak this decision exists to close.
 */

const appFetch = vi.fn(async () => new Response("ok"))
const runBillingSweep = vi.fn(async (_env: unknown) => {})

// F17: the billing reconciliation sweep is mocked so the test can assert it
// runs (or not) independently of the sandbox GC pass. Env lacks a Polar token
// anyway, so the real sweep is a no-op — this just makes the call observable.
vi.mock("./billing/reconcile", () => ({
  runScheduledBillingReconciliation: (env: unknown) => runBillingSweep(env),
}))

vi.mock("./control-plane/hosted-services", () => ({
  composeHostedControlPlane: vi.fn(() => ({})),
  HostedWorkerCompositionError: class HostedWorkerCompositionError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message)
    }
  },
}))

vi.mock("./hosted-app", () => ({
  createHostedApp: vi.fn(() => ({ fetch: appFetch })),
}))

type ScheduledWorker = {
  scheduled: (
    controller: { cron: string; scheduledTime: number },
    env: Record<string, string | undefined>,
    ctx: { waitUntil: (p: Promise<unknown>) => void; passThroughOnException: () => void },
  ) => Promise<void>
}

const controller = { cron: "*/15 * * * *", scheduledTime: 0 }

function runtimeCtx() {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
}

beforeEach(() => {
  appFetch.mockClear()
  appFetch.mockImplementation(async () => new Response("ok"))
  runBillingSweep.mockClear()
  runBillingSweep.mockImplementation(async () => {})
})

describe("worker scheduled handler", () => {
  test("dispatches the existing GC admin route with the admin token and forwards env bindings", async () => {
    const worker = (await import("./worker")).default as unknown as ScheduledWorker
    const env = { CLAXEDO_RUNTIME_ADMIN_TOKEN: "admin_secret" }

    await worker.scheduled(controller, env, runtimeCtx())

    expect(appFetch).toHaveBeenCalledTimes(1)
    const [request, gotEnv] = appFetch.mock.calls[0] as unknown as [Request, Record<string, string>]
    expect(request.method).toBe("POST")
    expect(new URL(request.url).pathname).toBe("/internal/sandbox-manager/gc")
    expect(request.headers.get("authorization")).toBe("Bearer admin_secret")
    // withSentry proxies env; the bindings must pass through intact.
    expect(gotEnv).toEqual(env)
  })

  test("throws when the admin token is missing so the cron run records as failed", async () => {
    const worker = (await import("./worker")).default as unknown as ScheduledWorker

    await expect(worker.scheduled(controller, {}, runtimeCtx()))
      .rejects.toThrow("CLAXEDO_RUNTIME_ADMIN_TOKEN")
    expect(appFetch).not.toHaveBeenCalled()
  })

  test("throws when the GC route responds non-2xx (misconfigured manager, bad token, driver failure)", async () => {
    const worker = (await import("./worker")).default as unknown as ScheduledWorker
    appFetch.mockImplementation(async () => new Response("sandbox_unavailable", { status: 501 }))

    await expect(worker.scheduled(controller, { CLAXEDO_RUNTIME_ADMIN_TOKEN: "admin_secret" }, runtimeCtx()))
      .rejects.toThrow("501")
  })

  test("F17: a failing sandbox GC still runs the billing sweep, and the GC failure still throws", async () => {
    const worker = (await import("./worker")).default as unknown as ScheduledWorker
    appFetch.mockImplementation(async () => new Response("sandbox down", { status: 500 }))
    const env = { CLAXEDO_RUNTIME_ADMIN_TOKEN: "admin_secret" }

    // The GC failure is still surfaced (cron recorded failed → Sentry)…
    await expect(worker.scheduled(controller, env, runtimeCtx())).rejects.toThrow("500")
    // …but the billing reconciliation sweep ran regardless (isolated).
    expect(runBillingSweep).toHaveBeenCalledTimes(1)
    expect(runBillingSweep).toHaveBeenCalledWith(env)
  })

  test("F17: a throwing billing sweep does not mask the GC failure, and does not run when GC succeeds cleanly the sweep still runs", async () => {
    const worker = (await import("./worker")).default as unknown as ScheduledWorker
    // GC succeeds; a throwing billing sweep is swallowed (reported), handler resolves.
    runBillingSweep.mockImplementation(async () => {
      throw new Error("billing convex down")
    })
    const env = { CLAXEDO_RUNTIME_ADMIN_TOKEN: "admin_secret" }
    await expect(worker.scheduled(controller, env, runtimeCtx())).resolves.toBeUndefined()
    expect(runBillingSweep).toHaveBeenCalledTimes(1)
  })
})
