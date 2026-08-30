import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import {
  appendSessionListPageQueryData,
  reconcileArchivedSessionListQueryData,
  removeSessionListQueryData,
  reconcileUpdatedSessionListQueryData,
  sessionListRequest,
  sessionListQueryOptions,
  upsertCreatedSessionListRow,
  type SessionListResponse,
} from "./session-list"

const response = (): SessionListResponse => ({
  view: {
    scope: "workspace",
    groupBy: "none",
    sort: "updated_desc",
    limit: 2,
  },
  items: [
    {
      type: "session",
      sessionRef: "workspace:ws_1:session:ses_1",
      sessionId: "ses_1",
      title: "One",
      directory: "/repo",
      workspaceId: "ws_1",
      createdAt: 1,
      updatedAt: 3,
      tags: [],
      attachments: [],
    },
    {
      type: "session",
      sessionRef: "workspace:ws_1:session:ses_2",
      sessionId: "ses_2",
      title: "Two",
      directory: "/repo",
      workspaceId: "ws_1",
      createdAt: 1,
      updatedAt: 2,
      tags: [],
      attachments: [],
    },
  ],
  nextCursor: "cursor_after_ses_2",
  totalKnown: 3,
})

const row = (id: string, updatedAt: number): NonNullable<SessionListResponse["items"]>[number] => ({
  type: "session",
  sessionRef: `workspace:ws_1:session:${id}`,
  sessionId: id,
  title: id,
  directory: "/repo",
  workspaceId: "ws_1",
  createdAt: 1,
  updatedAt,
  tags: [],
  attachments: [],
})

afterEach(() => {
  queryClient.clear()
})

