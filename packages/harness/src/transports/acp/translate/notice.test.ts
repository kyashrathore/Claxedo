import { expect, test } from "bun:test"
import { noticeEvent } from "./notice"

test("an ACP notice is a harness notice whose severity reads the agent's hint, and an unknown hint is info", () => {
  expect(noticeEvent({ sessionUpdate: "notice", severity: "error", title: "Index failed", description: " Disk is full. " })).toEqual({
    type: "harness-notice", code: "acp.notice", severity: "error", message: "Index failed. Disk is full.",
    details: { severity: "error", title: "Index failed", description: "Disk is full." },
  })
  expect(noticeEvent({ sessionUpdate: "notice", severity: "info", title: "Indexed the workspace", description: null }))
    .toEqual({ type: "harness-notice", code: "acp.notice", severity: "info", message: "Indexed the workspace",
      details: { severity: "info", title: "Indexed the workspace" } })
  expect(noticeEvent({ sessionUpdate: "notice", severity: "celebration", title: "Done" })).toMatchObject({ severity: "info", details: { severity: "celebration" } })
})
