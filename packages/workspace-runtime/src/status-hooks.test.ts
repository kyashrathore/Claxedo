import { expect, test } from "bun:test"
import { PluginStatusHooksRefusedError, readPluginManifest } from "@claxedo/plugin-api"
import bundledPackage from "@claxedo/status-hooks/package.json"
import { defaultStatusHooks } from "./status-hooks"

test("the runtime composes the nine templates of the bundled status-hooks package", () => {
  expect(defaultStatusHooks.map((template) => template.command)).toEqual([
    "claude", "codex", "cursor", "gemini", "antigravity", "droid", "mastracode", "amp", "copilot",
  ])
})

test("the bundled package's manifest arriving as a plugin is refused like any other", () => {
  expect(() => readPluginManifest(bundledPackage)).toThrow(PluginStatusHooksRefusedError)
})