describe("session list query cache", () => {
  test("uses the control-plane AccountPort adapter (or an injected request) for session-list", () => {
    const request = async () => new Response("{}")

    // Default transport is the dual-path adapter (AccountPort when the Electron
    // bridge is present; authFetch otherwise) — never a bare caller-chosen URL.
    expect(typeof sessionListRequest({ baseUrl: "http://127.0.0.1:3001" })).toBe("function")
    expect(typeof sessionListRequest({ baseUrl: "https://control.example.test" })).toBe("function")
    expect(sessionListRequest({ baseUrl: "http://127.0.0.1:3001", request })).toBe(request)
  })

  test("marks scoped session-list requests with the workspace directory header", async () => {
    const calls: Array<{ url: string; headers: Headers }> = []
    await queryClient.fetchQuery(sessionListQueryOptions({
      baseUrl: "http://test.local",
      query: {
        scope: "workspace",
        workspaceId: "ws_1",
        directory: "/repo",
        limit: 2,
      },
      request: async (input, init) => {
        calls.push({ url: String(input), headers: new Headers(init?.headers) })
        return new Response(JSON.stringify(response()))
      },
    }))

    expect(calls[0]?.url).toBe("http://test.local/api/control/session-list?scope=workspace&limit=2&workspaceId=ws_1&directory=%2Frepo")
    expect(calls[0]?.headers.get("accept")).toBe("application/json")
    expect(calls[0]?.headers.get("x-opencode-directory")).toBe("/repo")
  })

  test("uses the local product session-list route for loopback rail queries", async () => {
    const calls: string[] = []
    await queryClient.fetchQuery(sessionListQueryOptions({
      baseUrl: "http://127.0.0.1:3001",
      query: {
        scope: "workspace",
        directory: "/repo",
        limit: 2,
      },
      request: async (input) => {
        calls.push(String(input))
        return new Response(JSON.stringify(response()))
      },
    }))

    expect(calls).toEqual([
      "http://127.0.0.1:3001/api/claxedo/session-list?scope=workspace&limit=2&directory=%2Frepo",
    ])
  })

  test("preserves the control session navigation list URL shape", async () => {
    const calls: string[] = []
    await queryClient.fetchQuery(sessionListQueryOptions({
      baseUrl: " http://test.local/ ",
      query: {
        scope: "global",
        projectId: "proj_1",
        workspaceId: "ws_1",
        directory: "/repo",
        groupBy: "workspace",
        archived: "archived",
        status: ["running", "idle"],
        environment: ["prod"],
        git: ["dirty", "clean"],
        search: "hello world",
        limit: 50,
        cursor: "cursor:1",
      },
      request: async (input) => {
        calls.push(String(input))
        return new Response(JSON.stringify(response()))
      },
    }))

    expect(calls[0]).toBe("http://test.local/api/control/session-list?scope=global&limit=50&projectId=proj_1&workspaceId=ws_1&directory=%2Frepo&groupBy=workspace&archived=archived&status=running%2Cidle&environment=prod&git=dirty%2Cclean&search=hello+world&cursor=cursor%3A1")
  })

  test("marks project-scoped workspace projects with a workspace directory header", async () => {
    const calls: Array<{ headers: Headers }> = []
    await queryClient.fetchQuery(sessionListQueryOptions({
      baseUrl: "http://test.local",
      query: {
        scope: "project",
        projectId: "ws_1",
        limit: 2,
      },
      request: async (_input, init) => {
        calls.push({ headers: new Headers(init?.headers) })
        return new Response(JSON.stringify(response()))
      },
    }))

    expect(calls[0]?.headers.get("x-opencode-directory")).toBe("workspace:ws_1")
  })

  test("removes archived rows from active pages without resetting cursor state", () => {
    const key = queryKeys.shell.sessionList("https://control.example.test", {
      scope: "workspace",
      limit: 2,
      workspaceId: "ws_1",
      archived: "active",
    })
    queryClient.setQueryData(key, response())

    reconcileArchivedSessionListQueryData({
      baseUrl: "https://control.example.test",
      sessionRef: "workspace:ws_1:session:ses_1",
      sessionId: "ses_1",
      directory: "/repo",
      workspaceId: "ws_1",
      archivedAt: 10,
    })

    expect(queryClient.getQueryData<SessionListResponse>(key)).toMatchObject({
      items: [{ sessionId: "ses_2" }],
      nextCursor: "cursor_after_ses_2",
      totalKnown: 2,
    })
  })

  test("marks archived rows in all pages without shrinking the loaded window", () => {
    const key = queryKeys.shell.sessionList(undefined, {
      scope: "workspace",
      limit: 2,
      workspaceId: "ws_1",
      archived: "all",
    })
    queryClient.setQueryData(key, response())

    reconcileArchivedSessionListQueryData({
      sessionRef: "workspace:ws_1:session:ses_1",
      sessionId: "ses_1",
      directory: "/repo",
      workspaceId: "ws_1",
      archivedAt: 10,
    })

    expect(queryClient.getQueryData<SessionListResponse>(key)).toMatchObject({
      items: [
        { sessionId: "ses_1", archivedAt: 10 },
        { sessionId: "ses_2" },
      ],
      nextCursor: "cursor_after_ses_2",
      totalKnown: 3,
    })
  })

  test("does not patch rows that only share the bare session id", () => {
    const key = queryKeys.shell.sessionList(undefined, {
      scope: "global",
      limit: 2,
      archived: "all",
    })
    queryClient.setQueryData(key, {
      ...response(),
      items: [
        {
          ...response().items![0],
          sessionRef: "workspace:ws_1:session:shared",
          sessionId: "shared",
          workspaceId: "ws_1",
        },
        {
          ...response().items![1],
          sessionRef: "workspace:ws_2:session:shared",
          sessionId: "shared",
          workspaceId: "ws_2",
        },
      ],
    })

    reconcileArchivedSessionListQueryData({
      sessionRef: "workspace:ws_2:session:shared",
      sessionId: "shared",
      directory: "/repo",
      workspaceId: "ws_2",
      archivedAt: 10,
    })

    expect(queryClient.getQueryData<SessionListResponse>(key)?.items?.map((item) => ({
      sessionRef: item.sessionRef,
      archivedAt: item.archivedAt,
    }))).toEqual([
      { sessionRef: "workspace:ws_1:session:shared", archivedAt: undefined },
      { sessionRef: "workspace:ws_2:session:shared", archivedAt: 10 },
    ])
  })

  test("removes a missing session from flat and grouped pages without resetting pagination", () => {
    const key = queryKeys.shell.sessionList("https://control.example.test", {
      scope: "workspace",
      workspaceId: "ws_1",
      archived: "active",
      limit: 2,
    })
    queryClient.setQueryData<SessionListResponse>(key, {
      ...response(),
      groups: [{
        id: "workspace:ws_1",
        label: "Workspace 1",
        items: response().items!,
        nextCursor: "group_cursor",
        totalKnown: 3,
      }],
    })

    removeSessionListQueryData({
      baseUrl: "https://control.example.test",
      sessionId: "ses_1",
      directory: "/repo",
      workspaceId: "ws_1",
    })

    expect(queryClient.getQueryData<SessionListResponse>(key)).toMatchObject({
      items: [{ sessionId: "ses_2" }],
      nextCursor: "cursor_after_ses_2",
      totalKnown: 2,
      groups: [{
        items: [{ sessionId: "ses_2" }],
        nextCursor: "group_cursor",
        totalKnown: 2,
      }],
    })
  })

  test("keeps an equal session id in another workspace when removing a missing session", () => {
    const key = queryKeys.shell.sessionList(undefined, {
      scope: "global",
      archived: "active",
      limit: 2,
    })
    queryClient.setQueryData<SessionListResponse>(key, {
      ...response(),
      items: [
        { ...row("shared", 2), workspaceId: "ws_1", directory: "/repo-one" },
        { ...row("shared", 1), sessionRef: "workspace:ws_2:session:shared", workspaceId: "ws_2", directory: "/repo-two" },
      ],
      totalKnown: 2,
    })

    removeSessionListQueryData({
      sessionId: "shared",
      directory: "/repo-two",
      workspaceId: "ws_2",
    })

    expect(queryClient.getQueryData<SessionListResponse>(key)?.items?.map((item) => item.workspaceId)).toEqual(["ws_1"])
    expect(queryClient.getQueryData<SessionListResponse>(key)?.totalKnown).toBe(1)
  })

  test("appends loaded pages into the base query cache", () => {
    const query = {
      scope: "workspace" as const,
      workspaceId: "ws_1",
      directory: "/repo",
      limit: 2,
    }
    const key = queryKeys.shell.sessionList(undefined, query)
    queryClient.setQueryData(key, response())

    const next = appendSessionListPageQueryData({
      query,
      page: {
        ...response(),
        items: [row("ses_2", 2), row("ses_3", 1)],
        nextCursor: undefined,
        totalKnown: 3,
      },
    })

    expect(next.items?.map((item) => item.sessionId)).toEqual(["ses_1", "ses_2", "ses_3"])
    expect(queryClient.getQueryData<SessionListResponse>(key)?.items?.map((item) => item.sessionId))
      .toEqual(["ses_1", "ses_2", "ses_3"])
  })

  test("appending a loaded page replaces the stale first-page nextCursor with that page's own cursor", () => {
    // Regression for the "Load more" button never disappearing: merging in a
    // later page must advance the cache's nextCursor to the newly fetched
    // page's cursor, not keep repeating the very first page's cursor.
    const query = {
      scope: "workspace" as const,
      workspaceId: "ws_1",
      directory: "/repo",
      limit: 2,
    }
    const key = queryKeys.shell.sessionList(undefined, query)
    queryClient.setQueryData(key, response()) // nextCursor: "cursor_after_ses_2"

    const next = appendSessionListPageQueryData({
      query,
      page: {
        ...response(),
        items: [row("ses_3", 1)],
        nextCursor: "cursor_after_ses_3",
        totalKnown: 3,
      },
    })

    expect(next.nextCursor).toBe("cursor_after_ses_3")
    expect(queryClient.getQueryData<SessionListResponse>(key)?.nextCursor).toBe("cursor_after_ses_3")
  })

  test("appending the final page clears nextCursor so Load more stops showing once pages are exhausted", () => {
    const query = {
      scope: "workspace" as const,
      workspaceId: "ws_1",
      directory: "/repo",
      limit: 2,
    }
    const key = queryKeys.shell.sessionList(undefined, query)
    queryClient.setQueryData(key, response()) // nextCursor: "cursor_after_ses_2"

    const next = appendSessionListPageQueryData({
      query,
      page: {
        ...response(),
        items: [row("ses_3", 1)],
        nextCursor: undefined,
        totalKnown: 3,
      },
    })

    expect(next.nextCursor).toBeUndefined()
    expect(queryClient.getQueryData<SessionListResponse>(key)?.nextCursor).toBeUndefined()
  })

  test("does not merge workspace cursor pages into project cache entries", () => {
    const workspaceQuery = {
      scope: "workspace" as const,
      workspaceId: "ws_1",
      directory: "/repo",
      limit: 2,
    }
    const projectQuery = {
      scope: "project" as const,
      projectId: "project_1",
      limit: 2,
    }
    const projectKey = queryKeys.shell.sessionList(undefined, projectQuery)
    queryClient.setQueryData(projectKey, {
      ...response(),
      items: [row("ses_project", 7)],
      nextCursor: "cursor_after_project",
      totalKnown: 2,
    })

    appendSessionListPageQueryData({
      query: workspaceQuery,
      page: {
        ...response(),
        items: [row("ses_workspace", 6)],
        nextCursor: undefined,
        totalKnown: 1,
      },
    })

    expect(queryClient.getQueryData<SessionListResponse>(projectKey)?.items?.map((item) => item.sessionId))
      .toEqual(["ses_project"])
  })

  test("base refetch preserves an already loaded tail instead of collapsing to page one", async () => {
    const query = {
      scope: "workspace" as const,
      workspaceId: "ws_1",
      directory: "/repo",
      limit: 2,
    }
    const key = queryKeys.shell.sessionList("http://test.local", query)
    queryClient.setQueryData<SessionListResponse>(key, {
      ...response(),
      items: [row("ses_1", 5), row("ses_2", 4), row("ses_3", 3)],
      nextCursor: "cursor_after_ses_3",
      totalKnown: 4,
    })

    const result = await queryClient.fetchQuery(sessionListQueryOptions({
      baseUrl: "http://test.local",
      query,
      request: async () => new Response(JSON.stringify({
        ...response(),
        items: [row("ses_1", 6), row("ses_2", 4)],
        nextCursor: "cursor_after_ses_2",
        totalKnown: 4,
      })),
    }))

    expect(result.items?.map((item) => `${item.sessionId}:${item.updatedAt}`)).toEqual([
      "ses_1:6",
      "ses_2:4",
      "ses_3:3",
    ])
    expect(result.nextCursor).toBe("cursor_after_ses_3")
    expect(queryClient.getQueryData<SessionListResponse>(key)?.items?.map((item) => item.sessionId))
      .toEqual(["ses_1", "ses_2", "ses_3"])
  })

  test("base refetch discards an unprovable cached tail when the authoritative total shrinks", async () => {
    const query = {
      scope: "project" as const,
      projectId: "project_1",
      limit: 2,
    }
    const key = queryKeys.shell.sessionList("http://test.local", query)
    queryClient.setQueryData<SessionListResponse>(key, {
      ...response(),
      view: { ...response().view, scope: "project" },
      items: [row("ses_still_visible", 6), row("ses_revoked", 5), row("ses_tail", 4)],
      nextCursor: "cursor_after_tail",
      totalKnown: 3,
    })

    const result = await queryClient.fetchQuery(sessionListQueryOptions({
      baseUrl: "http://test.local",
      query,
      request: async () => new Response(JSON.stringify({
        ...response(),
        view: { ...response().view, scope: "project" },
        items: [row("ses_still_visible", 6), row("ses_tail", 4)],
        nextCursor: undefined,
        totalKnown: 2,
      })),
    }))

    expect(result.items?.map((item) => item.sessionId)).toEqual(["ses_still_visible", "ses_tail"])
    expect(result.nextCursor).toBeUndefined()
    expect(result.totalKnown).toBe(2)
  })

  test("base refetch keeps a newer lifecycle row ahead of a stale authoritative page", async () => {
    const query = {
      scope: "workspace" as const,
      workspaceId: "ws_1",
      directory: "/repo",
      limit: 2,
    }
    const key = queryKeys.shell.sessionList("http://test.local", query)
    queryClient.setQueryData<SessionListResponse>(key, {
      ...response(),
      items: [row("ses_new", 10), row("ses_1", 5), row("ses_2", 4), row("ses_3", 3)],
      nextCursor: "cursor_after_ses_3",
      totalKnown: 5,
    })

    const result = await queryClient.fetchQuery(sessionListQueryOptions({
      baseUrl: "http://test.local",
      query,
      request: async () => new Response(JSON.stringify({
        ...response(),
        items: [row("ses_1", 6), row("ses_2", 4)],
        nextCursor: "cursor_after_ses_2",
        totalKnown: 5,
      })),
    }))

    expect(result.items?.map((item) => `${item.sessionId}:${item.updatedAt}`)).toEqual([
      "ses_new:10",
      "ses_1:6",
      "ses_2:4",
      "ses_3:3",
    ])
    expect(result.nextCursor).toBe("cursor_after_ses_3")
  })
})

