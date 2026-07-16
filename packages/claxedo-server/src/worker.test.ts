import { describe, expect, test, vi } from "vitest"

/**
 * Worker entrypoint behavior: the ExecutionContext must be passed through to
 * the Hono app (`app.fetch(request, env, ctx)`), otherwise `waitUntil`-backed
 * background work (telemetry, lifecycle touch) is cancelled after the response.
 *
 * D12: the entrypoint is wrapped with @sentry/cloudflare's `withSentry`,
 * which proxies the ExecutionContext to instrument `waitUntil`. The contract
 * under test is therefore behavioral — `waitUntil` calls made on the ctx the
 * app receives must reach the runtime's real ctx — not object identity.
 */

const appFetch = vi.fn(async () => new Response("ok"))
const reconcile = vi.fn(async () => ({ launched: [], results: [], background: {} }))
const runBillingSweep = vi.fn(async (_env: unknown) => {})
const listStaleTenants = vi.fn(async () => [
  { organizationId: "org-a", ownerUserId: "user-a" },
  { organizationId: "org-b", ownerUserId: "user-b" },
])
const settlerFetch = vi.fn(async (_request: Request) => new Response(null, { status: 204 }))
const settlerNamespace = {
  idFromName: vi.fn((name: string) => name),
  get: vi.fn(() => ({ fetch: settlerFetch })),
}
const createHostedApp = vi.fn((
  _plane: unknown,
  _options?: {
    workGraphReconcile?: () => Promise<unknown>
    workGraphSettlementDispatcher?: (
      waitUntil: (promise: Promise<unknown>) => void,
    ) => { nudge(tenant: { organizationId: string; ownerUserId: string }): void }
  },
) => ({ fetch: appFetch }))

vi.mock("./control-plane/hosted-services", () => ({
  composeHostedControlPlane: vi.fn(() => ({})),
  HostedWorkerCompositionError: class HostedWorkerCompositionError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message)
    }
  },
}))

vi.mock("./hosted-app", () => ({
  createHostedApp,
}))

vi.mock("./billing/reconcile", () => ({
  runScheduledBillingReconciliation: runBillingSweep,
}))

vi.mock("./workgraph-host/hosted-runtime", () => ({
  createHostedWorkGraphRuntime: vi.fn(() => ({ listStaleTenants, reconcile })),
}))

