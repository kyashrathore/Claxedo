import { describe, expect, test } from "bun:test"
import {
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  deepLinkEvent,
  drainPendingDeepLinks,
  newSessionDeepLinkRoute,
  parseDeepLink,
  parseNewSessionDeepLink,
} from "./route-deep-links"

// The session-probe/metadata URL builders moved to ./route-bridge-resolution;
// their behavior is now exercised in route-bridge-resolution.test.ts (real URL
// output) rather than by grepping this component's source text.

describe("route bridge deep links", () => {
  test("parses open-project deep links", () => {
    expect(parseDeepLink("opencode://open-project?directory=/repo/main")).toBe("/repo/main")
    expect(parseDeepLink("opencode://new-session?directory=/repo/main")).toBeUndefined()
    expect(collectOpenProjectDeepLinks([
      "https://example.com",
      "opencode://open-project?directory=/repo/main",
      "opencode://open-project",
    ])).toEqual(["/repo/main"])
  })

  test("parses new-session deep links with optional prompt payloads", () => {
    expect(parseNewSessionDeepLink("opencode://new-session?directory=/repo/main")).toEqual({
      directory: "/repo/main",
    })
    expect(parseNewSessionDeepLink("opencode://new-session?directory=/repo/main&prompt=hello")).toEqual({
      directory: "/repo/main",
      prompt: "hello",
    })
    expect(collectNewSessionDeepLinks([
      "opencode://open-project?directory=/repo/main",
      "opencode://new-session?directory=/repo/next&prompt=ship",
    ])).toEqual([{ directory: "/repo/next", prompt: "ship" }])
  })

  test("carries new-session prompt text in the routed workspace URL", () => {
    const routeFor = (directory: string) => `/w/${encodeURIComponent(directory)}/session`

    expect(newSessionDeepLinkRoute({ directory: "/repo/main" }, routeFor)).toBe("/w/%2Frepo%2Fmain/session")
    expect(newSessionDeepLinkRoute({ directory: "/repo/main", prompt: "  ship it  " }, routeFor)).toBe(
      "/w/%2Frepo%2Fmain/session?prompt=ship%20it",
    )
    expect(newSessionDeepLinkRoute({ directory: "/repo/main", prompt: "line one\nline two & more" }, routeFor)).toBe(
      "/w/%2Frepo%2Fmain/session?prompt=line%20one%0Aline%20two%20%26%20more",
    )
  })

  test("drains pending window deep links exactly once", () => {
    const target = {
      __OPENCODE__: {
        deepLinks: ["opencode://open-project?directory=/repo/main"],
      },
    } as Window & { __OPENCODE__: { deepLinks: string[] } }

    expect(drainPendingDeepLinks(target)).toEqual(["opencode://open-project?directory=/repo/main"])
    expect(target.__OPENCODE__.deepLinks).toEqual([])
    expect(drainPendingDeepLinks(target)).toEqual([])
  })

  test("keeps the desktop event name stable", () => {
    expect(deepLinkEvent).toBe("opencode:deep-link")
  })
})
