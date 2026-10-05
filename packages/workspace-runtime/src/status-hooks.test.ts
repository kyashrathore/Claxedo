import { expect, test } from "bun:test"
import { defaultStatusHooks } from "./status-hooks"

test("the runtime composes the eight templates of the bundled status-hooks package", () => {
  expect(defaultStatusHooks.map((template) => template.command)).toEqual([
    "claude", "codex", "cursor", "antigravity", "droid", "mastracode", "amp", "copilot",
  ])
})
