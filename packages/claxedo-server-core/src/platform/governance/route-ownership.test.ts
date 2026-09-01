import { describe, expect, test } from "vitest"

import { routeOwnership, RouteHandler, runtimeServesOnWorkspaceSurface, WORKSPACE_RUNTIME_IDENTITY_PATH } from "./route-ownership"

describe("runtimeServesOnWorkspaceSurface", () => {
  /**
   * `/global/health` is central on the daemon's root surface and the
   * runtime's identity probe on the workspace surface. A tunnel guard that
   * used the root verdict refused the control plane's own verification.
   */
  test("admits the runtime identity probe although the root surface classifies it central", () => {
    expect(routeOwnership(WORKSPACE_RUNTIME_IDENTITY_PATH).handler).toBe(RouteHandler.CentralServer)
    expect(runtimeServesOnWorkspaceSurface(WORKSPACE_RUNTIME_IDENTITY_PATH)).toBe(true)
  })

  test("otherwise follows the runtime ownership verdict", () => {
    expect(runtimeServesOnWorkspaceSurface("/session")).toBe(true)
    expect(runtimeServesOnWorkspaceSurface("/provider")).toBe(true)
    expect(runtimeServesOnWorkspaceSurface("/api/claxedo/health")).toBe(false)
    expect(runtimeServesOnWorkspaceSurface("/global/dispose")).toBe(false)
    expect(runtimeServesOnWorkspaceSurface("/provider/auth")).toBe(false)
  })
})
