import { describe, expect, test } from "bun:test"
import type { ToolCardTemplate } from "@claxedo/plugin-api"
import { claxedoToolTitle, claxedoToolView } from "./claxedo-tool-view"
import type { TranscriptI18n } from "./i18n"
import type { TranscriptToolCard } from "./tool-card-template"

const i18n: TranscriptI18n = { intlTag: () => "en", t: (key) => key }

function registered(template: ToolCardTemplate): TranscriptToolCard {
  return { template, pageHref: (pageId, params) => `/${pageId}/${params.taskId}` }
}

const taskCreate = registered({
  tool: "task_create",
  title: "Create task",
  link: { kind: "page", pageId: "tasks", params: { taskId: { path: "/result/task/id" } }, label: { first: [{ format: "#{/result/task/key} {/result/task/title}" }, { path: "/args/title" }] } },
})

const output = JSON.stringify({ task: { id: "t1", key: "T-1", title: "Ship it" } })

describe("claxedoToolView", () => {
  test("a tool without a core case draws its registered template", () => {
    const view = claxedoToolView({ name: "task_create", input: { title: "Ship it" }, output, i18n, toolCards: [taskCreate] })
    expect(view.title).toBe("Create task")
    expect(view.link).toEqual({ kind: "page", href: "/tasks/t1", label: "#T-1 Ship it" })
    expect(view.text).toBeUndefined()
  })

  test("without a registered template the same tool draws as the generic row", () => {
    const view = claxedoToolView({ name: "task_create", input: { title: "Ship it" }, output, i18n, toolCards: [] })
    expect(view.title).toBe("Task create")
    expect(view.subject).toBe("Ship it")
    expect(view.link).toBeUndefined()
    expect(view.text).toBe(output)
  })

  test("a core tool keeps its own card and title even when a plugin registers a template for its name", () => {
    const shadow = registered({ tool: "session_rename", title: "Hijacked", subject: "plugin text" })
    const view = claxedoToolView({ name: "session_rename", input: { session: "ses_1", title: "New" }, output: undefined, i18n, toolCards: [shadow] })
    expect(view.title).toBe("transcript.claxedoTool.session_rename")
    expect(view.subject).toBe("New")
    expect(claxedoToolTitle("session_rename", i18n, [shadow])).toBe("transcript.claxedoTool.session_rename")
  })
})
