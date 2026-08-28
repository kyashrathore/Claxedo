import { describe, expect, test } from "bun:test"
import {
  fetchRouteSessionMeta,
  routeBridgeClaxedoSessionMetaUrl,
  routeBridgeSessionConfigHarness,
  routeBridgeSessionConfigUrl,
  routeBridgeSessionMessagesProbeUrl,
  routeCachedWorkspaceSessionCandidate,
  routeKnownSessionDirectory,
  routeSessionMetaIsArchived,
  routeSessionMetaIsCentral,
  routeSessionDirectory,
  routeLifecycleSessionRef,
  routeCentralSessionRef,
  routeSessionWorkspaceBacking,
  settledWorkspaceSessionRedirect,
} from "./route-bridge-resolution"

const SERVER = "http://localhost:3001"

describe("settledWorkspaceSessionRedirect", () => {
  test("recovers a stale workspace session only from settled successful inventory", () => {
    const input = {
      hash: "#composer",
      isFetching: false,
      isSuccess: true,
      pathname: "/w/%2Fprivate%2Ftmp%2Fworkspace/session/ses_1",
      routeId: undefined,
      search: "?source=reported",
    }

    expect(settledWorkspaceSessionRedirect(input)).toBe(
      "/s/ses_1?source=reported#composer",
    )
    expect(settledWorkspaceSessionRedirect({ ...input, isSuccess: false })).toBeUndefined()
    expect(settledWorkspaceSessionRedirect({ ...input, isFetching: true })).toBeUndefined()
    expect(settledWorkspaceSessionRedirect({ ...input, routeId: "ws-1" })).toBeUndefined()
    expect(settledWorkspaceSessionRedirect({
      ...input,
      pathname: "/w/%2Fprivate%2Ftmp%2Fworkspace/page/page_1",
    })).toBeUndefined()
  })
})

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

describe("routeCachedWorkspaceSessionCandidate", () => {
  test("does not turn an explicitly central cached row into a workspace target", () => {
    expect(routeCachedWorkspaceSessionCandidate("ses_1", [{
      directory: "/repo",
      sessions: [{
        id: "ses_1",
        host: "central",
        sessionRef: "central:ses_1",
      }],
    }])).toBeUndefined()
  })

  test("central identity wins over a duplicate workspace-looking cache row", () => {
    expect(routeCachedWorkspaceSessionCandidate("ses_1", [{
      directory: "/repo-a",
      sessions: [{ id: "ses_1", directory: "/repo-a" }],
    }, {
      directory: "/repo-b",
      sessions: [{ id: "ses_1", host: "central", sessionRef: "central:ses_1" }],
    }])).toBeUndefined()
  })

  test("returns the first active workspace row when no central identity exists", () => {
    expect(routeCachedWorkspaceSessionCandidate("ses_1", [{
      directory: "/repo",
      sessions: [
        { id: "archived", directory: "/repo", time: { archived: 1 } },
        { id: "ses_1", directory: "/repo" },
      ],
    }])).toEqual({
      cacheDirectory: "/repo",
      session: { id: "ses_1", directory: "/repo" },
    })
  })
})

describe("routeSessionMetaIsArchived", () => {
  test("recognizes both projected and runtime archive timestamps", () => {
    expect(routeSessionMetaIsArchived({ archived: 123 })).toBe(true)
    expect(routeSessionMetaIsArchived({ time: { archived: 456 } })).toBe(true)
    expect(routeSessionMetaIsArchived({ archived: null })).toBe(false)
    expect(routeSessionMetaIsArchived({ title: "Active" })).toBe(false)
  })
})

describe("routeSessionWorkspaceBacking", () => {
  const projects = [{
    worktree: "/repo",
    workspaces: {
      ws_signed: {
        workspaceId: "ws_signed",
        directory: "/tmp/signed-workspace",
        kind: "user-hosted",
      },
    },
  }]

  test("returns typed backing for a canonical workspace route id", () => {
    expect(routeSessionWorkspaceBacking({
      projects,
      directory: "/tmp/signed-workspace",
      workspaceId: "ws_signed",
    })).toEqual({ workspaceId: "ws_signed", kind: "user-hosted" })
  })

  test("does not authorize a legacy filesystem route from inventory alone", () => {
    expect(routeSessionWorkspaceBacking({
      projects,
      directory: "/tmp/signed-workspace",
      workspaceId: "/tmp/signed-workspace",
    })).toBeUndefined()
  })
})

