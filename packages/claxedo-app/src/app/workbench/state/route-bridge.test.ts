import { describe, expect, test } from "bun:test"
import {
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  collectSessionDeepLinks,
  deepLinkEvent,
  drainPendingDeepLinks,
  newSessionDeepLinkRoute,
  parseDeepLink,
  parseNewSessionDeepLink,
  parseSessionDeepLink,
  sessionDeepLink,
} from "./route-deep-links"

// The session-probe/metadata URL builders moved to ./route-bridge-resolution;
// their behavior is now exercised in route-bridge-resolution.test.ts (real URL
// output) rather than by grepping this component's source text.

describe("route bridge deep links", () => {
  test("parses open-project deep links", () => {
    expect(parseDeepLink("claxedo://open-project?directory=/repo/main")).toBe("/repo/main")
    expect(parseDeepLink("claxedo://new-session?directory=/repo/main")).toBeUndefined()
    expect(collectOpenProjectDeepLinks([
      "https://example.com",
      "claxedo://open-project?directory=/repo/main",
      "claxedo://open-project",
    ])).toEqual(["/repo/main"])
  })

  test("parses new-session deep links with optional prompt payloads", () => {
    expect(parseNewSessionDeepLink("claxedo://new-session?directory=/repo/main")).toEqual({
      directory: "/repo/main",
    })
    expect(parseNewSessionDeepLink("claxedo://new-session?directory=/repo/main&prompt=hello")).toEqual({
      directory: "/repo/main",
      prompt: "hello",
    })
    expect(collectNewSessionDeepLinks([
      "claxedo://open-project?directory=/repo/main",
      "claxedo://new-session?directory=/repo/next&prompt=ship",
    ])).toEqual([{ directory: "/repo/next", prompt: "ship" }])
  })

  test("round-trips a session's on-disk location through open-session deep links", () => {
    const link = sessionDeepLink({
      workspaceDirectory: "/repo/main",
      sessionId: "ses_1",
      store: "/home/me/.claxedo/opencode-runtime/opencode.db",
    })
    expect(link).toBe(
      "claxedo://open-session?directory=%2Frepo%2Fmain&store=%2Fhome%2Fme%2F.claxedo%2Fopencode-runtime%2Fopencode.db&session=ses_1",
    )
    expect(parseSessionDeepLink(link)).toEqual({
      sessionId: "ses_1",
      workspaceDirectory: "/repo/main",
      store: "/home/me/.claxedo/opencode-runtime/opencode.db",
    })
    // A bare `session` param still opens the session; the rest is provenance.
    expect(parseSessionDeepLink("claxedo://open-session?session=ses_1"))
      .toEqual({ sessionId: "ses_1", workspaceDirectory: undefined, store: undefined })
    expect(collectSessionDeepLinks([
      "https://example.com",
      link,
      "claxedo://open-session?directory=/repo/main",
      "claxedo://open-project?directory=/repo/main",
    ])).toEqual([{ sessionId: "ses_1", workspaceDirectory: "/repo/main", store: "/home/me/.claxedo/opencode-runtime/opencode.db" }])
  })

  test("carries new-session prompt text in the routed workspace URL", () => {
    const routeFor = (directory: string) => `/w/${encodeURIComponent(directory)}/session`

    expect(newSessionDeepLinkRoute({ directory: "/repo/main" }, "ws_1", routeFor)).toBe("/w/ws_1/session")
    expect(newSessionDeepLinkRoute({ directory: "/repo/main", prompt: "  ship it  " }, "ws_1", routeFor)).toBe(
      "/w/ws_1/session?prompt=ship%20it",
    )
    expect(newSessionDeepLinkRoute({ directory: "/repo/main", prompt: "line one\nline two & more" }, "ws_1", routeFor)).toBe(
      "/w/ws_1/session?prompt=line%20one%0Aline%20two%20%26%20more",
    )
  })

  test("drains pending window deep links exactly once", () => {
    const target = {
      __CLAXEDO__: {
        deepLinks: ["claxedo://open-project?directory=/repo/main"],
      },
    } as Window & { __CLAXEDO__: { deepLinks: string[] } }

    expect(drainPendingDeepLinks(target)).toEqual(["claxedo://open-project?directory=/repo/main"])
    expect(target.__CLAXEDO__.deepLinks).toEqual([])
    expect(drainPendingDeepLinks(target)).toEqual([])
  })

  test("keeps the desktop event name stable", () => {
    expect(deepLinkEvent).toBe("claxedo:deep-link")
  })
})
