import { describe, expect, mock, test } from "bun:test"
import { createSignal } from "solid-js"
import type { ToolCardTemplate } from "@claxedo/plugin-api"
import type { PageEntry, Registry, ToolCardEntry } from "@/shell"
import { createRegistrationSink } from "../registrations"
import type { BindingScope } from "./services"
import { shellRoutes } from "./test-support/shell-routes"

await mock.module("@/shell", () => ({
  ...shellRoutes,
  fillPattern: (pattern: string, params: Readonly<Record<string, string>>) => pattern.replace(":taskId?", params.taskId ?? ""),
}))
const { transcriptBinding } = await import("./transcript")

function registry<Entry>(initial: readonly Entry[] = []): Registry<Entry> {
  const [entries, setEntries] = createSignal(initial)
  return {
    list: entries,
    add: (entry) => {
      setEntries((current) => [...current, entry])
      return () => setEntries((current) => current.filter((candidate) => candidate !== entry))
    },
  }
}

function page(id: string, path: string): PageEntry {
  return { id, path, title: () => id, icon: "grid-plus", sidebar: "main", view: () => undefined }
}

function fixture(pages: readonly PageEntry[] = []) {
  const toolCards = registry<ToolCardEntry>()
  const sink = createRegistrationSink("claxedo-tasks")
  const scope = {
    manifest: { id: "claxedo-tasks", name: "Tasks", version: "1.0.0" },
    sink,
    services: { registries: { toolCards, pages: registry(pages) } },
  } as unknown as BindingScope
  return { api: transcriptBinding(scope), toolCards, sink }
}

const card: ToolCardTemplate = { tool: "task_get", title: "Read task" }

describe("transcript.toolCards", () => {
  test("registers one card per template under the plugin's id, and the disposer removes them", () => {
    const { api, toolCards } = fixture()
    const dispose = api.toolCards([card, { tool: "task_list", title: "List tasks" }])
    expect(toolCards.list().map((entry) => entry.id)).toEqual(["claxedo-tasks/task_get", "claxedo-tasks/task_list"])
    dispose()
    expect(toolCards.list()).toEqual([])
  })

  test("a link names the plugin's own page first, then an app page of that id, and nothing when neither is registered", () => {
    const own = fixture([page("tasks", "/app-tasks/:taskId?"), page("claxedo-tasks/tasks", "/tasks/:taskId?")])
    own.api.toolCards([card])
    expect(own.toolCards.list()[0]?.pageHref("tasks", { taskId: "t1" })).toBe("/tasks/t1")
    const app = fixture([page("tasks", "/app-tasks/:taskId?")])
    app.api.toolCards([card])
    expect(app.toolCards.list()[0]?.pageHref("tasks", { taskId: "t1" })).toBe("/app-tasks/t1")
    expect(app.toolCards.list()[0]?.pageHref("missing", { taskId: "t1" })).toBeUndefined()
  })

  test("refuses a malformed template and a tool that already has a card, registering nothing", () => {
    const { api, toolCards } = fixture()
    expect(() => api.toolCards([{ ...card, render: "code" } as unknown as ToolCardTemplate])).toThrow("claxedo-tasks: The tool card templates are invalid")
    api.toolCards([card])
    expect(() => api.toolCards([{ tool: "task_list", title: "List" }, card])).toThrow("the tool task_get already has a card template")
    expect(() => api.toolCards([{ tool: "task_edit", title: "Edit" }, { tool: "task_edit", title: "Edit" }])).toThrow("the tool task_edit already has a card template")
    expect(toolCards.list().map((entry) => entry.template.tool)).toEqual(["task_get"])
  })

  test("the cards go with the plugin when it is switched off", () => {
    const { api, toolCards, sink } = fixture()
    api.toolCards([card])
    sink.disposeAll()
    expect(toolCards.list()).toEqual([])
  })
})