describe("reconcileUpdatedSessionListQueryData", () => {
  test("updated_desc reorders when updatedAt actually changes", () => {
    const key = queryKeys.shell.sessionList(undefined, {
      scope: "workspace",
      workspaceId: "ws_1",
      directory: "/repo",
      limit: 2,
      sort: "updated_desc",
    })
    queryClient.setQueryData(key, {
      ...response(),
      view: { ...response().view, sort: "updated_desc" },
      items: [row("ses_1", 3), row("ses_2", 2)],
    })

    reconcileUpdatedSessionListQueryData({
      sessionId: "ses_2",
      directory: "/repo",
      title: "Two renamed",
      updatedAt: 10,
    })

    expect(queryClient.getQueryData<SessionListResponse>(key)?.items?.map((item) => item.sessionId))
      .toEqual(["ses_2", "ses_1"])
  })

  test("updated_desc does not reorder when updatedAt is unchanged", () => {
    const key = queryKeys.shell.sessionList(undefined, {
      scope: "workspace",
      workspaceId: "ws_1",
      directory: "/repo",
      limit: 2,
      sort: "updated_desc",
    })
    queryClient.setQueryData(key, {
      ...response(),
      view: { ...response().view, sort: "updated_desc" },
      items: [row("ses_1", 3), row("ses_2", 2)],
    })

    reconcileUpdatedSessionListQueryData({
      sessionId: "ses_2",
      directory: "/repo",
      title: "Two renamed",
      updatedAt: 2,
    })

    const items = queryClient.getQueryData<SessionListResponse>(key)?.items
    expect(items?.map((item) => item.sessionId)).toEqual(["ses_1", "ses_2"])
    expect(items?.[1]?.title).toBe("Two renamed")
  })

  test("created_desc keeps visit/update from reshuffling list order", () => {
    const key = queryKeys.shell.sessionList(undefined, {
      scope: "workspace",
      workspaceId: "ws_1",
      directory: "/repo",
      limit: 2,
      sort: "created_desc",
    })
    queryClient.setQueryData(key, {
      ...response(),
      view: { ...response().view, sort: "created_desc" },
      items: [row("ses_1", 3), row("ses_2", 2)],
    })

    reconcileUpdatedSessionListQueryData({
      sessionId: "ses_2",
      directory: "/repo",
      title: "Visited",
      updatedAt: 99,
    })

    const items = queryClient.getQueryData<SessionListResponse>(key)?.items
    expect(items?.map((item) => item.sessionId)).toEqual(["ses_1", "ses_2"])
    expect(items?.[1]?.updatedAt).toBe(99)
    expect(items?.[1]?.title).toBe("Visited")
  })
})

