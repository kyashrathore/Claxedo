import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { readPluginManifest, readToolCardTemplates, type PluginApi, type ToolCardTemplate } from "@claxedo/plugin-api"
import { TASKS_MCP_TOOL_GROUP } from "../mcp"
import plugin, { dictionary } from "./index"
import { taskToolCards } from "./tool-cards"

const cards = taskToolCards((key) => dictionary.en[key])

function taskToolNames(): string[] {
  const names: string[] = []
  TASKS_MCP_TOOL_GROUP.register({ tool: (name: string) => void names.push(name) })
  return names
}

describe("the Tasks app entry", () => {
  test("its package manifest names this entry and requires the server's tasks capability", () => {
    const packageJson: unknown = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "..", "package.json"), "utf8"))
    expect(readPluginManifest(packageJson)).toMatchObject({ id: "claxedo-tasks", app: "./src/app/index.ts", requires: ["tasks"] })
  })

  test("registers a card for every task tool, and nothing else, on activation", async () => {
    const registered: ToolCardTemplate[][] = []
    const api = { transcript: { toolCards: (templates: readonly ToolCardTemplate[]) => registered.push([...templates]) }, i18n: { t: (key: string) => key } }
    await plugin.activate(api as unknown as PluginApi)
    expect(registered.flat().map((card) => card.tool).sort()).toEqual(taskToolNames().sort())
  })

  test("the cards are templates the host accepts, titled and labelled from the dictionary", () => {
    expect(readToolCardTemplates(cards)).toEqual(cards)
    const texts = JSON.stringify(cards)
    expect(texts).not.toContain("claxedo-tasks.card.")
    expect(cards.map((card) => card.title)).toEqual(["List tasks", "Read task", "Create task", "Edit task", "Start task"])
  })

  test("every dictionary key is used by a card", () => {
    const used = new Set<string>()
    taskToolCards((key) => {
      used.add(key)
      return key
    })
    expect([...used].sort()).toEqual(Object.keys(dictionary.en).sort())
  })

  test("task links name the Tasks page with the task's id", () => {
    const created = cards.find((card) => card.tool === "task_create")
    expect(created?.link).toMatchObject({ kind: "page", pageId: "tasks", params: { taskId: { first: [{ path: "/result/task/id" }] } } })
  })
})
