import { afterEach, describe, expect, test } from "bun:test"
import type { SessionRef } from "@/platform/identity/session-ref"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import type { SessionListResponse } from "../../data/query/session-list"
import {
  bumpCreatedSessionRail,
  bumpExistingSessionRail,
  resolveCreatedSessionListWorkspaceId,
} from "./submit-rail-workspace"

describe("resolveCreatedSessionListWorkspaceId", () => {
  test("uses signed workspace session refs and ws_* input ids", () => {
    expect(resolveCreatedSessionListWorkspaceId({
      sessionRef: sessionRef("session-1", "ws_1"),
      workspaceId: undefined,
      sessionDirectory: "workspace:ws_1",
    })).toBe("ws_1")
    expect(resolveCreatedSessionListWorkspaceId({
      sessionRef: undefined,
      workspaceId: "ws_cloud",
      sessionDirectory: "/repo",
    })).toBe("ws_cloud")
  })

  test("falls through to route ws_* when workspace host ref has no key", () => {
    expect(resolveCreatedSessionListWorkspaceId({
      sessionRef: {
        sessionId: "session-1",
        host: "workspace",
        cwd: "/repo",
      },
      workspaceId: "ws_route",
      sessionDirectory: "/repo",
    })).toBe("ws_route")
  })

  test("skips local UUID associations so rail rows stay directory-scoped", () => {
    expect(resolveCreatedSessionListWorkspaceId({
      sessionRef: undefined,
      workspaceId: "550e8400-e29b-41d4-a716-446655440000",
      sessionDirectory: "/repo",
    })).toBeUndefined()
    expect(resolveCreatedSessionListWorkspaceId({
      sessionRef: undefined,
      workspaceId: undefined,
      sessionDirectory: "workspace:550e8400-e29b-41d4-a716-446655440000",
    })).toBeUndefined()
  })
})

function sessionRef(sessionId: string, workspaceId: string): SessionRef {
  return {
    sessionId,
    host: "workspace",
    workspaceId,
  }
}

describe("the send is what moves a rail row", () => {
  const key = queryKeys.shell.sessionList(undefined, {
    scope: "workspace",
    workspaceId: "ws_1",
    directory: "/repo",
    limit: 5,
    sort: "human_turn_desc",
  })
  const listed = () => queryClient.getQueryData<SessionListResponse>(key)

  afterEach(() => queryClient.clear())

  const seed = () => queryClient.setQueryData(key, {
    view: { scope: "workspace", groupBy: "none", sort: "human_turn_desc", limit: 5 },
    items: [
      {
        type: "session" as const,
        sessionRef: "workspace:ws_1:session:ses_other",
        sessionId: "ses_other",
        title: "Other",
        directory: "/repo",
        workspaceId: "ws_1",
        createdAt: 1,
        updatedAt: 1,
        lastHumanTurnAt: 1_000_000_000_000,
        tags: [],
        attachments: [],
      },
      {
        type: "session" as const,
        sessionRef: "workspace:ws_1:session:ses_target",
        sessionId: "ses_target",
        title: "Target",
        directory: "/repo",
        workspaceId: "ws_1",
        createdAt: 2,
        updatedAt: 2,
        lastHumanTurnAt: 2,
        tags: [],
        attachments: [],
      },
    ],
  })

  test("sending to an existing session stamps its human turn and lifts it", () => {
    seed()

    bumpExistingSessionRail({
      sessionId: "ses_target",
      directory: "/repo",
      sessionRef: sessionRef("ses_target", "ws_1"),
      workspaceId: "ws_1",
    })

    const items = listed()?.items
    expect(items?.map((item) => item.sessionId)).toEqual(["ses_target", "ses_other"])
    expect(items?.[0]?.lastHumanTurnAt).toBeGreaterThan(1_000_000_000_000)
  })

  test("a session created by sending to it carries the same stamp", () => {
    seed()

    bumpCreatedSessionRail({
      sessionId: "ses_new",
      title: "New",
      directory: "/repo",
      sessionRef: sessionRef("ses_new", "ws_1"),
      workspaceId: "ws_1",
      projects: [],
    })

    const items = listed()?.items
    expect(items?.map((item) => item.sessionId)).toEqual(["ses_new", "ses_other", "ses_target"])
    expect(items?.[0]?.lastHumanTurnAt).toBeGreaterThan(1_000_000_000_000)
  })
})
