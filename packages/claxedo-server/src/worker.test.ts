import { describe, expect, test, vi } from "vitest"
import type { DocumentIndexEntry } from "./documents/index-store"
import type { ControlPlaneServices } from "./control-plane/services"

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
let workspaceRole: "viewer" | "editor" | "admin" | "owner" = "editor"
const authorizeSessionRead = vi.fn(async () => undefined)
const openWorkspace = vi.fn(async () => ({
  role: workspaceRole,
  workspace: { workspace_id: "local_ws", org_id: "org_1", project_id: "project_1" },
}))
const createHostedApp = vi.fn((
  _plane: unknown,
  _options?: { workGraphReconcile?: () => Promise<unknown>; documentsBackend?: unknown },
) => ({ fetch: appFetch }))

vi.mock("./control-plane/hosted-services", () => ({
  composeHostedControlPlane: vi.fn(() => ({
    services: { authority: { authorizeSessionRead, openWorkspace } },
  })),
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
    // withSentry proxies env as well; the bindings must pass through intact.
    expect(gotEnv).toEqual(env)
    expect(createHostedApp.mock.calls[0]?.[1]?.documentsBackend).toBeDefined()
    expect((createHostedApp.mock.calls[0]?.[1]?.documentsBackend as { agentOpen?: unknown }).agentOpen).toBeTypeOf("function")
    // withSentry proxies ctx (and wraps the tracked promise; the SDK itself
    // may also register waitUntil work): assert a waitUntil call on the ctx
    // the app received reaches the runtime's ctx.
    const callsBefore = ctx.waitUntil.mock.calls.length
    gotCtx.waitUntil(Promise.resolve())
    expect(ctx.waitUntil.mock.calls.length).toBe(callsBefore + 1)
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
