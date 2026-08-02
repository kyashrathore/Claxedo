import { describe, expect, test, vi } from "vitest"

/**
 * The fail-closed 503 from the Worker's composition guard is the ONE hosted
 * response that never enters the Hono app — `createHostedApp` never ran, so
 * `hosted-app.ts`'s outermost `securityHeaders()` middleware never ran either.
 *
 * A misconfigured hosted deploy answers EVERY request with this response. It
 * must not also be the deploy that answers every request bare.
 */

class TestCompositionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

vi.mock("../../control-plane/hosted-services", () => ({
  composeHostedControlPlane: vi.fn(() => {
    throw new TestCompositionError("hosted_deployment_mode_required", "missing CLAXEDO_DEPLOYMENT_MODE")
  }),
  HostedWorkerCompositionError: TestCompositionError,
}))

vi.mock("../hosted-shared/hosted-app", () => ({
  createHostedApp: vi.fn(() => ({ fetch: vi.fn(async () => new Response("unreachable")) })),
}))

vi.mock("../../workgraph-host/hosted-runtime", () => ({
  createHostedWorkGraphRuntime: vi.fn(() => undefined),
  createHostedSessionTranscriptRetention: vi.fn(() => undefined),
}))

describe("worker composition-error response carries security headers", () => {
  test("stamps the header set on the fail-closed 503", async () => {
    const worker = (await import("./worker")).default

    const res = await worker.fetch(new Request("https://control-plane.claxedo.test/api/claxedo/health"), {} as never)

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: { code: "hosted_deployment_mode_required", message: "missing CLAXEDO_DEPLOYMENT_MODE" },
    })
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("x-frame-options")).toBe("DENY")
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin")
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'")
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains")
  })

  test("omits HSTS when the same failure is served over plaintext localhost", async () => {
    const worker = (await import("./worker")).default

    const res = await worker.fetch(new Request("http://localhost:3001/api/claxedo/health"), {} as never)

    expect(res.status).toBe(503)
    expect(res.headers.get("strict-transport-security")).toBeNull()
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
  })
})
