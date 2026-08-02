import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * D13 reaper — Worker `scheduled` handler.
 *
 * The Cloudflare Cron Trigger must drive the EXISTING sandbox GC path: a
 * synthetic POST to /internal/sandbox-manager/gc authorized with the admin
 * token from env, through the same hosted app the fetch handler serves. Every
 * failure must THROW (recorded cron failure) — a reaper that fails silently is
 * the money leak this decision exists to close.
 *
 * A cron has no request and no route handler, so the throw is also the only
 * thing error tracking can hang an issue on: the final describe holds that a
 * failed run produces exactly one `$exception`, and none at all without a key.
 */

const appFetch = vi.fn(async () => new Response("ok"))
const runBillingSweep = vi.fn(async (_env: unknown) => {})

// F17: the billing reconciliation sweep is mocked so the test can assert it
// runs (or not) independently of the sandbox GC pass. Env lacks a Polar token
// anyway, so the real sweep is a no-op — this just makes the call observable.
vi.mock("../../billing/reconcile", () => ({
  runScheduledBillingReconciliation: (env: unknown) => runBillingSweep(env),
}))

vi.mock("../../control-plane/hosted-services", () => ({
  composeHostedControlPlane: vi.fn(() => ({})),
  HostedWorkerCompositionError: class HostedWorkerCompositionError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message)
    }
  },
}))

vi.mock("../hosted-shared/hosted-app", () => ({
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

    // The GC failure is still surfaced (cron recorded failed → one issue)…
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

describe("worker scheduled error reporting", () => {
  async function freshWorker() {
    // The seam sink is registered once per module instance from the first
    // invocation's env, so each key posture needs its own module graph.
    vi.resetModules()
    return (await import("./worker")).default as unknown as ScheduledWorker
  }

  function captureCalls(spy: ReturnType<typeof vi.fn>) {
    return spy.mock.calls.filter(([url]) => String(url).endsWith("/capture/"))
  }

  test("a failing cron POSTs exactly one $exception when a key is configured", async () => {
    const fetchSpy = vi.fn(async () => new Response("ok"))
    vi.stubGlobal("fetch", fetchSpy)
    appFetch.mockImplementation(async () => new Response("sandbox down", { status: 500 }))
    const worker = await freshWorker()
    const work: Promise<unknown>[] = []
    const ctx = { waitUntil: vi.fn((p: Promise<unknown>) => work.push(p)), passThroughOnException: vi.fn() }

    await expect(
      worker.scheduled(
        controller,
        // Sending takes both opt-ins (W3): the mode plus the key.
        { CLAXEDO_RUNTIME_ADMIN_TOKEN: "admin_secret", CLAXEDO_TELEMETRY_MODE: "on", CLAXEDO_POSTHOG_KEY: "phc_worker" },
        ctx,
      ),
    ).rejects.toThrow("500")
    await Promise.all(work)

    const calls = captureCalls(fetchSpy)
    expect(calls).toHaveLength(1)
    const body = JSON.parse((calls[0]![1] as RequestInit).body as string)
    expect(body.event).toBe("$exception")
    expect(body.distinct_id).toBe("system")
    expect(body.properties.unit).toBe("worker")
    expect(body.properties.source).toBe("worker_scheduled")
    expect(body.properties.reason).toBe("cron_failed")
    expect(body.properties.cron).toBe("*/15 * * * *")
    expect(body.properties.$exception_list[0].value).toContain("500")

    vi.unstubAllGlobals()
  })

  test("with no key configured the same failing cron makes ZERO network calls", async () => {
    const fetchSpy = vi.fn(async () => new Response("ok"))
    vi.stubGlobal("fetch", fetchSpy)
    appFetch.mockImplementation(async () => new Response("sandbox down", { status: 500 }))
    const worker = await freshWorker()
    const work: Promise<unknown>[] = []
    const ctx = { waitUntil: vi.fn((p: Promise<unknown>) => work.push(p)), passThroughOnException: vi.fn() }

    await expect(
      worker.scheduled(controller, { CLAXEDO_RUNTIME_ADMIN_TOKEN: "admin_secret" }, ctx),
    ).rejects.toThrow("500")
    await Promise.all(work)

    expect(fetchSpy).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
  })
})
