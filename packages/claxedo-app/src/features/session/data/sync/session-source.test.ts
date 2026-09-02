import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { upsertCreatedSessionListRow, type SessionListQuery, type SessionListResponse } from "../query/session-list"
import {
  centralSessionSource,
  sessionRowDirectory,
  sessionSourceForWorkspace,
  sessionSourceQueryOptions,
} from "./session-source"

/** The path a user-hosted runtime reports for itself — another machine's. */
const HOST_DIR = "/Users/host/repo"

const CONTROL = "https://control.test"

function railQuery(overrides: Partial<SessionListQuery> = {}): SessionListQuery {
  return {
    scope: "workspace",
    workspaceId: "ws_1",
    directory: "workspace:ws_1",
    groupBy: "none",
    archived: "active",
    status: [],
    environment: [],
    git: [],
    sort: "updated_desc",
    limit: 20,
    ...overrides,
  } as SessionListQuery
}

/**
 * Every request the app makes while the source answers, so a test can assert
 * both what was reached and — the point of the change — what was not.
 */
function recordingFetch(routes: Record<string, () => Response>) {
  const requested: string[] = []
  const request: typeof fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input)
    requested.push(url)
    for (const [prefix, respond] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return respond()
    }
    return new Response("not found", { status: 404 })
  }
  return { requested, request }
}

function relayConnection() {
  return Response.json({
    access: "user-hosted",
    backing: "local-worktree",
    workspaceId: "ws_1",
    role: "viewer",
    relayUrl: "https://relay.test",
    runtimeAccessToken: "runtime-token",
    tokenExpiresAt: Date.now() + 10 * 60_000,
  })
}

afterEach(() => {
  queryClient.clear()
})

describe("sessionSourceForWorkspace", () => {
  test("chooses the source from the catalog kind and nothing else", () => {
    expect(sessionSourceForWorkspace({ kind: "local", workspaceId: "/repo" })).toEqual({ kind: "local" })
    expect(sessionSourceForWorkspace({ kind: "cloud", workspaceId: "ws_c" })).toEqual({ kind: "cloud" })
    expect(sessionSourceForWorkspace({ kind: "user-hosted", workspaceId: "ws_1", projectId: "prj_1" }))
      .toEqual({ kind: "user-hosted", workspaceId: "ws_1", projectId: "prj_1" })
    // No kind is not a relay-backed workspace: the app's own central answers.
    expect(sessionSourceForWorkspace({ kind: undefined, workspaceId: "/repo" })).toEqual({ kind: "local" })
  })

  test("Global Chat and the central server share one source", () => {
    expect(centralSessionSource({ local: true })).toEqual({ kind: "local" })
    expect(centralSessionSource({ local: false })).toEqual({ kind: "cloud" })
  })
})

describe("sessionRowDirectory", () => {
  test("only a local row carries the producing host's filesystem path", () => {
    // Local: the host IS this machine, so its path is an address the app reads.
    expect(sessionRowDirectory({ workspaceId: undefined, hostDirectory: "/repo" })).toBe("/repo")
    // User-hosted: the path names the user's own laptop, reachable only by id.
    expect(sessionRowDirectory({ workspaceId: "ws_1", hostDirectory: HOST_DIR })).toBe("workspace:ws_1")
    // Cloud: the path names the sandbox's own root, reachable only by id.
    expect(sessionRowDirectory({ workspaceId: "ws_cloud", hostDirectory: "/workspace" })).toBe("workspace:ws_cloud")
  })
})