describe("routeLifecycleSessionRef", () => {
  test("preserves signed relay authority when the created session reports a new runtime directory", () => {
    expect(routeLifecycleSessionRef({
      projects: [{
        worktree: "/repo",
        workspaces: {
          ws_signed: {
            workspaceId: "ws_signed",
            directory: "/tmp/original-workspace",
            kind: "cloud",
          },
        },
      }],
      sessionId: "ses_created",
      directory: "/runtime/new-session-worktree",
      workspaceId: "ws_signed",
    })).toEqual({
      sessionId: "ses_created",
      host: "workspace",
      workspaceId: "ws_signed",
      toolSandbox: {
        kind: "workspace",
        workspaceId: "ws_signed",
        hosting: "cloud",
      },
    })
  })

  test("retargets an existing draft authority to the created session id", () => {
    expect(routeLifecycleSessionRef({
      projects: [],
      sessionId: "ses_created",
      directory: "/runtime/new-session-worktree",
      draftSessionRef: {
        sessionId: "new",
        host: "workspace",
        workspaceId: "ws_signed",
        toolSandbox: {
          kind: "workspace",
          workspaceId: "ws_signed",
          hosting: "user-hosted",
        },
      },
    })).toEqual({
      sessionId: "ses_created",
      host: "workspace",
      workspaceId: "ws_signed",
      toolSandbox: {
        kind: "workspace",
        workspaceId: "ws_signed",
        hosting: "user-hosted",
      },
    })
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

// Falsifiers for the boot request graph's duplicated /s/:id probes: the two
// resolution paths race for the same session at boot, and each probe must be
// shared while in flight — but a LATER resolution must ask the server again.
describe("session probe single-flight", () => {
  const deferredJson = (body: unknown, calls: string[]) => {
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    const request: typeof fetch = async (resource) => {
      calls.push(String(resource))
      await released
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
    }
    return { request, release }
  }

  test("concurrent meta probes for one session share a single request", async () => {
    const calls: string[] = []
    const { request, release } = deferredJson({ directory: "/repo", title: "One" }, calls)

    const first = fetchRouteSessionMeta({ serverUrl: SERVER, sessionID: "ses_meta_sf", request })
    const second = fetchRouteSessionMeta({ serverUrl: SERVER, sessionID: "ses_meta_sf", request })
    release()
    const [metaA, metaB] = await Promise.all([first, second])

    expect(calls).toHaveLength(1)
    expect(metaA).toEqual({ directory: "/repo", title: "One" })
    expect(metaB).toEqual(metaA)

    // Settled: a later resolution fetches again instead of reusing a stale answer.
    const again = deferredJson({ directory: "/repo", title: "Two" }, calls)
    again.release()
    expect(await fetchRouteSessionMeta({ serverUrl: SERVER, sessionID: "ses_meta_sf", request: again.request })).toEqual({
      directory: "/repo",
      title: "Two",
    })
    expect(calls).toHaveLength(2)
  })

  test("concurrent config probes for one session share a single request", async () => {
    const calls: string[] = []
    const { request, release } = deferredJson({ harness: { id: "codex-acp" } }, calls)

    const input = { serverUrl: SERVER, sessionID: "ses_config_sf", workspaceDirectory: "/repo", request }
    const first = routeBridgeSessionConfigHarness(input)
    const second = routeBridgeSessionConfigHarness(input)
    release()
    const [harnessA, harnessB] = await Promise.all([first, second])

    expect(calls).toHaveLength(1)
    expect(harnessA).toEqual(harnessB)
  })

  test("meta probes for different sessions do not share", async () => {
    const calls: string[] = []
    const { request, release } = deferredJson({ directory: "/repo" }, calls)

    const first = fetchRouteSessionMeta({ serverUrl: SERVER, sessionID: "ses_a_iso", request })
    const second = fetchRouteSessionMeta({ serverUrl: SERVER, sessionID: "ses_b_iso", request })
    release()
    await Promise.all([first, second])

    expect(calls).toHaveLength(2)
  })
})

describe("routeCentralSessionRef", () => {
  test("builds a central identity from inventory workspace and harness fields", () => {
    expect(routeCentralSessionRef("ses_central", {
      workspaceId: "ws_1",
      harness: { id: "pi" },
    })).toMatchObject({
      sessionId: "ses_central",
      host: "central",
      workspaceId: "ws_1",
      harness: { id: "pi" },
    })
  })

  test("reads camel and API workspace id spellings without inventing a harness", () => {
    expect(routeCentralSessionRef("ses_meta", { workspaceID: "ws_api" })).toMatchObject({
      sessionId: "ses_meta",
      host: "central",
      workspaceId: "ws_api",
    })
    expect(routeCentralSessionRef("ses_meta", { workspaceID: "ws_api" })?.harness).toBeUndefined()
  })
})
