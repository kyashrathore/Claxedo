import { describe, expect, test } from "bun:test"
import {
  groupRailSessionStatusTargets,
  railSessionStatusBatchKey,
  railSessionStatusTarget,
} from "./rail-session-status-target"

describe("rail session status targets", () => {
  test("retains explicit workspace identity for workspace-hosted rows", () => {
    expect(railSessionStatusTarget({
      key: "workspace:ws_signed:session:ses_1",
      sessionRef: "workspace:ws_signed:session:ses_1",
      sessionID: "ses_1",
      directory: "/runtime/repo",
      workspaceId: "ws_signed",
    })).toEqual({
      key: "workspace:ws_signed:session:ses_1",
      sessionID: "ses_1",
      directory: "/runtime/repo",
      workspaceId: "ws_signed",
    })
  })

  test("does not treat a central session workspace association as runtime placement", () => {
    expect(railSessionStatusTarget({
      key: "central:ses_1",
      sessionRef: "central:ses_1",
      sessionID: "ses_1",
      directory: "/runtime/repo",
      workspaceId: "ws_associated",
    })).toEqual({
      key: "central:ses_1",
      sessionID: "ses_1",
      directory: "/runtime/repo",
    })
  })

  test("keeps distinct workspace placements in separate polling batches", () => {
    const groups = groupRailSessionStatusTargets([
      railSessionStatusTarget({
        key: "workspace:ws_2:session:shared",
        sessionRef: "workspace:ws_2:session:shared",
        sessionID: "shared",
        directory: "/runtime/repo",
        workspaceId: "ws_2",
      }),
      railSessionStatusTarget({
        key: "workspace:ws_1:session:shared",
        sessionRef: "workspace:ws_1:session:shared",
        sessionID: "shared",
        directory: "/runtime/repo",
        workspaceId: "ws_1",
      }),
    ])

    expect(groups.map((group) => ({
      workspaceId: group.workspaceId,
      batchKey: railSessionStatusBatchKey(group),
    }))).toEqual([
      { workspaceId: "ws_1", batchKey: "ws_1\0/runtime/repo\0shared" },
      { workspaceId: "ws_2", batchKey: "ws_2\0/runtime/repo\0shared" },
    ])
  })
})
