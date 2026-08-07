import { describe, expect, test } from "bun:test"
import {
  routeBridgeClaxedoSessionMetaUrl,
  routeBridgeSessionConfigUrl,
  routeBridgeSessionMessagesProbeUrl,
  routeKnownSessionDirectory,
  routeSessionMetaIsCentral,
  routeSessionDirectory,
} from "./route-bridge-resolution"

const SERVER = "http://localhost:3001"

describe("routeSessionDirectory", () => {
  test("returns the cache directory when no session directory is known", () => {
    expect(routeSessionDirectory(undefined, "/repo")).toBe("/repo")
  })

  test("collapses to the cache directory when both name the same workspace", () => {
    expect(routeSessionDirectory("/repo", "/repo")).toBe("/repo")
  })

  test("keeps the session directory when it names a different workspace", () => {
    expect(routeSessionDirectory("/other/project", "/repo")).toBe("/other/project")
  })
})

describe("routeSessionMetaIsCentral", () => {
  test("recognizes explicit host and serialized central identity", () => {
    expect(routeSessionMetaIsCentral({ host: "central", workspaceID: "ws_1" })).toBe(true)
    expect(routeSessionMetaIsCentral({ sessionRef: "central:ses_1" })).toBe(true)
    expect(routeSessionMetaIsCentral({ session_ref: "central:ses_1" })).toBe(true)
  })

  test("does not reclassify workspace metadata", () => {
    expect(routeSessionMetaIsCentral({ host: "workspace", sessionRef: "workspace:ws_1:session:ses_1" })).toBe(false)
  })
})

describe("routeKnownSessionDirectory", () => {
  test("is undefined when there is no session directory", () => {
    expect(routeKnownSessionDirectory(undefined, ["/repo"])).toBeUndefined()
  })

  test("returns the matching cache directory when one names the same workspace", () => {
    expect(routeKnownSessionDirectory("/repo", ["/a", "/repo", "/b"])).toBe("/repo")
  })

  test("falls back to the session directory when no cache directory matches", () => {
    expect(routeKnownSessionDirectory("/repo", ["/a", "/b"])).toBe("/repo")
  })
})

describe("session probe URL builders", () => {
  test("messages probe URL targets the session message endpoint scoped to the directory with limit 1", () => {
    const url = routeBridgeSessionMessagesProbeUrl({
      serverUrl: SERVER,
      sessionID: "ses_1",
      workspaceDirectory: "/repo",
    })
    expect(url.pathname).toBe("/session/ses_1/message")
    expect(url.searchParams.get("directory")).toBe("/repo")
    expect(url.searchParams.get("limit")).toBe("1")
  })

  test("claxedo session meta URL targets the meta endpoint", () => {
    const url = routeBridgeClaxedoSessionMetaUrl({ serverUrl: SERVER, sessionID: "ses_1" })
    expect(url.pathname).toBe("/api/claxedo/session/ses_1/meta")
  })

  test("session config URL targets the config endpoint scoped to the directory", () => {
    const url = routeBridgeSessionConfigUrl({
      serverUrl: SERVER,
      sessionID: "ses_1",
      workspaceDirectory: "/repo",
    })
    expect(url.pathname).toBe("/session/ses_1/config")
    expect(url.searchParams.get("directory")).toBe("/repo")
  })

  test("session ids are percent-encoded into the path", () => {
    const url = routeBridgeClaxedoSessionMetaUrl({ serverUrl: SERVER, sessionID: "ses/weird id" })
    expect(url.pathname).toBe("/api/claxedo/session/ses%2Fweird%20id/meta")
  })
})
