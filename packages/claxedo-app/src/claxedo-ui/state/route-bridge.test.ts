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

describe("route bridge URLs", () => {
  test("keeps stable session metadata and messages probe URL building local", async () => {
    const source = await Bun.file(new URL("./route-bridge.tsx", import.meta.url)).text()

    expect(source).not.toContain("RuntimeGateway")
    expect(source).toMatch(/function routeBridgeServerUrl\(serverUrl: string \| undefined\)/)
    expect(source).toMatch(/normalizeUrl\(serverUrl\) \?\? getClaxedoServerUrl\(\)/)
    expect(source).toMatch(/function routeBridgeSessionMessagesProbeUrl/)
    expect(source).toMatch(/`\/session\/\$\{encodeURIComponent\(input\.sessionID\)\}\/message`/)
    expect(source).toMatch(/url\.searchParams\.set\("directory", input\.workspaceDirectory\)/)
    expect(source).toMatch(/url\.searchParams\.set\("limit", "1"\)/)
    expect(source).toMatch(/function routeBridgeClaxedoSessionMetaUrl/)
    expect(source).toMatch(/`\/api\/claxedo\/session\/\$\{encodeURIComponent\(input\.sessionID\)\}\/meta`/)
  })
})

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

  test("keeps the route bridge wired to preserve new-session prompt text", async () => {
    const source = await Bun.file(new URL("./route-bridge.tsx", import.meta.url)).text()

    expect(source).toContain("newSessionDeepLinkRoute(link, workspaceSessionRoute)")
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
