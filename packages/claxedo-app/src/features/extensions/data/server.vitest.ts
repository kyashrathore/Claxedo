import { beforeEach, describe, expect, test, vi } from "vitest"

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }))

// Preserve URL normalization and all other production helpers; replace only I/O.
vi.mock("@/platform/api/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/api/api")>()),
  authFetch,
}))

import { serverExtensions } from "./server"

describe("serverExtensions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test("resolves workspace-hosted sessions through the control-plane gateway route", async () => {
    authFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        gatewayUrl: "https://runtime.example.com/",
      }),
    })

    const ext = serverExtensions({
      authBaseUrl: "http://localhost:4444",
      gatewayUrl: "http://127.0.0.1:3000/",
      claxedoServerUrl: "http://127.0.0.1:3001/",
    })

    await expect(ext.resolveSessionUrl?.("session-1")).resolves.toBe("https://runtime.example.com")
    expect(authFetch).toHaveBeenCalledWith("http://127.0.0.1:3001/api/control/sessions/session-1/gateway")
  })

  test("does not switch when no live gateway is returned", async () => {
    authFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        gatewayUrl: null,
      }),
    })

    const ext = serverExtensions({
      authBaseUrl: "http://localhost:4444",
      gatewayUrl: "http://127.0.0.1:3000/",
      claxedoServerUrl: "http://127.0.0.1:3001/",
    })

    await expect(ext.resolveSessionUrl?.("session-1")).resolves.toBeNull()
  })

  test("skips gateway resolution when cloud autoswitch is disabled", async () => {
    const ext = serverExtensions({
      authBaseUrl: "http://localhost:4444",
      gatewayUrl: "http://127.0.0.1:3000/",
      claxedoServerUrl: "http://127.0.0.1:3001/",
      cloudAutoSwitch: false,
    })

    await expect(ext.resolveSessionUrl?.("session-1")).resolves.toBeNull()
    expect(authFetch).not.toHaveBeenCalled()
  })

  test("transformUrl trims whitespace and strips trailing slashes via the shared normalizeUrl", () => {
    const ext = serverExtensions({
      authBaseUrl: "http://localhost:4444",
      gatewayUrl: "http://127.0.0.1:3000/",
      claxedoServerUrl: "http://127.0.0.1:3001/",
    })

    expect(ext.transformUrl("  https://runtime.example.com/foo/  ")).toBe("https://runtime.example.com/foo")
    expect(ext.transformUrl("https://runtime.example.com///")).toBe("https://runtime.example.com")
  })
})
