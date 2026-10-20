import { describe, expect, test } from "bun:test"
import { readToolCardTemplates, TOOL_CARD_MAX_TEMPLATES, ToolCardTemplateError, type ToolCardTemplate } from "./transcript"

const card: ToolCardTemplate = {
  tool: "task_create",
  title: "Create task",
  subject: { first: [{ path: "/result/task/title" }, { path: "/args/title", max: 40 }] },
  status: { value: { path: "/result/task/status" }, states: { doing: { label: "In progress", icon: "circleHalf", tone: "info" } } },
  link: { kind: "page", pageId: "tasks", params: { taskId: { path: "/result/task/id" } }, label: { format: "#{/result/task/key} {/result/task/title}" } },
  notes: [{ when: { path: "/result/replayed", equals: true }, text: "already existed" }],
  facts: [{ label: "Created from", value: { kind: "session", sessionId: { path: "/result/task/createdFrom/sessionId" } }, when: { path: "/result" } }],
  rows: { path: "/result/tasks", link: { kind: "page", pageId: "tasks", params: { taskId: { path: "/id" } }, label: { path: "/title" } }, max: 8, more: "+{count} more", continued: { when: { path: "/result/nextCursor" }, text: "more available" } },
}

function issuesOf(value: unknown): readonly string[] {
  try {
    readToolCardTemplates(value)
  } catch (error) {
    if (error instanceof ToolCardTemplateError) return error.issues
    throw error
  }
  return []
}

describe("readToolCardTemplates", () => {
  test("keeps every field of a well-formed template", () => {
    expect(readToolCardTemplates([card])).toEqual([card])
  })

  test("refuses code, unknown fields and paths that are not JSON Pointers", () => {
    expect(issuesOf([{ ...card, render: "() => 1" }]).join(" ")).toContain("render")
    expect(issuesOf([{ ...card, subject: { path: "result.task" } }])).not.toEqual([])
    expect(issuesOf([{ ...card, subject: { script: "x" } }])).not.toEqual([])
  })

  test("refuses an icon outside the surface catalog and a tone outside the card tones", () => {
    expect(issuesOf([{ ...card, status: { value: "x", states: { x: { label: "X", icon: "rocket" } } } }])).not.toEqual([])
    expect(issuesOf([{ ...card, status: { value: "x", states: { x: { label: "X", tone: "loud" } } } }])).not.toEqual([])
  })

  test("refuses a tool name outside the Claxedo tool-name shape, and a list past its cap", () => {
    expect(issuesOf([{ ...card, tool: "Task create" }])).not.toEqual([])
    expect(issuesOf(Array.from({ length: TOOL_CARD_MAX_TEMPLATES + 1 }, () => card))).not.toEqual([])
  })
})
