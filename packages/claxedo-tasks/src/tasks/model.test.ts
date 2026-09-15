import { describe, expect, test } from "bun:test"
import { encodeAttachmentData } from "../attachments"
import { TASKS_BOUNDS, type TaskAttachmentDraft, type TaskDraft } from "../contracts"
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
    ...(overrides.attachments === undefined ? {} : { attachments: overrides.attachments }),
  }
}

const PNG_HEADER = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])

function image(overrides: Partial<TaskAttachmentDraft> = {}): TaskAttachmentDraft {
  return {
    filename: overrides.filename ?? "shot.png",
    mime: overrides.mime ?? "image/png",
    data: overrides.data ?? encodeAttachmentData(PNG_HEADER),
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

  test("images are decoded in draft order with their names trimmed", () => {
    const checked = validateTaskDraft(draft({ attachments: [image({ filename: "  a.png " }), image({ filename: "b.png", mime: "image/webp" })] }))
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    expect(checked.value.attachments).toEqual([
      { filename: "a.png", mime: "image/png", bytes: PNG_HEADER },
      { filename: "b.png", mime: "image/webp", bytes: PNG_HEADER },
    ])
  })

  test("only the image types every harness carries are admitted", () => {
    expect(parsedReasons(validateTaskDraft(draft({ attachments: [image({ mime: "application/pdf" })] })))).toEqual({
      "attachments[0].mime": "unknown_value",
    })
    expect(parsedReasons(validateTaskDraft(draft({ attachments: [image({ mime: "image/svg+xml" })] })))).toEqual({
      "attachments[0].mime": "unknown_value",
    })
  })

  test("an image needs a name, and the name is bounded", () => {
    expect(parsedReasons(validateTaskDraft(draft({ attachments: [image({ filename: " " })] })))).toEqual({
      "attachments[0].filename": "required",
    })
    expect(
      parsedReasons(validateTaskDraft(draft({ attachments: [image({ filename: "n".repeat(TASKS_BOUNDS.taskAttachmentFilenameMax + 1) })] }))),
    ).toEqual({ "attachments[0].filename": "too_long" })
  })

  // The cap is read off the base64 length, so an oversized image is refused
  // before its bytes are allocated; a partial decode of bad base64 would
  // store a truncated image, so that is refused whole too.
  test("an image is bounded by its decoded bytes and refused when the data is not base64", () => {
    const atCap = encodeAttachmentData(new Uint8Array(TASKS_BOUNDS.taskAttachmentMaxBytes))
    expect(validateTaskDraft(draft({ attachments: [image({ data: atCap })] })).ok).toBe(true)
    const over = encodeAttachmentData(new Uint8Array(TASKS_BOUNDS.taskAttachmentMaxBytes + 1))
    expect(parsedReasons(validateTaskDraft(draft({ attachments: [image({ data: over })] })))).toEqual({
      "attachments[0].data": "too_long",
    })
    expect(parsedReasons(validateTaskDraft(draft({ attachments: [image({ data: "data:image/png;base64,iVBORw==" })] })))).toEqual({
      "attachments[0].data": "type",
    })
    expect(parsedReasons(validateTaskDraft(draft({ attachments: [image({ data: "" })] })))).toEqual({
      "attachments[0].data": "type",
    })
  })

  test("the number of images is bounded, and nothing of an over-long list is decoded", () => {
    const many = Array.from({ length: TASKS_BOUNDS.taskAttachmentsMax + 1 }, () => image({ data: "not base64" }))
    expect(parsedReasons(validateTaskDraft(draft({ attachments: many })))).toEqual({ attachments: "too_many" })
    const atMax = Array.from({ length: TASKS_BOUNDS.taskAttachmentsMax }, () => image())
    expect(validateTaskDraft(draft({ attachments: atMax })).ok).toBe(true)
  })

  test("an absent list and an empty one both mean no images", () => {
    for (const checked of [validateTaskDraft(draft()), validateTaskDraft(draft({ attachments: [] }))]) {
      expect(checked.ok).toBe(true)
      if (checked.ok) expect(checked.value.attachments).toEqual([])
    }
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
