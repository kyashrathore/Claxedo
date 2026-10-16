import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { BUNDLED_ENGINE_VERSION } from "./bundled-models.generated"
import { openCodeBundledModels } from "./bundled-models"

const harnessRoot = path.resolve(import.meta.dirname, "../../..")
const versionOf = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version
const pinned = (JSON.parse(readFileSync(path.join(harnessRoot, "package.json"), "utf8")) as { dependencies: Record<string, string> })
  .dependencies["@opencode-ai/sdk"]

test("the bundled model list was generated from the OpenCode engine Claxedo pins and installs", () => {
  expect(pinned).toBe(BUNDLED_ENGINE_VERSION)
  expect(BUNDLED_ENGINE_VERSION).toBe(versionOf(path.join(harnessRoot, "node_modules/@opencode-ai/sdk/package.json")))
})

test("bundled models are only those of the providers named, under the engine's provider and model ids", () => {
  const anthropic = openCodeBundledModels(["anthropic"])
  expect(anthropic.length).toBeGreaterThan(0)
  expect(anthropic.every((model) => model.providerID === "anthropic" && model.id.length > 0)).toBe(true)
  const both = openCodeBundledModels(["anthropic", "openai"])
  expect(both.filter((model) => model.providerID === "openai").length).toBeGreaterThan(0)
  expect(both.length).toBe(anthropic.length + openCodeBundledModels(["openai"]).length)
  expect(openCodeBundledModels([])).toEqual([])
  expect(openCodeBundledModels(["not-a-vendor"])).toEqual([])
})
