import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { readPluginManifest, readToolCardTemplates, type PluginApi, type ToolCardTemplate } from "@claxedo/plugin-api"
import { DOCUMENTS_MCP_TOOL_GROUP } from "../mcp"
import plugin, { dictionary } from "./index"
import { documentToolCards } from "./tool-cards"

const cards = documentToolCards((key) => dictionary.en[key])

function documentToolNames(): string[] {
  const names: string[] = []
  DOCUMENTS_MCP_TOOL_GROUP.register({ tool: (name: string) => void names.push(name) })
  return names
}

/** The two host services the entry touches; the rest of the API is never reached. */
function recordingApi() {
  const registered: ToolCardTemplate[] = []
  const api = {
    transcript: { toolCards: (templates: readonly ToolCardTemplate[]) => { registered.push(...templates); return () => {} } },
    i18n: { t: (key: string) => (key in dictionary.en ? dictionary.en[key as keyof typeof dictionary.en] : key) },
  }
  return { api: api as unknown as PluginApi, registered }
}

describe("the Documents app entry", () => {
  test("its package manifest names this entry, requires the server's documents capability and reaches nothing", () => {
    const packageJson: unknown = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "..", "package.json"), "utf8"))
    expect(readPluginManifest(packageJson)).toMatchObject({ id: "claxedo-documents", app: "./src/app/index.ts", requires: ["documents"], server: { routes: [], operations: [] } })
  })

  test("registers a card for every documents tool on activation, worded from its dictionary", async () => {
    const { api, registered } = recordingApi()
    await plugin.activate(api)
    expect(registered.map((card) => card.tool).sort()).toEqual(documentToolNames().sort())
    expect(registered.map((card) => card.title)).toEqual(["List documents", "Open document"])
  })

  test("the cards are templates the host accepts", () => {
    expect(readToolCardTemplates(cards)).toEqual(cards)
    expect(JSON.stringify(cards)).not.toContain("claxedo-documents.card.")
  })

  test("every card word is used by a card", () => {
    const used = new Set<string>()
    documentToolCards((key) => {
      used.add(key)
      return key
    })
    expect([...used].sort()).toEqual(Object.keys(dictionary.en).sort())
  })
})
