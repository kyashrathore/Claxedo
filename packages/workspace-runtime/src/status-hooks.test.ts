import { expect, test } from "bun:test"
import { defaultStatusHooks } from "./status-hooks"

test("the runtime composes the nine templates of the bundled status-hooks package", () => {
  expect(defaultStatusHooks.map((template) => template.command)).toEqual([
    "claude", "codex", "cursor", "gemini", "antigravity", "droid", "mastracode", "amp", "copilot",
  ])
})
