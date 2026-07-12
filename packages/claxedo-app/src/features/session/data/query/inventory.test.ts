import { describe, expect, test } from "bun:test"
import { mapInventoryToSessions, mergeSignedInventoryProjects, signedInventoryItems, signedInventoryProjects } from "./inventory"
import type { GlobalSessionItem } from "./types"

const item = (id: string, input: Partial<GlobalSessionItem> = {}) => ({
  id,
  title: input.title ?? id,
  directory: input.directory ?? "/tmp/ws",
  projectID: input.projectID ?? "proj_1",
  tags: input.tags ?? [],
  attachments: input.attachments ?? [],
  time: input.time ?? { created: 1, updated: 1 },
  ...input,
}) satisfies GlobalSessionItem

describe("mapInventoryToSessions", () => {
  test("maps workspace inventory into id-sorted non-archived sessions", () => {
    expect(mapInventoryToSessions([
      item("ses_b", { archived: true }),
      item("ses_c", {
        parentID: "ses_a",
        lastTurn: { status: "failed", completedAt: 20, error: "provider failed", assistantMessageId: "msg_1_r" },
      }),
      item("ses_a", { title: "A" }),
    ])).toEqual([
      {
        id: "ses_a",
        title: "A",
        directory: "/tmp/ws",
        projectID: "proj_1",
        time: { created: 1, updated: 1 },
      },
      {
        id: "ses_c",
        title: "ses_c",
        directory: "/tmp/ws",
        projectID: "proj_1",
        parentID: "ses_a",
        lastTurn: { status: "failed", completedAt: 20, error: "provider failed", assistantMessageId: "msg_1_r" },
        time: { created: 1, updated: 1 },
      },
    ])
  })
})

describe("signedInventoryItems", () => {
  test("keeps user-hosted workspaces on synthetic workspace directories", () => {
    expect(signedInventoryItems({
      workspaces: [{
        workspace_id: "ws_user_hosted",
        project_id: "proj_1",
        backing: "local-worktree",
        access: "user-hosted",
      }],
      sessionsByWorkspace: {
        ws_user_hosted: [{
          session_id: "ses_1",
          title: "Shared",
          created_at: 1,
          updated_at: 2,
          lastTurn: { status: "completed", completedAt: 3, assistantMessageId: "msg_1_r" },
        }],
      },
    })).toMatchObject([{
      id: "ses_1",
      title: "Shared",
      directory: "workspace:ws_user_hosted",
      projectID: "proj_1",
      environment: {
        kind: "user-hosted",
        driver: "local-worktree",
      },
      lastTurn: { status: "completed", completedAt: 3, assistantMessageId: "msg_1_r" },
      time: { created: 1, updated: 2 },
    }])
  })
})

describe("signedInventoryProjects", () => {
  test("builds synthetic project refs from signed user-hosted workspaces", () => {
    expect(signedInventoryProjects({
      workspaces: [{
        workspace_id: "ws_user_hosted",
        project_id: "proj_1",
        display_name: "Shared Repo",
        access: "user-hosted",
        created_at: 1,
        updated_at: 2,
      }],
    })).toMatchObject([{
      id: "proj_1",
      name: "Shared Repo",
      worktree: "workspace:ws_user_hosted",
      sandboxes: ["workspace:ws_user_hosted"],
      workspaces: {
        "workspace:ws_user_hosted": {
          id: "ws_user_hosted",
          kind: "user-hosted",
          workspace_name: "Shared Repo",
          directory: "workspace:ws_user_hosted",
        },
      },
      time: { created: 1, updated: 2 },
    }])
  })

  test("merges signed workspace refs into existing local projects by project id", () => {
    expect(mergeSignedInventoryProjects([
      {
        id: "proj_1",
        name: "Local Repo",
        worktree: "/Users/me/repo",
        sandboxes: [],
        time: { created: 5, updated: 5 },
      },
    ], signedInventoryProjects({
      workspaces: [{
        workspace_id: "ws_user_hosted",
        project_id: "proj_1",
        display_name: "Shared Repo",
        access: "user-hosted",
        created_at: 1,
        updated_at: 10,
      }],
    }))).toMatchObject([{
      id: "proj_1",
      name: "Local Repo",
      worktree: "/Users/me/repo",
      sandboxes: ["workspace:ws_user_hosted"],
      workspaces: {
        "workspace:ws_user_hosted": {
          id: "ws_user_hosted",
          kind: "user-hosted",
        },
      },
      time: { created: 1, updated: 10 },
    }])
  })
})
