import { describe, expect, test } from "vitest"

import { routeOwnership, RouteHandler, WORKSPACE_RUNTIME_IDENTITY_PATH } from "./route-ownership"

describe("routeOwnership", () => {
  /**
   * `/global/health` is the daemon's own liveness probe on its ROOT surface
   * and is rightly classified central here. On the workspace-scoped
   * `/workspaces/:id/*` surface the same path is the runtime's identity probe
   * instead — `@claxedo/host-serving`'s `surface.ts` admits it there directly
   * rather than asking this root-surface table, which has no way to answer
   * that question for a surface it does not model.
   */
  test("classifies the runtime identity probe central on the root surface", () => {
    expect(routeOwnership(WORKSPACE_RUNTIME_IDENTITY_PATH).handler).toBe(RouteHandler.CentralServer)
  })

  test("classifies workspace-runtime routes", () => {
    expect(routeOwnership("/session").handler).toBe(RouteHandler.SandboxRuntime)
    // The typed workspace-runtime client requests the `/api/wr` mount of the
    // file and search routes; the root-surface proxy must dispatch that mount
    // exactly like the bare `/file` and `/find` compatibility paths.
    for (const path of ["/api/wr/file", "/api/wr/file/status", "/api/wr/file/content", "/api/wr/find/file", "/file", "/find/file"]) {
      expect(routeOwnership(path).handler, path).toBe(RouteHandler.SandboxRuntime)
    }
    expect(routeOwnership("/api/claxedo/agent-config/providers").handler).toBe(RouteHandler.CentralServer)
  })

  test("classifies central-server routes", () => {
    expect(routeOwnership("/api/claxedo/health").handler).toBe(RouteHandler.CentralServer)
    expect(routeOwnership("/api/cp/events").handler).toBe(RouteHandler.CentralServer)
    expect(routeOwnership("/provider/auth").handler).toBe(RouteHandler.CentralServer)
  })
})
