import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import {
  reconcileUpdatedSessionListQueryData,
  upsertCreatedSessionListRow,
  type SessionListQuery,
  type SessionListResponse,
} from "../query/session-list"
import {
  centralSessionSource,
  projectSessionSource,
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

describe("a re-prompted session's place in the list", () => {
  test("a user-hosted row whose updatedAt moves is re-sorted to the top of its own section", async () => {
    const { request } = recordingFetch({
      [`${CONTROL}/api/workspace/ws_1/connection`]: relayConnection,
      "https://relay.test/workspaces/ws_1/session": () => Response.json([
        { id: "ses_new", title: "newer", directory: HOST_DIR, time: { created: 2, updated: 40 } },
        { id: "ses_old", title: "older", directory: HOST_DIR, time: { created: 1, updated: 2 } },
      ]),
    })
    const options = sessionSourceQueryOptions({
      baseUrl: CONTROL,
      source: { kind: "user-hosted", workspaceId: "ws_1", projectId: "prj_1" },
      query: railQuery(),
      request,
    })
    queryClient.setQueryData(options.queryKey, await options.queryFn!({} as never))
    expect(queryClient.getQueryData<SessionListResponse>(options.queryKey)?.items?.map((item) => item.sessionId))
      .toEqual(["ses_new", "ses_old"])

    // Re-prompting the older session: `bumpExistingSessionRail` writes the new
    // activity time, and the row has to arrive where the rail renders it.
    reconcileUpdatedSessionListQueryData({
      sessionId: "ses_old",
      directory: sessionRowDirectory({ workspaceId: "ws_1", hostDirectory: HOST_DIR }),
      workspaceId: "ws_1",
      updatedAt: 100,
    })

    expect(queryClient.getQueryData<SessionListResponse>(options.queryKey)?.items?.map((item) => item.sessionId))
      .toEqual(["ses_old", "ses_new"])
  })

  test("a central row whose updatedAt moves is re-sorted in a composed project's section", async () => {
    const { request } = recordingFetch({
      [`${CONTROL}/api/control/session-list`]: () => Response.json({
        view: { scope: "project", groupBy: "none", sort: "updated_desc", limit: 20 },
        items: [{
          type: "session",
          sessionRef: "local:/repo/main:session:ses_local",
          sessionId: "ses_local",
          title: "on this machine",
          directory: "/repo/main",
          projectId: "prj_1",
          createdAt: 1,
          updatedAt: 3,
          tags: [],
          attachments: [],
        }],
        totalKnown: 1,
      }),
      [`${CONTROL}/api/workspace/ws_1/connection`]: relayConnection,
      "https://relay.test/workspaces/ws_1/session": () => Response.json([
        { id: "ses_host", title: "on the laptop", directory: HOST_DIR, time: { created: 1, updated: 40 } },
      ]),
    })
    const query: SessionListQuery = railQuery({
      scope: "project",
      projectId: "prj_1",
      workspaceId: undefined,
      directory: undefined,
    })
    const options = sessionSourceQueryOptions({
      baseUrl: CONTROL,
      source: projectSessionSource({
        local: false,
        projectId: "prj_1",
        workspaces: {
          "/repo/main": { id: "/repo/main", kind: "local", directory: "/repo/main" },
          [HOST_DIR]: { id: "ws_1", workspaceId: "ws_1", kind: "user-hosted", directory: HOST_DIR },
        },
      }),
      query,
      request,
    })
    queryClient.setQueryData(options.queryKey, await options.queryFn!({} as never))
    expect(queryClient.getQueryData<SessionListResponse>(options.queryKey)?.items?.map((item) => item.sessionId))
      .toEqual(["ses_host", "ses_local"])

    reconcileUpdatedSessionListQueryData({
      sessionId: "ses_local",
      directory: "/repo/main",
      updatedAt: 100,
    })

    expect(queryClient.getQueryData<SessionListResponse>(options.queryKey)?.items?.map((item) => item.sessionId))
      .toEqual(["ses_local", "ses_host"])
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

/**
 * A project's rail section lists the sessions of ALL its workspaces, and those
 * do not share one server. These pin what the section reads and what it shows,
 * against the catalog rows the control plane actually answers with: a
 * user-hosted workspace is keyed by the HOST's own directory and carries the
 * signed id the app addresses it by.
 */
describe("a project's list", () => {
  const projectQuery = (overrides: Partial<SessionListQuery> = {}): SessionListQuery => railQuery({
    scope: "project",
    projectId: "prj_1",
    workspaceId: undefined,
    directory: undefined,
    ...overrides,
  })

  const catalog = {
    "/repo/main": { id: "/repo/main", kind: "local", directory: "/repo/main" },
    [HOST_DIR]: { id: "ws_1", workspaceId: "ws_1", kind: "user-hosted", directory: HOST_DIR },
  }

  function centralPage(items: unknown[]) {
    return () => Response.json({
      view: { scope: "project", groupBy: "none", sort: "updated_desc", limit: 20 },
      items,
      totalKnown: items.length,
    })
  }

  const localRow = {
    type: "session",
    sessionRef: "local:/repo/main:session:ses_local",
    sessionId: "ses_local",
    title: "on this machine",
    directory: "/repo/main",
    projectId: "prj_1",
    createdAt: 5,
    updatedAt: 20,
    tags: [],
    attachments: [],
  }

  test("a project with no user-hosted workspace reads the central server alone", () => {
    expect(projectSessionSource({
      local: false,
      projectId: "prj_1",
      workspaces: { "/repo/main": catalog["/repo/main"] },
    })).toEqual({ kind: "cloud" })
    expect(projectSessionSource({ local: true, projectId: "prj_1", workspaces: undefined }))
      .toEqual({ kind: "local" })
  })

  test("every ref the catalog keys one workspace under is still one source", () => {
    expect(projectSessionSource({
      local: false,
      projectId: "prj_1",
      workspaces: {
        [HOST_DIR]: catalog[HOST_DIR],
        "ws_1": { id: "ws_1", workspaceId: "ws_1", kind: "user-hosted" },
      },
    })).toEqual({
      kind: "composed",
      central: { kind: "cloud" },
      userHosted: [{ kind: "user-hosted", workspaceId: "ws_1", projectId: "prj_1" }],
    })
  })

  test("lists the central server's rows beside the user-hosted workspace's own runtime rows", async () => {
    const { requested, request } = recordingFetch({
      [`${CONTROL}/api/control/session-list`]: centralPage([localRow]),
      [`${CONTROL}/api/workspace/ws_1/connection`]: relayConnection,
      "https://relay.test/workspaces/ws_1/session": () => Response.json([
        { id: "ses_host", title: "on the laptop", directory: HOST_DIR, time: { created: 1, updated: 40 } },
      ]),
    })
    const query = projectQuery()

    const page = await sessionSourceQueryOptions({
      baseUrl: CONTROL,
      source: projectSessionSource({ local: false, projectId: "prj_1", workspaces: catalog }),
      query,
      request,
    }).queryFn!({} as never) as SessionListResponse

    // Both servers answered the SAME section, and the view's ordering is
    // applied across the union rather than per member.
    expect(requested.some((url) => url.includes("/api/control/session-list"))).toBe(true)
    expect(requested).toContain("https://relay.test/workspaces/ws_1/session?roots=true")
    expect(page.items?.map((item) => item.sessionId)).toEqual(["ses_host", "ses_local"])
    expect(page.totalKnown).toBe(2)
    // The runtime's row keeps the identity `sessionRowDirectory` gave it, so a
    // later read of it is scoped by the workspace and reaches the host.
    expect(page.items?.[0]).toMatchObject({
      sessionRef: "workspace:ws_1:session:ses_host",
      directory: "workspace:ws_1",
      workspaceId: "ws_1",
      projectId: "prj_1",
    })
  })

  test("a user-hosted-only project lists the relay's rows even though the central server has none", async () => {
    const { request } = recordingFetch({
      [`${CONTROL}/api/control/session-list`]: centralPage([]),
      [`${CONTROL}/api/workspace/ws_1/connection`]: relayConnection,
      "https://relay.test/workspaces/ws_1/session": () => Response.json([
        { id: "ses_host", title: "on the laptop", directory: HOST_DIR, time: { created: 1, updated: 40 } },
        { id: "ses_older", title: "older", directory: HOST_DIR, time: { created: 1, updated: 2 } },
      ]),
    })

    const page = await sessionSourceQueryOptions({
      baseUrl: CONTROL,
      source: projectSessionSource({
        local: false,
        projectId: "prj_1",
        workspaces: { [HOST_DIR]: catalog[HOST_DIR] },
      }),
      query: projectQuery(),
      request,
    }).queryFn!({} as never) as SessionListResponse

    expect(page.items?.map((item) => item.sessionId)).toEqual(["ses_host", "ses_older"])
    expect(page.totalKnown).toBe(2)
  })

  test("one session named by both servers is listed once, as the runtime that owns it reported it", async () => {
    const { request } = recordingFetch({
      [`${CONTROL}/api/control/session-list`]: centralPage([{
        ...localRow,
        sessionRef: "workspace:ws_1:session:ses_host",
        sessionId: "ses_host",
        title: "registry copy",
        directory: "workspace:ws_1",
        workspaceId: "ws_1",
      }]),
      [`${CONTROL}/api/workspace/ws_1/connection`]: relayConnection,
      "https://relay.test/workspaces/ws_1/session": () => Response.json([
        { id: "ses_host", title: "runtime copy", directory: HOST_DIR, time: { created: 1, updated: 40 } },
      ]),
    })

    const page = await sessionSourceQueryOptions({
      baseUrl: CONTROL,
      source: projectSessionSource({ local: false, projectId: "prj_1", workspaces: catalog }),
      query: projectQuery(),
      request,
    }).queryFn!({} as never) as SessionListResponse

    expect(page.items?.map((item) => item.title)).toEqual(["runtime copy"])
  })

  test("each member pages on its own cursor and the section's next page asks only those that have one", async () => {
    let centralPages = 0
    const { requested, request } = recordingFetch({
      [`${CONTROL}/api/control/session-list`]: () => {
        centralPages += 1
        return Response.json({
          view: { scope: "project", groupBy: "none", sort: "updated_desc", limit: 1 },
          items: [{ ...localRow, sessionId: `ses_local_${centralPages}`, sessionRef: `local:/repo/main:session:ses_local_${centralPages}` }],
          totalKnown: 2,
          ...(centralPages === 1 ? { nextCursor: "central-2" } : {}),
        })
      },
      [`${CONTROL}/api/workspace/ws_1/connection`]: relayConnection,
      "https://relay.test/workspaces/ws_1/session": () => Response.json([
        { id: "ses_host_a", title: "a", directory: HOST_DIR, time: { created: 1, updated: 40 } },
        { id: "ses_host_b", title: "b", directory: HOST_DIR, time: { created: 1, updated: 30 } },
      ]),
    })
    const source = projectSessionSource({ local: false, projectId: "prj_1", workspaces: catalog })

    const first = await sessionSourceQueryOptions({
      baseUrl: CONTROL, source, query: projectQuery({ limit: 1 }), request,
    }).queryFn!({} as never) as SessionListResponse

    expect(first.items?.map((item) => item.sessionId)).toEqual(["ses_host_a", "ses_local_1"])
    expect(first.nextCursor).toBeDefined()

    const second = await sessionSourceQueryOptions({
      baseUrl: CONTROL, source, query: projectQuery({ limit: 1, cursor: first.nextCursor }), request,
    }).queryFn!({} as never) as SessionListResponse

    expect(second.items?.map((item) => item.sessionId)).toEqual(["ses_host_b", "ses_local_2"])
    expect(second.nextCursor).toBeUndefined()
    // The runtime answered both pages from the one list it already handed over.
    expect(requested.filter((url) => url.startsWith("https://relay.test/workspaces"))).toHaveLength(1)
    expect(requested.filter((url) => url.includes("cursor=central-2"))).toHaveLength(1)
  })

  test("an unreachable workspace fails the section rather than reading as an empty one", async () => {
    const { request } = recordingFetch({
      [`${CONTROL}/api/control/session-list`]: centralPage([localRow]),
      [`${CONTROL}/api/workspace/ws_1/connection`]: () => new Response("host offline", { status: 503 }),
    })

    await expect(sessionSourceQueryOptions({
      baseUrl: CONTROL,
      source: projectSessionSource({ local: false, projectId: "prj_1", workspaces: catalog }),
      query: projectQuery(),
      request,
    }).queryFn!({} as never)).rejects.toThrow()
  })

  test("a session.lifecycle row for the user-hosted workspace lands in the project's list", async () => {
    const { request } = recordingFetch({
      [`${CONTROL}/api/control/session-list`]: centralPage([localRow]),
      [`${CONTROL}/api/workspace/ws_1/connection`]: relayConnection,
      "https://relay.test/workspaces/ws_1/session": () => Response.json([
        { id: "ses_host", title: "on the laptop", directory: HOST_DIR, time: { created: 1, updated: 40 } },
      ]),
    })
    const options = sessionSourceQueryOptions({
      baseUrl: CONTROL,
      source: projectSessionSource({ local: false, projectId: "prj_1", workspaces: catalog }),
      query: projectQuery(),
      request,
    })
    queryClient.setQueryData(options.queryKey, await options.queryFn!({} as never))

    // What `event-ingress` applies for a session created on the host: the
    // runtime names its own path and the signed id, and the host's project id
    // is not the control plane's — the row is placed by the sibling the
    // composed list already holds for that workspace.
    upsertCreatedSessionListRow({
      baseUrl: CONTROL,
      row: {
        sessionId: "ses_live",
        title: "created on the laptop",
        directory: sessionRowDirectory({ workspaceId: "ws_1", hostDirectory: HOST_DIR }),
        workspaceId: "ws_1",
        createdAt: 100,
        updatedAt: 100,
      },
    })

    expect(queryClient.getQueryData<SessionListResponse>(options.queryKey)?.items?.map((item) => item.sessionId))
      .toEqual(["ses_live", "ses_host", "ses_local"])
  })
})
