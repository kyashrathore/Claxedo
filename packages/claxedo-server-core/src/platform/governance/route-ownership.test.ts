import { describe, expect, test } from "vitest"

import { routeOwnership, RouteHandler, WORKSPACE_RUNTIME_IDENTITY_PATH } from "./route-ownership"

describe("routeOwnership", () => {
  /**
   * `/global/health` is the daemon's own liveness probe on its ROOT surface
   * and is rightly classified central here. On the workspace-scoped
   * `/workspaces/:id/*` surface the same path is the runtime's identity probe
   * instead — `user-hosted-surface.ts` (claxedo-local-server) admits it there
   * directly rather than asking this root-surface table, which has no way to
   * answer that question for a surface it does not model.
   */
  test("classifies the runtime identity probe central on the root surface", () => {
    expect(routeOwnership(WORKSPACE_RUNTIME_IDENTITY_PATH).handler).toBe(RouteHandler.CentralServer)
  })

  test("classifies workspace-runtime routes", () => {
    expect(routeOwnership("/session").handler).toBe(RouteHandler.SandboxRuntime)
    expect(routeOwnership("/provider").handler).toBe(RouteHandler.SandboxRuntime)
  })

  test("classifies central-server routes", () => {
    expect(routeOwnership("/api/claxedo/health").handler).toBe(RouteHandler.CentralServer)
    expect(routeOwnership("/global/dispose").handler).toBe(RouteHandler.CentralServer)
    expect(routeOwnership("/provider/auth").handler).toBe(RouteHandler.CentralServer)
  })
})