describe("upsertCreatedSessionListRow", () => {
  const key = (query: Parameters<typeof queryKeys.shell.sessionList>[1]) =>
    queryKeys.shell.sessionList("http://test.local", query)
  const newRow = {
    sessionId: "ses_new",
    title: "New",
    directory: "/repo",
    projectId: "proj_1",
    workspaceId: "ws_1",
    createdAt: 4,
    updatedAt: 4,
  }

  test("prepends the created row into matching workspace and project queries, skipping global scope", () => {
    const workspaceKey = key({ scope: "workspace", workspaceId: "ws_1", directory: "/repo", limit: 2 })
    const projectKey = key({ scope: "project", projectId: "proj_1", limit: 2 })
    const globalKey = key({ scope: "global", limit: 2 })
    queryClient.setQueryData(workspaceKey, response())
    queryClient.setQueryData(projectKey, response())
    queryClient.setQueryData(globalKey, response())

    upsertCreatedSessionListRow({ row: newRow })

    const workspace = queryClient.getQueryData<SessionListResponse>(workspaceKey)
    expect(workspace?.items?.[0]?.sessionRef).toBe("workspace:ws_1:session:ses_new")
    expect(workspace?.totalKnown).toBe(4)
    expect(queryClient.getQueryData<SessionListResponse>(projectKey)?.items?.[0]?.sessionId).toBe("ses_new")
    expect(queryClient.getQueryData<SessionListResponse>(globalKey)?.items?.some((item) => item.sessionId === "ses_new")).toBe(false)
  })

  test("matches by directory without workspaceId, dedupes, and skips filtered views", () => {
    const directoryKey = key({ scope: "workspace", directory: "/repo", limit: 2 })
    const filteredKey = key({ scope: "workspace", workspaceId: "ws_1", status: ["running"], limit: 2 })
    const archivedKey = key({ scope: "workspace", workspaceId: "ws_1", archived: "archived", limit: 2 })
    queryClient.setQueryData(directoryKey, response())
    queryClient.setQueryData(filteredKey, response())
    queryClient.setQueryData(archivedKey, response())

    upsertCreatedSessionListRow({ row: newRow })
    upsertCreatedSessionListRow({ row: newRow })

    const items = queryClient.getQueryData<SessionListResponse>(directoryKey)?.items
    expect(items?.filter((item) => item.sessionId === "ses_new")).toHaveLength(1)
    expect(queryClient.getQueryData<SessionListResponse>(filteredKey)?.items?.some((item) => item.sessionId === "ses_new")).toBe(false)
    expect(queryClient.getQueryData<SessionListResponse>(archivedKey)?.items?.some((item) => item.sessionId === "ses_new")).toBe(false)
  })

  test("bootstraps an in-flight query with no cached page yet", async () => {
    const query = { scope: "workspace" as const, workspaceId: "ws_1", directory: "/repo", limit: 2 }
    const workspaceKey = key(query)
    let resolveRequest!: (response: Response) => void
    const request = new Promise<Response>((resolve) => { resolveRequest = resolve })
    const pendingFetch = queryClient.fetchQuery({
      ...sessionListQueryOptions({
        baseUrl: "http://test.local",
        query,
        request: () => request,
      }),
    })

    upsertCreatedSessionListRow({ row: newRow })

    expect(queryClient.getQueryData<SessionListResponse>(workspaceKey)?.items?.[0]?.sessionId).toBe("ses_new")
    expect(queryClient.getQueryData<SessionListResponse>(workspaceKey)?.totalKnown).toBe(1)

    resolveRequest(new Response(JSON.stringify(response())))
    await pendingFetch
  })

  test("adopts project id from a sibling workspace row when create-time upsert omits it", () => {
    const projectKey = key({ scope: "project", projectId: "proj_1", archived: "active", limit: 2 })
    queryClient.setQueryData(projectKey, response())

    upsertCreatedSessionListRow({
      row: {
        sessionId: "ses_live",
        title: "Live",
        directory: "/repo",
        workspaceId: "ws_1",
        createdAt: 5,
        updatedAt: 5,
      },
    })

    expect(queryClient.getQueryData<SessionListResponse>(projectKey)?.items?.[0]).toMatchObject({
      sessionId: "ses_live",
      projectId: "proj_1",
      workspaceId: "ws_1",
    })
  })
})

