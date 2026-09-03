import { describe, expect, test } from "bun:test"
import { base64Encode } from "@/lib/encode"
import {
  legacyDirectoryFromRouteKey,
  legacyDirectoryRouteKey,
  marketplaceRoute,
  parseShellRoute,
  nonCanonicalWorkspaceRouteRedirect,
  resolveLegacyRedirect,
  sessionRoute,
  shellRouteDirectory,
  shellRouteDirectoryFromPathname,
  workspacePageRoute,
  workspaceRoute,
  workspaceRouteWithId,
  workspaceSessionRoute,
  workspaceTerminalRoute,
} from "./route"

describe("shell route identity", () => {
  test("builds canonical session-first and workspace browse routes", () => {
    expect(sessionRoute("ses_1")).toBe("/s/ses_1")
    expect(sessionRoute("session/with slash")).toBe("/s/session%2Fwith%20slash")
    expect(marketplaceRoute()).toBe("/marketplace")
    expect(workspaceRoute("ws_1")).toBe("/w/ws_1")
    expect(workspaceSessionRoute("ws_1")).toBe("/w/ws_1/session")
    expect(workspaceSessionRoute("ws_1", "ses/with slash")).toBe("/w/ws_1/session/ses%2Fwith%20slash")
    expect(workspacePageRoute("ws_1", "page/with slash")).toBe("/w/ws_1/page/page%2Fwith%20slash")
    expect(workspaceTerminalRoute("ws_1", "pty/with slash")).toBe("/w/ws_1/terminal/pty%2Fwith%20slash")
  })

  test("refuses to construct workspace routes from filesystem directories", () => {
    for (const directory of [
      "/private/tmp/workspace",
      "C:\\Users\\name\\workspace",
      "%2Fprivate%2Ftmp%2Fworkspace",
      "%252FUsers%252Fname%252Fworkspace",
    ]) {
      expect(() => workspaceRoute(directory)).toThrow("opaque workspace ID")
      expect(() => workspaceSessionRoute(directory)).toThrow("opaque workspace ID")
      expect(() => workspacePageRoute(directory, "page_1")).toThrow("opaque workspace ID")
      expect(() => workspaceTerminalRoute(directory, "pty_1")).toThrow("opaque workspace ID")
    }
  })

  test("keeps legacy directory route keys in the route boundary", () => {
    expect(legacyDirectoryRouteKey("/repo/main")).toBe(base64Encode("/repo/main"))
    expect(legacyDirectoryFromRouteKey(base64Encode("/repo/main"))).toBe("/repo/main")
    expect(legacyDirectoryFromRouteKey("not-base64")).toBeUndefined()
  })

  test("parses canonical session and workspace routes", () => {
    expect(parseShellRoute("/s/session%2Fwith%20slash?tab=1")).toEqual({
      kind: "session",
      sessionId: "session/with slash",
    })
    expect(parseShellRoute("/marketplace")).toEqual({
      kind: "marketplace",
    })
    expect(parseShellRoute("/w/ws_cloud_1")).toEqual({
      kind: "workspace",
      workspaceId: "ws_cloud_1",
    })
    expect(parseShellRoute("/w/%2Frepo%2Fmain/session")).toEqual({
      kind: "workspace-session",
      workspaceId: "/repo/main",
    })
    expect(parseShellRoute("/w/%2Frepo%2Fmain/session/ses%2Fwith%20slash")).toEqual({
      kind: "workspace-session",
      workspaceId: "/repo/main",
      sessionId: "ses/with slash",
    })
    expect(parseShellRoute("/w/%2Frepo%2Fmain/page/page%2Fwith%20slash")).toEqual({
      kind: "workspace-page",
      workspaceId: "/repo/main",
      pageId: "page/with slash",
    })
    expect(parseShellRoute("/w/%2Frepo%2Fmain/terminal/pty%2Fwith%20slash")).toEqual({
      kind: "workspace-terminal",
      workspaceId: "/repo/main",
      terminalId: "pty/with slash",
    })
  })

  test("rewrites directory-shaped workspace routes with an opaque workspace id", () => {
    expect(workspaceRouteWithId(parseShellRoute("/w/%2Frepo%2Fmain"), "ws_local")).toBe("/w/ws_local")
    expect(workspaceRouteWithId(parseShellRoute("/w/%2Frepo%2Fmain/session/ses_1"), "ws_local"))
      .toBe("/w/ws_local/session/ses_1")
    expect(workspaceRouteWithId(parseShellRoute("/w/%2Frepo%2Fmain/page/page_1"), "ws_local"))
      .toBe("/w/ws_local/page/page_1")
    expect(workspaceRouteWithId(parseShellRoute("/w/%2Frepo%2Fmain/terminal/pty_1"), "ws_local"))
      .toBe("/w/ws_local/terminal/pty_1")
  })

  test("removes a filesystem directory from a workspace session URL", () => {
    const reported =
      "/w/%2Fprivate%2Ftmp%2Fclaxedo-visual-check%2Fworkspaces%2Fworkspace-02/session/ses_f5f6a4e40001P1kqQtnHHMxZfd"

    expect(nonCanonicalWorkspaceRouteRedirect(reported)).toBe(
      "/s/ses_f5f6a4e40001P1kqQtnHHMxZfd",
    )
  })

  test("does not redirect a workspace URL that already contains an opaque id", () => {
    expect(nonCanonicalWorkspaceRouteRedirect("/w/workspace-02-id/session/ses_1"))
      .toBeUndefined()
  })

  test("does not discard non-session or draft workspace routes", () => {
    const directory = "%2Fprivate%2Ftmp%2Fworkspace"
    for (const pathname of [
      `/w/${directory}`,
      `/w/${directory}/session`,
      `/w/${directory}/session/new`,
      `/w/${directory}/page/page_1`,
      `/w/${directory}/terminal/pty_1`,
    ]) {
      expect(nonCanonicalWorkspaceRouteRedirect(pathname)).toBeUndefined()
    }
  })

  test("recovers decoded absolute workspace routes", () => {
    expect(parseShellRoute("/w//Users/yash/repo/session/ses_1")).toEqual({
      kind: "workspace-session",
      workspaceId: "/Users/yash/repo",
      sessionId: "ses_1",
    })
    expect(parseShellRoute("/w//Users/yash/repo/page/page_1")).toEqual({
      kind: "workspace-page",
      workspaceId: "/Users/yash/repo",
      pageId: "page_1",
    })
    expect(parseShellRoute("/w//Users/yash/repo/terminal/pty_1")).toEqual({
      kind: "workspace-terminal",
      workspaceId: "/Users/yash/repo",
      terminalId: "pty_1",
    })
  })

  test("keeps route workspace key extraction inside the shell route boundary", () => {
    expect(shellRouteDirectory(parseShellRoute("/s/ses_1"))).toBeUndefined()
    expect(shellRouteDirectory(parseShellRoute("/w/ws_cloud_1/session"))).toBe("ws_cloud_1")
    expect(shellRouteDirectory(parseShellRoute(`/${base64Encode("/repo/main")}/page/page_1`))).toBe("/repo/main")
  })

  test("extracts initial route workspace keys from canonical and legacy pathnames", () => {
    expect(shellRouteDirectoryFromPathname("/s/ses_1")).toBeUndefined()
    expect(shellRouteDirectoryFromPathname("/w/ws_cloud_1/session")).toBe("ws_cloud_1")
    expect(shellRouteDirectoryFromPathname("/w/%2Frepo%2Fmain/session")).toBe("/repo/main")
    expect(shellRouteDirectoryFromPathname(`/${base64Encode("/repo/main")}/session/ses_123`)).toBe("/repo/main")
  })

  test("recognizes legacy base64 directory session routes without making directory canonical", () => {
    const legacy = `/${base64Encode("/repo/main")}/session/ses_123`

    expect(parseShellRoute(legacy)).toEqual({
      kind: "legacy-directory",
      directory: "/repo/main",
      sessionId: "ses_123",
    })
  })

  test("recognizes legacy base64 page and terminal routes without making directory canonical", () => {
    expect(parseShellRoute(`/${base64Encode("/repo/main")}/page/page%2F123`)).toEqual({
      kind: "legacy-directory",
      directory: "/repo/main",
      pageId: "page/123",
    })
    expect(parseShellRoute(`/${base64Encode("/repo/main")}/terminal/pty%2F123`)).toEqual({
      kind: "legacy-directory",
      directory: "/repo/main",
      terminalId: "pty/123",
    })
  })

  test("does not invent a workspace id for legacy directory-only routes", () => {
    const legacy = `/${base64Encode("/repo/main")}`

    expect(parseShellRoute(legacy)).toEqual({
      kind: "legacy-directory",
      directory: "/repo/main",
    })
  })

  test("resolves legacy directory-only routes to workspace browse when the compatibility resolver proves the workspace", async () => {
    const legacy = `/${base64Encode("/repo/main")}`

    await expect(resolveLegacyRedirect(legacy, async (input) => {
      expect(input).toEqual({ directory: "/repo/main" })
      return { workspaceId: "ws_1" }
    })).resolves.toBe("/w/ws_1")
  })

  test("resolves legacy page and terminal routes to typed workspace routes when the resolver proves the workspace", async () => {
    const calls: string[] = []
    const resolve = async (input: { directory: string }) => {
      calls.push(input.directory)
      return { workspaceId: "ws_1" }
    }

    await expect(resolveLegacyRedirect(`/${base64Encode("/repo/main")}/page/page%2F123`, resolve))
      .resolves.toBe("/w/ws_1/page/page%2F123")
    await expect(resolveLegacyRedirect(`/${base64Encode("/repo/main")}/terminal/pty%2F123`, resolve))
      .resolves.toBe("/w/ws_1/terminal/pty%2F123")
    expect(calls).toEqual(["/repo/main", "/repo/main"])
  })

  test("does not resolve legacy directory-only routes without a concrete workspace id", async () => {
    const legacy = `/${base64Encode("/repo/main")}`

    await expect(resolveLegacyRedirect(legacy, async () => null)).resolves.toBeUndefined()
  })

  test("does not call the compatibility resolver for canonical or legacy session routes", async () => {
    const calls: string[] = []

    await expect(resolveLegacyRedirect("/s/ses_1", async (input) => {
      calls.push(input.directory)
      return { workspaceId: "ws_1" }
    })).resolves.toBeUndefined()
    await expect(resolveLegacyRedirect(`/${base64Encode("/repo/main")}/session/ses_2`, async (input) => {
      calls.push(input.directory)
      return { workspaceId: "ws_1" }
    })).resolves.toBeUndefined()
    expect(calls).toEqual([])
  })

  test("leaves reserved app routes outside shell identity", () => {
    expect(parseShellRoute("/login")).toEqual({ kind: "unknown" })
    expect(parseShellRoute("/marketplace/extra")).toEqual({ kind: "unknown" })
  })
})
