import { beforeEach, describe, expect, test, vi } from "vitest"

const authFetch = vi.fn()

// Only authFetch is a true I/O boundary here. This test file runs under
// bun:test (see CONTRIBUTING.md's ".test.ts" convention), whose `vi.mock`
// shim does not support vitest's `importOriginal` partial-mock helper, so
// normalizeUrl is re-provided with its real (pure, trim + strip-trailing-
// slash) behavior rather than left undefined — serverExtensions().transformUrl
// delegates to the real utils/api normalizeUrl in production.
vi.mock("../utils/api", () => ({
  authFetch,
  normalizeUrl: (url: string | undefined) => {
    const trimmed = url?.trim()
    if (!trimmed) return undefined
    return trimmed.replace(/\/+$/, "")
  },
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
      convexUrl: "",
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
      convexUrl: "",
      authBaseUrl: "http://localhost:4444",
      gatewayUrl: "http://127.0.0.1:3000/",
      claxedoServerUrl: "http://127.0.0.1:3001/",
    })

    await expect(ext.resolveSessionUrl?.("session-1")).resolves.toBeNull()
  })

  test("skips gateway resolution when cloud autoswitch is disabled", async () => {
    const ext = serverExtensions({
      convexUrl: "",
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
      convexUrl: "",
      authBaseUrl: "http://localhost:4444",
      gatewayUrl: "http://127.0.0.1:3000/",
      claxedoServerUrl: "http://127.0.0.1:3001/",
    })

    expect(ext.transformUrl("  https://runtime.example.com/foo/  ")).toBe("https://runtime.example.com/foo")
    expect(ext.transformUrl("https://runtime.example.com///")).toBe("https://runtime.example.com")
  })
})
