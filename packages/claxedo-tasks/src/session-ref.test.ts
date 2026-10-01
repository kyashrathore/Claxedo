import { describe, expect, test } from "bun:test"
import { linkView } from "./contracts"
import { decodeStartResponse, decodeTask } from "./decode"
import { parsedReasons } from "./test-support/refusals"
import { linkRow, taskRow } from "./test-support/rows"

const ref = { sessionId: "session-1", workspaceId: "workspace-1" }
const noWorkspace = { ...ref, workspaceId: null }

describe("Tasks session identity", () => {
  test("a task or start response whose session reference lacks its workspace does not decode", () => {
    const task = taskRow({ id: "task-1", createdFrom: ref })
    expect(decodeTask(task).ok).toBe(true)
    expect(parsedReasons(decodeTask({ ...task, createdFrom: noWorkspace }))).toEqual({ "task.createdFrom.workspaceId": "type" })
    const link = linkView(linkRow({ taskId: "task-1", attempt: 1, sessionRef: ref }), "live", "sent")
    expect(decodeStartResponse({ link, created: true }).ok).toBe(true)
    expect(parsedReasons(decodeStartResponse({ link: { ...link, sessionRef: noWorkspace }, created: true }))).toEqual({ "body.link.sessionRef.workspaceId": "type" })
  })
})
