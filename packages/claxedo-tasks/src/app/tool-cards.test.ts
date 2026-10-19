import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { readPluginManifest, readToolCardTemplates } from "@claxedo/plugin-api"
import { TASKS_MCP_TOOL_GROUP } from "../mcp"
import plugin, { dictionary } from "./index"
import { recordingPluginApi } from "./test-host"
import { taskToolCards } from "./tool-cards"
import { CARD_WORDS } from "./words/card-words"

const cards = taskToolCards((key) => dictionary.en[key])

function taskToolNames(): string[] {
  const names: string[] = []
  TASKS_MCP_TOOL_GROUP.register({ tool: (name: string) => void names.push(name) })
  return names
}

describe("the Tasks app entry", () => {
  test("its package manifest names this entry and requires the server's tasks capability", () => {
    const packageJson: unknown = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "..", "package.json"), "utf8"))
    expect(readPluginManifest(packageJson)).toMatchObject({ id: "claxedo-tasks", app: "./src/app/index.ts", requires: ["tasks"], server: { routes: ["/api/claxedo/tasks", "/api/claxedo/plugins"], operations: [] } })
  })

  test("registers a card for every task tool, and the Presets settings section, on activation", async () => {
    const { api, registered } = recordingPluginApi()
    await plugin.activate(api)
    expect(registered.toolCards.map((card) => card.tool).sort()).toEqual(taskToolNames().sort())
    expect(registered.settings).toMatchObject([{ id: "presets", title: "Presets", group: "workspace" }])
  })

  test("the cards are templates the host accepts, titled and labelled from the dictionary", () => {
    expect(readToolCardTemplates(cards)).toEqual(cards)
    const texts = JSON.stringify(cards)
    expect(texts).not.toContain("claxedo-tasks.card.")
    expect(cards.map((card) => card.title)).toEqual(["List tasks", "Read task", "Create task", "Edit task", "Start task"])
  })

  test("every card word is used by a card", () => {
    const used = new Set<string>()
    taskToolCards((key) => {
      used.add(key)
      return key
    })
    expect([...used].sort()).toEqual(Object.keys(CARD_WORDS).sort())
  })

  test("task links name the Tasks page with the task's id", () => {
    const created = cards.find((card) => card.tool === "task_create")
    expect(created?.link).toMatchObject({ kind: "page", pageId: "tasks", params: { taskId: { first: [{ path: "/result/task/id" }] } } })
  })
})