describe("session list merge + updated reconcile", () => {
  const listKeyFor = (query: Parameters<typeof queryKeys.shell.sessionList>[1]) =>
    queryKeys.shell.sessionList("http://test.local", query)

  test("refetch merge keeps one row when local and workspace refs share a sessionId", async () => {
    const query = { scope: "workspace" as const, directory: "/repo", limit: 5 }
    const listKey = listKeyFor(query)
    queryClient.setQueryData(listKey, {
      view: { scope: "workspace", groupBy: "none", sort: "updated_desc", limit: 5 },
      items: [
        {
          type: "session",
          sessionRef: "local:/repo:session:ses_dup",
          sessionId: "ses_dup",
          title: "Local",
          directory: "/repo",
          createdAt: 1,
          updatedAt: 1,
          tags: [],
          attachments: [],
        },
      ],
    })

    await queryClient.fetchQuery(sessionListQueryOptions({
      baseUrl: "http://test.local",
      query,
      request: async () => new Response(JSON.stringify({
        view: { scope: "workspace", groupBy: "none", sort: "updated_desc", limit: 5 },
        items: [
          {
            type: "session",
            sessionRef: "workspace:assoc-uuid:session:ses_dup",
            sessionId: "ses_dup",
            title: "Workspace",
            directory: "/repo",
            workspaceId: "assoc-uuid",
            createdAt: 1,
            updatedAt: 2,
            tags: [],
            attachments: [],
          },
        ],
      })),
    }))

    const items = queryClient.getQueryData<SessionListResponse>(listKey)?.items
    expect(items).toHaveLength(1)
    expect(items?.[0]?.sessionRef).toBe("workspace:assoc-uuid:session:ses_dup")
  })

  test("reconcile bumps updatedAt and reorders when event directory differs from the row", () => {
    const listKey = listKeyFor({ scope: "workspace", workspaceId: "ws_1", directory: "/repo", limit: 5 })
    queryClient.setQueryData(listKey, {
      view: { scope: "workspace", groupBy: "none", sort: "updated_desc", limit: 5 },
      items: [
        {
          type: "session",
          sessionRef: "workspace:ws_1:session:ses_old",
          sessionId: "ses_old",
          title: "Older activity",
          directory: "/repo",
          workspaceId: "ws_1",
          createdAt: 1,
          updatedAt: 200,
          tags: [],
          attachments: [],
        },
        {
          type: "session",
          sessionRef: "workspace:ws_1:session:ses_target",
          sessionId: "ses_target",
          title: "Target",
          directory: "/repo",
          workspaceId: "ws_1",
          createdAt: 1,
          updatedAt: 100,
          tags: [],
          attachments: [],
        },
      ],
    })

    reconcileUpdatedSessionListQueryData({
      sessionId: "ses_target",
      directory: "workspace:ws_1",
      updatedAt: 300,
    })

    const items = queryClient.getQueryData<SessionListResponse>(listKey)?.items
    expect(items?.map((item) => item.sessionId)).toEqual(["ses_target", "ses_old"])
    expect(items?.[0]?.updatedAt).toBe(300)
  })
})
