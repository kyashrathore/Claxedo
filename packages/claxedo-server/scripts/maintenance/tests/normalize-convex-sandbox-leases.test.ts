import { describe, expect, test, vi } from "vitest"
import {
  normalizeConvexSandboxLeases,
  normalizeConvexSandboxLeasesInput,
} from "../normalize-convex-sandbox-leases"

describe("normalize-convex-sandbox-leases", () => {
  test("requires the Convex URL and Control Plane service token", () => {
    expect(normalizeConvexSandboxLeasesInput({
      CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://example.convex.cloud",
      CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "svc_secret",
    } as NodeJS.ProcessEnv)).toEqual({
      convexUrl: "https://example.convex.cloud",
      serviceToken: "svc_secret",
    })

    expect(() => normalizeConvexSandboxLeasesInput({
      CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "svc_secret",
    } as NodeJS.ProcessEnv)).toThrow("CLAXEDO_WORKSPACE_AUTHORITY_URL")
    expect(() => normalizeConvexSandboxLeasesInput({
      CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://example.convex.cloud",
    } as NodeJS.ProcessEnv)).toThrow("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN")
  })

  test("calls the service-token protected Convex cleanup mutation", async () => {
    const mutation = vi.fn(async () => ({ scanned: 12, updated: 3 }))

    await expect(normalizeConvexSandboxLeases({
      serviceToken: "svc_secret",
      executor: { mutation },
    })).resolves.toEqual({ scanned: 12, updated: 3 })

    expect(mutation).toHaveBeenCalledWith(expect.anything(), {
      service_token: "svc_secret",
    })
  })

  test("fails closed on malformed cleanup results", async () => {
    await expect(normalizeConvexSandboxLeases({
      serviceToken: "svc_secret",
      executor: { mutation: async () => ({ scanned: 1 }) },
    })).rejects.toThrow("incomplete result")
  })
})