describe("a user-hosted workspace's list", () => {
  test("is served by the workspace runtime over the relay, never by the control plane", async () => {
    const { requested, request } = recordingFetch({
      [`${CONTROL}/api/workspace/ws_1/connection`]: relayConnection,
      "https://relay.test/workspaces/ws_1/session": () => Response.json([
        { id: "ses_new", title: "created on the laptop", directory: HOST_DIR, time: { created: 10, updated: 40 } },
        { id: "ses_old", title: "older", directory: HOST_DIR, time: { created: 1, updated: 2 } },
        { id: "ses_archived", title: "archived", directory: HOST_DIR, time: { created: 1, updated: 3, archived: 5 } },
        { nope: true },
      ]),
    })

    const page = await sessionSourceQueryOptions({
      baseUrl: CONTROL,
      source: { kind: "user-hosted", workspaceId: "ws_1", projectId: "prj_1" },
      query: railQuery(),
      request,
    }).queryFn!({} as never) as SessionListResponse

    expect(requested.some((url) => url.includes("/api/control/session-list"))).toBe(false)
    expect(requested.some((url) => url.includes("/api/control/sessions"))).toBe(false)
    expect(requested).toContain("https://relay.test/workspaces/ws_1/session?roots=true")
    expect(page.items?.map((item) => item.sessionId)).toEqual(["ses_new", "ses_old"])
    expect(page.items?.[0]).toMatchObject({
      sessionRef: "workspace:ws_1:session:ses_new",
      workspaceId: "ws_1",
      projectId: "prj_1",
      // The HOST's own filesystem path never becomes the row's directory.
      directory: "workspace:ws_1",
      updatedAt: 40,
    })
    expect(page.totalKnown).toBe(2)
  })

  test("one relay hop answers the section and its next page", async () => {
    const { requested, request } = recordingFetch({
      [`${CONTROL}/api/workspace/ws_1/connection`]: relayConnection,
      "https://relay.test/workspaces/ws_1/session": () => Response.json(
        Array.from({ length: 3 }, (_, index) => ({
          id: `ses_${index}`,
          title: `session ${index}`,
          time: { created: index, updated: 30 - index },
        })),
      ),
    })
    const source = { kind: "user-hosted" as const, workspaceId: "ws_1" }
    const first = await sessionSourceQueryOptions({
      baseUrl: CONTROL, source, query: railQuery({ limit: 2 }), request,
    }).queryFn!({} as never) as SessionListResponse

    expect(first.items?.map((item) => item.sessionId)).toEqual(["ses_0", "ses_1"])
    expect(first.nextCursor).toBe("2")

    const second = await sessionSourceQueryOptions({
      baseUrl: CONTROL, source, query: railQuery({ limit: 2, cursor: first.nextCursor }), request,
    }).queryFn!({} as never) as SessionListResponse

    expect(second.items?.map((item) => item.sessionId)).toEqual(["ses_2"])
    expect(second.nextCursor).toBeUndefined()
    expect(requested.filter((url) => url.startsWith("https://relay.test"))).toHaveLength(1)
  })

  test("a session.created event on the workspace's stream adds the row with no list request", async () => {
    const { requested, request } = recordingFetch({
      [`${CONTROL}/api/workspace/ws_1/connection`]: relayConnection,
      "https://relay.test/workspaces/ws_1/session": () => Response.json([
        { id: "ses_old", title: "older", directory: HOST_DIR, time: { created: 1, updated: 2 } },
      ]),
    })
    const query = railQuery()
    const options = sessionSourceQueryOptions({
      baseUrl: CONTROL,
      source: { kind: "user-hosted", workspaceId: "ws_1", projectId: "prj_1" },
      query,
      request,
    })
    queryClient.setQueryData(options.queryKey, await options.queryFn!({} as never))
    const before = requested.length

    // What `event-ingress` applies when the host's stream reports a session
    // created on the machine itself: the runtime names its OWN filesystem path
    // in `info.directory` and the frame's signed `ws_*` id, and the row's
    // directory comes from `sessionRowDirectory` — the same owner the fetched
    // rows above went through.
    upsertCreatedSessionListRow({
      baseUrl: CONTROL,
      row: {
        sessionId: "ses_live",
        title: "created on the laptop",
        directory: sessionRowDirectory({ workspaceId: "ws_1", hostDirectory: HOST_DIR }),
        projectId: "prj_1",
        workspaceId: "ws_1",
        createdAt: 100,
        updatedAt: 100,
      },
    })

    const items = queryClient.getQueryData<SessionListResponse>(options.queryKey)?.items
    expect(items?.map((item) => item.sessionId)).toEqual(["ses_live", "ses_old"])
    // The live row and the fetched rows address the same workspace, so every
    // later read scoped by either one reaches the host over the relay.
    expect(items?.map((item) => item.directory)).toEqual(["workspace:ws_1", "workspace:ws_1"])
    expect(requested).toHaveLength(before)
  })
})

describe("a cloud workspace's list", () => {
  test("is served by the control plane's registry", async () => {
    const { requested, request } = recordingFetch({
      [`${CONTROL}/api/control/session-list`]: () => Response.json({
        view: { scope: "workspace", groupBy: "none", sort: "updated_desc", limit: 20 },
        items: [],
        totalKnown: 0,
      }),
    })

    await sessionSourceQueryOptions({
      baseUrl: CONTROL,
      source: { kind: "cloud" },
      query: railQuery({ workspaceId: "ws_cloud" }),
      request,
    }).queryFn!({} as never)

    expect(requested.some((url) => url.includes("/api/control/session-list"))).toBe(true)
    expect(requested.some((url) => url.startsWith("https://relay.test"))).toBe(false)
    expect(queryClient.getQueryData(queryKeys.runtime.workspaceSessions(CONTROL, "ws_cloud"))).toBeUndefined()
  })
})
