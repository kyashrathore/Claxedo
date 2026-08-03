import { describe, expect, test, vi } from "vitest"
import type { DocumentIndexEntry } from "../../documents/index-store"
import type { ControlPlaneServices } from "../../authority/services"

/**
 * Worker entrypoint behavior: the ExecutionContext must be passed through to
 * the Hono app (`app.fetch(request, env, ctx)`), otherwise `waitUntil`-backed
 * background work (telemetry, lifecycle touch) is cancelled after the response.
 *
 * The handler is exported plainly — no vendor wrapper stands between the
 * runtime and the app — so the request, the env bindings, and the ctx reach the
 * app unchanged. Error reporting is explicit instead (see the final describe:
 * exceptions leave over the same fetch transport as analytics).
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
let workspaceRole: "viewer" | "editor" | "admin" | "owner" = "editor"
const authorizeSessionRead = vi.fn(async () => undefined)
const openWorkspace = vi.fn(async () => ({
  role: workspaceRole,
  workspace: { workspace_id: "local_ws", org_id: "org_1", project_id: "project_1" },
}))
const createHostedApp = vi.fn((
  _plane: unknown,
  _options?: {
    workGraphReconcile?: () => Promise<unknown>
    workGraphSettlementDispatcherForRequest?: (
      waitUntil: (promise: Promise<unknown>) => void,
    ) => { nudge(tenant: { organizationId: string; ownerUserId: string }): void }
    documentsBackend?: unknown
  },
) => ({ fetch: appFetch }))

vi.mock("../../authority/hosted-services", () => ({
  composeHostedControlPlane: vi.fn(() => ({
    services: { authority: { authorizeSessionRead, openWorkspace } },
  })),
  HostedWorkerCompositionError: class HostedWorkerCompositionError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message)
    }
  },
}))

vi.mock("../hosted-shared/hosted-app", () => ({
  createHostedApp,
}))

vi.mock("../../billing/reconcile", () => ({
  runScheduledBillingReconciliation: runBillingSweep,
}))

vi.mock("../../hosts/workgraph/hosted/runtime", () => ({
  createHostedWorkGraphRuntime: vi.fn(() => ({ listStaleTenants, reconcile })),
}))

describe("worker entrypoint", () => {
  test("forwards the request, env bindings, and ExecutionContext into the app", async () => {
    const worker = (await import("./worker")).default
    const request = new Request("http://cp.test/api/claxedo/health")
    const env = {
      CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
      WORKGRAPH_SETTLER: settlerNamespace,
      CLAXEDO_DOCUMENTS: {},
    }
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() }

    const res = await worker.fetch(request, env as never, ctx as never)
    expect(await res.text()).toBe("ok")
    expect(appFetch).toHaveBeenCalledTimes(1)
    const [gotRequest, gotEnv, gotCtx] = appFetch.mock.calls[0] as unknown as [
      Request,
      Record<string, string>,
      { waitUntil: (p: Promise<unknown>) => void },
    ]
    expect(gotRequest).toBe(request)
    expect(gotEnv).toEqual(env)
    expect(createHostedApp.mock.calls[0]?.[1]?.documentsBackend).toBeDefined()
    expect((createHostedApp.mock.calls[0]?.[1]?.documentsBackend as { agentOpen?: unknown }).agentOpen).toBeTypeOf("function")
    // waitUntil calls made on the ctx the app received must reach the runtime's
    // ctx, or background work is cancelled at the response.
    const callsBefore = ctx.waitUntil.mock.calls.length
    gotCtx.waitUntil(Promise.resolve())
    expect(ctx.waitUntil.mock.calls.length).toBe(callsBefore + 1)
  })

  test("binds settlement nudges to the current request waitUntil", async () => {
    const options = createHostedApp.mock.calls.at(-1)?.[1]
    const work: Promise<unknown>[] = []
    const dispatcher = options?.workGraphSettlementDispatcherForRequest?.((promise) => work.push(promise))

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

  test("fails the minute backstop when a Durable Object nudge is rejected", async () => {
    const worker = (await import("./worker")).default
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
    settlerFetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }))

    await expect(
      worker.scheduled(
        { cron: "* * * * *", scheduledTime: 123_456 },
        { WORKGRAPH_SETTLER: settlerNamespace },
        ctx as never,
      ),
    ).rejects.toThrow("503 unavailable")
  })

  test("denies capability renewal when document access is downgraded to viewer", async () => {
    const { createHostedDocumentJobReauthorizer } = await import("./worker")
    const reauthorizeJob = createHostedDocumentJobReauthorizer({
      authority: { authorizeSessionRead, openWorkspace } as unknown as NonNullable<ControlPlaneServices["authority"]>,
    })
    const input = {
      auth: {
        mode: "signed" as const,
        token: "user-bearer",
        user: { subject: "user_1", tokenIdentifier: "token_1", issuer: "https://issuer.test" },
      },
      entry: { org_id: "org_1", project_id: "project_1" } as DocumentIndexEntry,
      sessionId: "session_1",
      cloudWorkspaceId: "cloud_ws",
      localWorkspaceId: "local_ws",
    }

    for (const role of ["editor", "admin", "owner"] as const) {
      workspaceRole = role
      await expect(reauthorizeJob(input)).resolves.toBeUndefined()
    }
    workspaceRole = "viewer"
    await expect(reauthorizeJob(input)).rejects.toThrow("write access")
  })
})

/**
 * Error tracking in the Worker is explicit: no wrapper catches route throws for
 * us, so the entrypoint reports them itself over the same fetch transport
 * analytics uses. `posthog-node` is a forbidden Worker import, which is why
 * these assertions inspect a raw POST body rather than an SDK call.
 *
 * The seam sink is registered once per module instance from the first
 * invocation's env, hence `vi.resetModules()` before each case.
 */
