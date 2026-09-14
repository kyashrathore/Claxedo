import { describe, expect, test } from "bun:test"
import { TASKS_BOUNDS, type TaskDraft } from "../contracts"
import { parsedReasons } from "../test-support/refusals"
import { validateReparent, validateTaskDraft, validateTaskEdit } from "./model"

function draft(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return {
    projectId: overrides.projectId ?? "project-alpha",
    title: overrides.title ?? "Ship the thing",
    description: overrides.description ?? "",
    workspaceId: overrides.workspaceId ?? null,
    parentTaskId: overrides.parentTaskId ?? null,
    ...(overrides.status === undefined ? {} : { status: overrides.status }),
  }
}

describe("validateTaskDraft", () => {
  test("accepts a minimal task", () => {
    expect(validateTaskDraft(draft()).ok).toBe(true)
  })

  test("requires a title and a project", () => {
    expect(parsedReasons(validateTaskDraft(draft({ title: "  " })))).toEqual({ title: "required" })
    expect(parsedReasons(validateTaskDraft(draft({ projectId: "" })))).toEqual({ projectId: "required" })
  })

  test("bounds the title by characters and the description by bytes", () => {
    expect(parsedReasons(validateTaskDraft(draft({ title: "t".repeat(TASKS_BOUNDS.taskTitleMax + 1) })))).toEqual({
      title: "too_long",
    })
    expect(validateTaskDraft(draft({ title: "t".repeat(TASKS_BOUNDS.taskTitleMax) })).ok).toBe(true)
    const over = "é".repeat(TASKS_BOUNDS.taskDescriptionMaxBytes / 2 + 1)
    expect(parsedReasons(validateTaskDraft(draft({ description: over })))).toEqual({ description: "too_long" })
  })

  test("an empty workspace or parent id is a missing value, not a null one", () => {
    expect(parsedReasons(validateTaskDraft(draft({ workspaceId: "" })))).toEqual({ workspaceId: "required" })
    expect(parsedReasons(validateTaskDraft(draft({ parentTaskId: " " })))).toEqual({ parentTaskId: "required" })
    expect(validateTaskDraft(draft({ workspaceId: null, parentTaskId: null })).ok).toBe(true)
  })

  test("a task may be created in Backlog or To do and in nothing else", () => {
    expect(validateTaskDraft(draft({ status: "backlog" })).ok).toBe(true)
    expect(validateTaskDraft(draft({ status: "todo" })).ok).toBe(true)
    expect(parsedReasons(validateTaskDraft({ ...draft(), status: "doing" as never }))).toEqual({ status: "unknown_value" })
  })
})

describe("validateTaskEdit", () => {
  test("applies the same text bounds", () => {
    const input = { taskId: "task-1", revision: 2, title: "", description: "", workspaceId: null }
    expect(parsedReasons(validateTaskEdit(input))).toEqual({ title: "required" })
    expect(validateTaskEdit({ ...input, title: "Fine" }).ok).toBe(true)
  })
})

describe("validateReparent", () => {
  test("refuses a task that would become its own parent", () => {
    const input = { taskId: "task-1", revision: 1, parentTaskId: "task-1", projectId: "project-alpha" }
    expect(parsedReasons(validateReparent(input))).toEqual({ parentTaskId: "not_allowed" })
  })

  test("accepts detaching to the root of the same project", () => {
    expect(validateReparent({ taskId: "task-1", revision: 1, parentTaskId: null, projectId: "project-alpha" }).ok).toBe(true)
  })

  test("requires a project", () => {
    expect(parsedReasons(validateReparent({ taskId: "task-1", revision: 1, parentTaskId: null, projectId: "" }))).toEqual({
      projectId: "required",
    })
  })
})