describe("worker entrypoint", () => {
  test("forwards the request, env bindings, and ExecutionContext into the app", async () => {
    const worker = (await import("./worker")).default
    const request = new Request("http://cp.test/api/claxedo/health")
    const env = {
      CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
      WORKGRAPH_SETTLER: settlerNamespace,
    }
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() }

    const res = await worker.fetch(request, env, ctx as never)
    expect(await res.text()).toBe("ok")
    expect(appFetch).toHaveBeenCalledTimes(1)
    const [gotRequest, gotEnv, gotCtx] = appFetch.mock.calls[0] as unknown as [
      Request,
      Record<string, string>,
      { waitUntil: (p: Promise<unknown>) => void },
    ]
    expect(gotRequest).toBe(request)
    // withSentry proxies env as well; the bindings must pass through intact.
    expect(gotEnv).toEqual(env)
    // withSentry proxies ctx (and wraps the tracked promise; the SDK itself
    // may also register waitUntil work): assert a waitUntil call on the ctx
    // the app received reaches the runtime's ctx.
    const callsBefore = ctx.waitUntil.mock.calls.length
    gotCtx.waitUntil(Promise.resolve())
    expect(ctx.waitUntil.mock.calls.length).toBe(callsBefore + 1)
  })

  test("binds settlement nudges to the current request waitUntil", async () => {
    const options = createHostedApp.mock.calls.at(-1)?.[1]
    const work: Promise<unknown>[] = []
    const dispatcher = options?.workGraphSettlementDispatcher?.((promise) => work.push(promise))

    dispatcher?.nudge({ organizationId: "org-a", ownerUserId: "user-a" })

    expect(work).toHaveLength(1)
    await Promise.all(work)
    expect(settlerNamespace.idFromName).toHaveBeenCalledWith(JSON.stringify(["org-a", "user-a"]))
    expect(settlerFetch).toHaveBeenCalledTimes(1)
    const request = settlerFetch.mock.calls[0]?.[0] as unknown as Request
    expect(request.method).toBe("POST")
    expect(new URL(request.url).pathname).toBe("/nudge")
    await expect(request.json()).resolves.toEqual({ organizationId: "org-a", ownerUserId: "user-a" })
  })

  test("runs manual reconciliation with background control effects enabled", async () => {
    const worker = (await import("./worker")).default
    await worker.fetch(
      new Request("http://cp.test/api/claxedo/health"),
      { CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test" },
    )
    const options = createHostedApp.mock.calls.at(-1)?.[1] as
      | { workGraphReconcile?: () => Promise<unknown> }
      | undefined

    await options?.workGraphReconcile?.()

    expect(reconcile).toHaveBeenCalledWith()
  })

  test("nudges each stale tenant from the runtime without running the global reconcile on the minute lane", async () => {
    const worker = (await import("./worker")).default
    const work: Promise<unknown>[] = []
    const ctx = {
      waitUntil: vi.fn((promise: Promise<unknown>) => work.push(promise)),
      passThroughOnException: vi.fn(),
    }
    const env = {
      CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
      WORKGRAPH_SETTLER: settlerNamespace,
    }
    appFetch.mockClear()
    listStaleTenants.mockClear()
    reconcile.mockClear()
    runBillingSweep.mockClear()
    settlerNamespace.idFromName.mockClear()
    settlerFetch.mockClear()

    await worker.scheduled({ cron: "* * * * *", scheduledTime: 123_456 }, env, ctx as never)
    await Promise.all(work)

    expect(listStaleTenants).toHaveBeenCalledTimes(1)
    expect(listStaleTenants).toHaveBeenCalledWith()
    expect(settlerNamespace.idFromName.mock.calls.map(([name]) => name)).toEqual([
      JSON.stringify(["org-a", "user-a"]),
      JSON.stringify(["org-b", "user-b"]),
    ])
    expect(settlerFetch).toHaveBeenCalledTimes(2)
    await expect(Promise.all(settlerFetch.mock.calls.map(([request]) => request.json()))).resolves.toEqual([
      { organizationId: "org-a", ownerUserId: "user-a" },
      { organizationId: "org-b", ownerUserId: "user-b" },
    ])
    expect(reconcile).not.toHaveBeenCalled()
    expect(appFetch).not.toHaveBeenCalled()
    expect(runBillingSweep).not.toHaveBeenCalled()
  })

  test("keeps the full global reconcile on the 15-minute lane", async () => {
    const worker = (await import("./worker")).default
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
    const env = {
      CLAXEDO_RUNTIME_ADMIN_TOKEN: "admin-secret",
      WORKGRAPH_SETTLER: settlerNamespace,
    }
    appFetch.mockClear()
    listStaleTenants.mockClear()
    reconcile.mockClear()
    runBillingSweep.mockClear()

    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: 123_456 }, env, ctx as never)

    expect(appFetch).toHaveBeenCalledTimes(1)
    expect(runBillingSweep).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenCalledWith()
    expect(listStaleTenants).not.toHaveBeenCalled()
  })

  test("fails the minute backstop loudly when stale work cannot be dispatched", async () => {
    const worker = (await import("./worker")).default
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
    const minute = { cron: "* * * * *", scheduledTime: 123_456 }
    reconcile.mockClear()
    listStaleTenants.mockClear()

    await expect(worker.scheduled(minute, {}, ctx as never)).rejects.toThrow("WORKGRAPH_SETTLER")

    expect(listStaleTenants).toHaveBeenCalledTimes(1)
    expect(reconcile).not.toHaveBeenCalled()
  })
})
