import { describe, expect, test } from "bun:test"
import { mapInventoryToSessions, signedInventoryItems } from "./inventory"
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
