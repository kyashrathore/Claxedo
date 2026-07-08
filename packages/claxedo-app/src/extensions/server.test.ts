import { beforeEach, describe, expect, test, vi } from "vitest"

const authFetch = vi.fn()

vi.mock("../utils/api", () => ({
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
})
