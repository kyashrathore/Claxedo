import { describe, expect, test } from "bun:test"
import { focusedSurfaceRouteTarget, routeMatchesSurface, surfaceRoute } from "./surface-route"
import {
  marketplaceRoute,
  newTaskRoute,
  sessionRoute as canonicalSessionRoute,
  workspacePageRoute,
  workspaceRoute as canonicalWorkspaceRoute,
  workspaceSessionRoute,
  workspaceTerminalRoute,
  workspaceWorkGraphRoute,
} from "@/platform/identity/route"
import type { ContentMeta } from "./types"

const route = (dir: string, extra?: { id?: string; pageId?: string; terminalId?: string }) => ({
  workspaceId: dir,
  ...extra,
})

describe("surface route mirroring", () => {
  test("builds workspace WorkGraph and task-composer routes from the supplied route id", () => {
    expect(surfaceRoute("ws_main", {
      id: "surface_workgraph",
      type: "workspace-workgraph",
      directory: "/Users/person/private-repo",
    })).toBe(workspaceWorkGraphRoute("ws_main"))
    expect(surfaceRoute("ws_main", {
      id: "surface_task",
      type: "task-composer",
      directory: "/Users/person/private-repo",
    })).toBe(newTaskRoute("ws_main"))
  })

  test("does not navigate when the focused surface already matches the route", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("ws_main", { id: "ses_1" }),
        routeWorkspaceKey: "ws_main",
        activeRouteId: "ws_main",
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
        route: route("ws_main"),
        routeWorkspaceKey: "ws_main",
        activeRouteId: "ws_main",
        surface: {
          id: "surface_1",
          type: "session",
          directory: "/repo/main",
          sessionId: "ses_1",
        },
      }),
    ).toBe(canonicalSessionRoute("ses_1"))
  })

  test("mirrors typed local session surfaces without exposing their directory", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("ws_main"),
        routeWorkspaceKey: "ws_main",
        activeRouteId: "ws_main",
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
    ).toBe(canonicalSessionRoute("ses_1"))
  })

  test("keeps signed workspace session routes on their canonical workspace id", () => {
    const surface: ContentMeta = {
      id: "surface_signed",
      type: "session",
      directory: "/runtime/workspace",
      sessionId: "ses_signed",
      content: {
        type: "session",
        directory: "/runtime/workspace",
        sessionId: "ses_signed",
        sessionRef: {
          sessionId: "ses_signed",
          host: "workspace",
          workspaceId: "ws_signed",
          toolSandbox: { kind: "workspace", workspaceId: "ws_signed", hosting: "user-hosted" },
        },
      },
    }

    expect(
      focusedSurfaceRouteTarget({
        route: route("ws_signed"),
        routeWorkspaceKey: "ws_signed",
        activeRouteId: "/runtime/workspace",
        surface,
      }),
    ).toBe(workspaceSessionRoute("ws_signed", "ses_signed"))
    expect(routeMatchesSurface(route("ws_signed", { id: "ses_signed" }), "/runtime/workspace", surface, "ws_signed")).toBe(true)
  })

  test("switches from a signed real session to its canonical new-session route", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("ws_signed", { id: "ses_previous" }),
        routeWorkspaceKey: "ws_signed",
        activeRouteId: "/runtime/workspace",
        surface: {
          id: "surface_new",
          type: "session",
          directory: "/runtime/workspace",
          sessionId: "new",
          content: {
            type: "session",
            directory: "/runtime/workspace",
            sessionId: "new",
            sessionRef: {
              sessionId: "new",
              host: "workspace",
              workspaceId: "ws_signed",
              toolSandbox: { kind: "workspace", workspaceId: "ws_signed", hosting: "cloud" },
            },
          },
        },
      }),
    ).toBe(workspaceSessionRoute("ws_signed"))
  })

  test("mirrors session surfaces whose id only exists in content payload", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("ws_main"),
        routeWorkspaceKey: "ws_main",
        activeRouteId: "ws_main",
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
        route: { workspaceId: "ws_main" },
        routeWorkspaceKey: "ws_main",
        activeRouteId: "ws_main",
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
        route: route("ws_other"),
        routeWorkspaceKey: "ws_other",
        activeRouteId: "ws_main",
        surface: {
          id: "surface_1",
          type: "session",
          directory: "/repo/main",
          sessionId: "new",
        },
      }),
    ).toBe(workspaceSessionRoute("ws_main"))
  })

  test("keeps concrete routes for another workspace while route intent opens that workspace", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("ws_target", { id: "ses_target" }),
        routeWorkspaceKey: "ws_target",
        activeRouteId: "ws_source",
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
        route: route("ws_main", { id: "ses_1" }),
        routeWorkspaceKey: "ws_main",
        activeRouteId: "ws_main",
      }),
    ).toBe(canonicalWorkspaceRoute("ws_main"))
  })

  test("mirrors page surfaces to typed workspace page routes", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("ws_main"),
        routeWorkspaceKey: "ws_main",
        activeRouteId: "ws_main",
        surface: {
          id: "surface_1",
          type: "pages-index",
          directory: "/repo/main",
        },
      }),
    ).toBe(workspacePageRoute("ws_main", "__index__"))

    expect(
      focusedSurfaceRouteTarget({
        route: route("ws_main"),
        routeWorkspaceKey: "ws_main",
        activeRouteId: "ws_main",
        surface: {
          id: "surface_3",
          type: "page",
          directory: "/repo/main",
          pageId: "page_1",
        },
      }),
    ).toBe(workspacePageRoute("ws_main", "page_1"))
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
        route: route("ws_main"),
        routeWorkspaceKey: "ws_main",
        activeRouteId: "ws_main",
        surface,
      }),
    ).toBeUndefined()
  })

  test("does not mirror away from a pending terminal route while the terminal surface is settling", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("ws_main", { terminalId: "pending-pty_1" }),
        routeWorkspaceKey: "ws_main",
        activeRouteId: "ws_main",
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
        route: route("ws_main", { terminalId: "pending-pty_1" }),
        routeWorkspaceKey: "ws_main",
        activeRouteId: "ws_main",
      }),
    ).toBeUndefined()
  })

  test("does not mirror away from a real terminal route while the terminal surface is settling", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("ws_main", { terminalId: "pty_1" }),
        routeWorkspaceKey: "ws_main",
        activeRouteId: "ws_main",
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
        route: route("ws_main", { terminalId: "pty_1" }),
        routeWorkspaceKey: "ws_main",
        activeRouteId: "ws_main",
      }),
    ).toBeUndefined()
  })

  test("mirrors terminal surfaces to typed workspace terminal routes", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("ws_main"),
        routeWorkspaceKey: "ws_main",
        activeRouteId: "ws_main",
        surface: {
          id: "surface_1",
          type: "terminal",
          directory: "/repo/main",
          terminalId: "pty_1",
        },
      }),
    ).toBe(workspaceTerminalRoute("ws_main", "pty_1"))
  })

  test("mirrors terminal recovery to the focused terminal id", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("ws_main", { terminalId: "pty_old" }),
        routeWorkspaceKey: "ws_main",
        activeRouteId: "ws_main",
        surface: {
          id: "surface_1",
          type: "terminal",
          directory: "/repo/main",
          terminalId: "pty_new",
        },
      }),
    ).toBe(workspaceTerminalRoute("ws_main", "pty_new"))
  })

  test("mirrors marketplace surfaces to the global marketplace route", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: route("ws_main", { id: "ses_1" }),
        routeWorkspaceKey: "ws_main",
        activeRouteId: "ws_main",
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
        activeRouteId: "ws_main",
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

    expect(surfaceRoute("ws_main", surface)).toBe(marketplaceRoute())
    expect(routeMatchesSurface({ marketplace: true }, "", surface)).toBe(true)
    expect(routeMatchesSurface({ id: "ses_1" }, "ws_main", surface, "ws_main")).toBe(false)
  })

  test("keeps local workspace-backed sessions on directory-free session routes", () => {
    expect(
      focusedSurfaceRouteTarget({
        route: { id: "ses_1" },
        routeWorkspaceKey: undefined,
        activeRouteId: "ws_main",
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
    ).toBe(canonicalSessionRoute("ses_1"))
  })
})
