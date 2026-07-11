import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "./query-client"
import { queryKeys } from "./keys"
import {
  appendSessionListPageQueryData,
  reconcileArchivedSessionListQueryData,
  sessionListRequest,
  sessionListQueryOptions,
  type SessionListResponse,
} from "./session-list"
import { authFetch } from "@/shared/data/api"

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
  test("uses unsigned fetch for loopback session-list requests by default", () => {
    const request = async () => new Response("{}")

    expect(sessionListRequest({ baseUrl: "http://127.0.0.1:3001" })).toBe(globalThis.fetch)
    expect(sessionListRequest({ baseUrl: "http://localhost:3001" })).toBe(globalThis.fetch)
    expect(sessionListRequest({ baseUrl: "https://control.example.test" })).toBe(authFetch)
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
})
