import { describe, expect, test } from "bun:test"
import { focusedSurfaceRouteTarget, routeMatchesSurface, surfaceRoute } from "./surface-route"
import {
  marketplaceRoute,
  sessionRoute as canonicalSessionRoute,
  workspacePageRoute,
  workspaceRoute as canonicalWorkspaceRoute,
  workspaceSessionRoute,
  workspaceTerminalRoute,
} from "@/platform/identity/route"
import type { ContentMeta } from "./types"

const route = (dir: string, extra?: { id?: string; pageId?: string; terminalId?: string }) => ({
  workspaceId: dir,
  ...extra,
})

describe("surface route mirroring", () => {
  test("does not navigate when the focused surface already matches the route", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("/repo/main", { id: "ses_1" }),
        routeWorkspaceKey: "/repo/main",
        activeDirectory: "/repo/main",
        surface: {
          id: "surface_1",
          type: "session",
          directory: "/repo/main",
          sessionId: "ses_1",
        },
      }),
    ).toBeUndefined()
  })

  test("mirrors focused session surface back to its canonical session URL", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("/repo/main"),
        routeWorkspaceKey: "/repo/main",
        activeDirectory: "/repo/main",
        surface: {
          id: "surface_1",
          type: "session",
          directory: "/repo/main",
          sessionId: "ses_1",
        },
      }),
    ).toBe(canonicalSessionRoute("ses_1"))
  })

  test("mirrors typed workspace session surfaces to the workspace session route", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("/repo/main"),
        routeWorkspaceKey: "/repo/main",
        activeDirectory: "/repo/main",
        surface: {
          id: "surface_1",
          type: "session",
          directory: "/repo/main",
          sessionId: "ses_1",
          content: {
            type: "session",
            directory: "/repo/main",
            sessionId: "ses_1",
            sessionRef: {
              sessionId: "ses_1",
              host: "workspace",
              cwd: "/repo/main",
              toolSandbox: { kind: "local", cwd: "/repo/main" },
            },
          },
        },
      }),
    ).toBe(workspaceSessionRoute("/repo/main", "ses_1"))
  })

  test("mirrors session surfaces whose id only exists in content payload", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("/repo/main"),
        routeWorkspaceKey: "/repo/main",
        activeDirectory: "/repo/main",
        surface: {
          id: "surface_1",
          type: "session",
          directory: "/repo/main",
          content: {
            type: "session",
            directory: "/repo/main",
            sessionId: "ses_legacy",
            title: "New session - 2026-05-29T03:52:00.000Z",
          },
        },
      }),
    ).toBe(canonicalSessionRoute("ses_legacy"))
  })

  test("mirrors draft session surfaces to the typed workspace session route", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: { workspaceId: "/repo/main" },
        routeWorkspaceKey: "/repo/main",
        activeDirectory: "/repo/main",
        surface: {
          id: "surface_1",
          type: "session",
          directory: "/repo/main",
          sessionId: "new",
        },
      }),
    ).toBeUndefined()

    expect(
      focusedSurfaceRouteTarget({
        route: route("/repo/other"),
        routeWorkspaceKey: "/repo/other",
        activeDirectory: "/repo/main",
        surface: {
          id: "surface_1",
          type: "session",
          directory: "/repo/main",
          sessionId: "new",
        },
      }),
    ).toBe(workspaceSessionRoute("/repo/main"))
  })

  test("keeps concrete routes for another workspace while route intent opens that workspace", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("/repo/target", { id: "ses_target" }),
        routeWorkspaceKey: "/repo/target",
        activeDirectory: "/repo/source",
        surface: {
          id: "surface_1",
          type: "session",
          directory: "/repo/source",
          sessionId: "ses_source",
        },
      }),
    ).toBeUndefined()
  })

  test("returns the workspace URL when a concrete route has no focused surface", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("/repo/main", { id: "ses_1" }),
        routeWorkspaceKey: "/repo/main",
        activeDirectory: "/repo/main",
      }),
    ).toBe(canonicalWorkspaceRoute("/repo/main"))
  })

  test("mirrors page surfaces to typed workspace page routes", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("/repo/main"),
        routeWorkspaceKey: "/repo/main",
        activeDirectory: "/repo/main",
        surface: {
          id: "surface_1",
          type: "pages-index",
          directory: "/repo/main",
        },
      }),
    ).toBe(workspacePageRoute("/repo/main", "__index__"))

    expect(
      focusedSurfaceRouteTarget({
        route: route("/repo/main"),
        routeWorkspaceKey: "/repo/main",
        activeDirectory: "/repo/main",
        surface: {
          id: "surface_3",
          type: "page",
          directory: "/repo/main",
          pageId: "page_1",
        },
      }),
    ).toBe(workspacePageRoute("/repo/main", "page_1"))
  })

  test("does not mirror pending terminal surfaces into shareable terminal URLs", () => {
    const surface: ContentMeta = {
      id: "surface_1",
      type: "terminal",
      directory: "/repo/main",
      terminalId: "pending-pty_1",
    }

    expect(
      focusedSurfaceRouteTarget({
        route: route("/repo/main"),
        routeWorkspaceKey: "/repo/main",
        activeDirectory: "/repo/main",
        surface,
      }),
    ).toBeUndefined()
  })

  test("does not mirror away from a pending terminal route while the terminal surface is settling", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("/repo/main", { terminalId: "pending-pty_1" }),
        routeWorkspaceKey: "/repo/main",
        activeDirectory: "/repo/main",
        surface: {
          id: "surface_session",
          type: "session",
          directory: "/repo/main",
          sessionId: "ses_1",
        },
      }),
    ).toBeUndefined()

    expect(
      focusedSurfaceRouteTarget({
        route: route("/repo/main", { terminalId: "pending-pty_1" }),
        routeWorkspaceKey: "/repo/main",
        activeDirectory: "/repo/main",
      }),
    ).toBeUndefined()
  })

  test("does not mirror away from a real terminal route while the terminal surface is settling", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("/repo/main", { terminalId: "pty_1" }),
        routeWorkspaceKey: "/repo/main",
        activeDirectory: "/repo/main",
        surface: {
          id: "surface_session",
          type: "session",
          directory: "/repo/main",
          sessionId: "ses_1",
        },
      }),
    ).toBeUndefined()

    expect(
      focusedSurfaceRouteTarget({
        route: route("/repo/main", { terminalId: "pty_1" }),
        routeWorkspaceKey: "/repo/main",
        activeDirectory: "/repo/main",
      }),
    ).toBeUndefined()
  })

  test("mirrors terminal surfaces to typed workspace terminal routes", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("/repo/main"),
        routeWorkspaceKey: "/repo/main",
        activeDirectory: "/repo/main",
        surface: {
          id: "surface_1",
          type: "terminal",
          directory: "/repo/main",
          terminalId: "pty_1",
        },
      }),
    ).toBe(workspaceTerminalRoute("/repo/main", "pty_1"))
  })

  test("mirrors terminal recovery to the focused terminal id", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("/repo/main", { terminalId: "pty_old" }),
        routeWorkspaceKey: "/repo/main",
        activeDirectory: "/repo/main",
        surface: {
          id: "surface_1",
          type: "terminal",
          directory: "/repo/main",
          terminalId: "pty_new",
        },
      }),
    ).toBe(workspaceTerminalRoute("/repo/main", "pty_new"))
  })

  test("mirrors marketplace surfaces to the global marketplace route", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("/repo/main", { id: "ses_1" }),
        routeWorkspaceKey: "/repo/main",
        activeDirectory: "/repo/main",
        surface: {
          id: "surface_1",
          type: "marketplace",
          scope: "global",
        },
      }),
    ).toBe(marketplaceRoute())

    expect(
      focusedSurfaceRouteTarget({
        route: { marketplace: true },
        activeDirectory: "/repo/main",
        surface: {
          id: "surface_1",
          type: "marketplace",
          scope: "global",
        },
      }),
    ).toBeUndefined()
  })

  test("matches marketplace routes without a workspace directory", () => {
    const surface: ContentMeta = {
      id: "surface_1",
      type: "marketplace",
      scope: "global",
    }

    expect(surfaceRoute("/repo/main", surface)).toBe(marketplaceRoute())
    expect(routeMatchesSurface({ marketplace: true }, "", surface)).toBe(true)
    expect(routeMatchesSurface({ id: "ses_1" }, "/repo/main", surface, "/repo/main")).toBe(false)
  })

  test("mirrors workspace-backed sessions from direct session routes to workspace session routes", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: { id: "ses_1" },
        routeWorkspaceKey: undefined,
        activeDirectory: "/repo/main",
        surface: {
          id: "surface_1",
          type: "session",
          directory: "/repo/main",
          sessionId: "ses_1",
          content: {
            type: "session",
            directory: "/repo/main",
            sessionId: "ses_1",
            sessionRef: {
              sessionId: "ses_1",
              host: "workspace",
              cwd: "/repo/main",
              toolSandbox: { kind: "local", cwd: "/repo/main" },
            },
          },
        },
      }),
    ).toBe(workspaceSessionRoute("/repo/main", "ses_1"))
  })
})