describe("worker error reporting", () => {
  async function freshWorker() {
    vi.resetModules()
    return (await import("./worker")).default
  }

  function captureCalls(spy: ReturnType<typeof vi.fn>) {
    return spy.mock.calls.filter(([url]) => String(url).endsWith("/capture/"))
  }

  test("a thrown route error POSTs exactly one $exception when a key is configured", async () => {
    const fetchSpy = vi.fn(async () => new Response("ok"))
    vi.stubGlobal("fetch", fetchSpy)
    appFetch.mockImplementationOnce(async () => {
      throw new Error("route blew up")
    })
    const worker = await freshWorker()
    const work: Promise<unknown>[] = []
    const ctx = { waitUntil: vi.fn((p: Promise<unknown>) => work.push(p)), passThroughOnException: vi.fn() }

    await expect(
      worker.fetch(
        new Request("http://cp.test/api/claxedo/health"),
        {
          CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
          // Sending takes both opt-ins (W3): the mode plus the key.
          CLAXEDO_TELEMETRY_MODE: "on",
          CLAXEDO_POSTHOG_KEY: "phc_worker",
          CLAXEDO_DEPLOYMENT_MODE: "hosted",
          CLAXEDO_RELEASE: "sha123",
        } as never,
        ctx as never,
      ),
    ).rejects.toThrow("route blew up")
    // The capture rides waitUntil so it outlives the (failed) response.
    await Promise.all(work)

    const calls = captureCalls(fetchSpy)
    expect(calls).toHaveLength(1)
    const body = JSON.parse((calls[0]![1] as RequestInit).body as string)
    expect(body.api_key).toBe("phc_worker")
    expect(body.event).toBe("$exception")
    expect(body.distinct_id).toBe("system")
    expect(body.properties.unit).toBe("worker")
    expect(body.properties.deployment_mode).toBe("hosted")
    expect(body.properties.release).toBe("sha123")
    expect(body.properties.source).toBe("worker_fetch")
    expect(body.properties.$exception_list[0].value).toBe("route blew up")

    vi.unstubAllGlobals()
    appFetch.mockImplementation(async () => new Response("ok"))
  })

  test("with no key configured the same failure makes ZERO network calls", async () => {
    const fetchSpy = vi.fn(async () => new Response("ok"))
    vi.stubGlobal("fetch", fetchSpy)
    appFetch.mockImplementationOnce(async () => {
      throw new Error("route blew up")
    })
    const worker = await freshWorker()
    const work: Promise<unknown>[] = []
    const ctx = { waitUntil: vi.fn((p: Promise<unknown>) => work.push(p)), passThroughOnException: vi.fn() }

    await expect(
      worker.fetch(
        new Request("http://cp.test/api/claxedo/health"),
        { CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test" } as never,
        ctx as never,
      ),
    ).rejects.toThrow("route blew up")
    await Promise.all(work)

    expect(fetchSpy).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
    appFetch.mockImplementation(async () => new Response("ok"))
  })
})
