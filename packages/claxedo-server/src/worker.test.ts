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
const settlerFetch = vi.fn(async () => new Response(null, { status: 204 }))
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

vi.mock("./workgraph-host/hosted-runtime", () => ({
  createHostedWorkGraphRuntime: vi.fn(() => ({ reconcile })),
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
})
