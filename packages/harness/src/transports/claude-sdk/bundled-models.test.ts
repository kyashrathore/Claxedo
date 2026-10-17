import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { claudeBundledOptions } from "./bundled-models"
import { CLAUDE_BUNDLED_SDK_VERSION } from "./bundled-models.generated"

const harnessRoot = path.resolve(import.meta.dirname, "../../..")
const manifest = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { version: string; dependencies: Record<string, string> }

test("the bundled Claude models were generated from the Claude Agent SDK Claxedo pins and installs", () => {
  expect(manifest(path.join(harnessRoot, "package.json")).dependencies["@anthropic-ai/claude-agent-sdk"]).toBe(CLAUDE_BUNDLED_SDK_VERSION)
  expect(manifest(path.join(harnessRoot, "node_modules/@anthropic-ai/claude-agent-sdk/package.json")).version).toBe(CLAUDE_BUNDLED_SDK_VERSION)
})

const modelRows = (form: "api" | "plan", model?: string) => claudeBundledOptions(form, model).options.find((option) => option.category === "model")

test("a key and a plan each list Claude Code's models, the default row selected when the draft names none", () => {
  for (const form of ["api", "plan"] as const) {
    const rows = modelRows(form)
    expect(rows?.currentValue).toBe("default")
    expect(rows?.selectOptions?.map((row) => row.id)).toEqual(expect.arrayContaining(["default", "opus", "sonnet", "haiku"]))
  }
})

test("a draft's saved model is the selected row, by alias or by the full id it runs, and carries that row's efforts", () => {
  expect(modelRows("api", "opus")?.currentValue).toBe("opus")
  const sonnet = modelRows("plan")?.selectOptions?.find((row) => row.id === "sonnet")?.resolvedModel
  expect(sonnet).toBeString()
  const byFullId = claudeBundledOptions("api", sonnet)
  expect(byFullId.options.find((option) => option.category === "model")?.currentValue).toBe("sonnet")
  expect(byFullId.options.find((option) => option.category === "thought_level")?.selectOptions?.length).toBeGreaterThan(0)
  expect(byFullId.resolvedModel).toEqual({ id: "sonnet", name: "Sonnet" })
})
