import { describe, expect, test } from "bun:test"
import { decodeStartResponse, decodeTask } from "./decode"
import { parseCommandRequest, parseStartPreviewRequest, parseStartRequest } from "./http/parse"
import { validateTaskDraft } from "./tasks/model"
import type { TaskDraft } from "./contracts"
import { parsedReasons } from "./test-support/refusals"
import { linkRow, taskRow } from "./test-support/rows"
import { linkView } from "./contracts"

const from = { sessionId: "session-1", workspaceId: "workspace-1" }
const draft: TaskDraft = { projectId: "project-1", title: "Ship", description: "", workspaceId: null, parentTaskId: null }
const preview = { taskRevision: 1, presetId: "preset-1", presetRevision: 1, slot: "primary", attempt: 1, continueFromPrevious: false }
const start = { ...preview, clientRequestId: "request-1", previewDigest: "digest-1", handoffText: null }

describe("Tasks session identity", () => {
  test("task provenance requires a workspace even when the task has no preference", () => {
    for (const workspaceId of [null, undefined, "", " ", 1]) {
      const createdFrom = { ...from, workspaceId }
      const result = parseCommandRequest({ clientRequestId: "request-1", command: { type: "task.create", input: { ...draft, createdFrom } } })
      expect(parsedReasons(result)["command.input.createdFrom.workspaceId"]).toBeDefined()
    }
    const result = parseCommandRequest({ clientRequestId: "request-1", command: { type: "task.create", input: { ...draft, createdFrom: from } } })
    expect(result.ok && result.value.command.type === "task.create" && result.value.command.input.createdFrom).toEqual(from)
  })

  test("preview and start refuse a caller session without its workspace", () => {
    for (const workspaceId of [null, undefined]) {
      const startedFrom = { ...from, workspaceId }
      expect(parsedReasons(parseStartPreviewRequest({ ...preview, startedFrom }))["startedFrom.workspaceId"]).toBeDefined()
      expect(parsedReasons(parseStartRequest({ ...start, startedFrom }))["startedFrom.workspaceId"]).toBeDefined()
    }
    expect(parseStartRequest({ ...start, startedFrom: from }).ok).toBe(true)
    expect(parseStartRequest(start).ok).toBe(true)
  })

  test("direct task validation refuses a malformed provenance", () => {
    const malformed = { ...draft, createdFrom: { ...from, workspaceId: null } } as unknown as TaskDraft
    expect(parsedReasons(validateTaskDraft(malformed))).toEqual({ "createdFrom.workspaceId": "type" })
    expect(validateTaskDraft({ ...draft, createdFrom: from }).ok).toBe(true)
  })

  test("stored task provenance cannot decode without its workspace", () => {
    const task = taskRow({ id: "task-1", createdFrom: from })
    expect(parsedReasons(decodeTask({ ...task, createdFrom: { ...from, workspaceId: null } }))).toEqual({ "task.createdFrom.workspaceId": "type" })
    expect(decodeTask(task).ok).toBe(true)
    expect(decodeTask({ ...task, createdFrom: null }).ok).toBe(true)
  })

  test("a start response requires complete current and continuation references", () => {
    const link = linkView(linkRow({ taskId: "task-1", attempt: 1, sessionRef: from, continuedFrom: from }), "live", "sent")
    for (const field of ["sessionRef", "continuedFrom"] as const) {
      const result = decodeStartResponse({ link: { ...link, [field]: { ...from, workspaceId: null } }, created: true })
      expect(parsedReasons(result)[`body.link.${field}.workspaceId`]).toBeDefined()
    }
    expect(decodeStartResponse({ link, created: true }).ok).toBe(true)
  })
})
