import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { codexBundledOptions } from "./bundled-models"
import { CODEX_BUNDLED_MODELS, CODEX_BUNDLED_VERSION } from "./bundled-models.generated"

const harnessRoot = path.resolve(import.meta.dirname, "../../..")
const manifest = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { version: string; devDependencies: Record<string, string> }

test("the bundled Codex models were generated from the Codex Claxedo pins and installs", () => {
  expect(manifest(path.join(harnessRoot, "package.json")).devDependencies["@openai/codex"]).toBe(CODEX_BUNDLED_VERSION)
  expect(manifest(path.join(harnessRoot, "node_modules/@openai/codex/package.json")).version).toBe(CODEX_BUNDLED_VERSION)
})

test("a draft that names no model selects the model Codex marks as its default, and a named one selects that model", () => {
  const fallback = CODEX_BUNDLED_MODELS.find((model) => model.isDefault)
  const select = (model?: string) => codexBundledOptions(model).options.find((option) => option.category === "model")
  expect(select()?.currentValue).toBe(fallback?.id)
  const other = CODEX_BUNDLED_MODELS.find((model) => !model.isDefault && !model.hidden)
  expect(select(other?.id)?.currentValue).toBe(other?.id)
  expect(select()?.selectOptions?.map((row) => row.id)).toEqual(CODEX_BUNDLED_MODELS.filter((model) => !model.hidden).map((model) => model.id))
})
