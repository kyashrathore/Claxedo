import { beforeEach, describe, expect, test, vi } from "vitest"

const query = vi.fn()

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    query = query
  },
}))

vi.mock("convex/server", () => ({
  anyApi: { hostEnrollments: { activeWorkspaceHostForRelay: {} } },
}))

const { createUserHostedTargetResolver } = await import("./user-hosted-relay-target")

describe("user-hosted relay target resolver", () => {
  beforeEach(() => {
    query.mockReset()
  })

  test("fails with the shared control-plane timeout when Convex does not respond", async () => {
    vi.useFakeTimers()
    vi.stubEnv("CLAXEDO_CONVEX_READ_TIMEOUT_MS", "25")
    try {
      query.mockReturnValue(new Promise<never>(() => undefined))
      const resolver = createUserHostedTargetResolver({
        convexUrl: "https://control-plane.example.test",
        serviceToken: "service-token",
      })
      const pending = resolver("ws_1")

      const rejection = expect(pending).rejects.toMatchObject({
        status: 503,
        code: "control_plane_request_timeout",
      })
      await vi.advanceTimersByTimeAsync(25)
      await rejection
    } finally {
      vi.unstubAllEnvs()
      vi.useRealTimers()
    }
  })
})
