import { expect, test } from "bun:test"
import type { StatusHookTemplate } from "./status-hooks"
import { readStatusHookTemplates } from "./status-hooks"
import { PluginManifestError, PluginStatusHooksRefusedError, pluginManifestSchema, readPluginManifest } from "./manifest"

const manifest = { id: "status-hooks", name: "Status hooks", version: "1.0.0", app: "./app.ts" }
const template: StatusHookTemplate = {
  command: "example",
  provider: "example",
  install: { type: "wrapper-flags", args: ["--hook", "{{notify}}"] },
  events: { Begin: "running", End: "done" },
  subagent: ["worker_id"],
}

test("a plugin manifest that declares status hooks is refused with a typed error", () => {
  let refused: unknown
  try {
    readPluginManifest({ claxedo: { ...manifest, statusHooks: [template] } })
  } catch (error) {
    refused = error
  }
  expect(refused).toBeInstanceOf(PluginStatusHooksRefusedError)
  expect(refused).toBeInstanceOf(PluginManifestError)
  expect((refused as PluginStatusHooksRefusedError).code).toBe("status_hooks_first_party_only")
  expect((refused as PluginStatusHooksRefusedError).issues).toEqual([
    expect.stringMatching(/^claxedo\.statusHooks: /),
  ])
})

test("every manifest parse refuses status hooks, including an empty list", () => {
  expect(pluginManifestSchema.safeParse({ ...manifest, statusHooks: [template] }).success).toBe(false)
  expect(pluginManifestSchema.safeParse({ ...manifest, statusHooks: [] }).success).toBe(false)
})

test("a plugin manifest without status hooks is read as before", () => {
  expect(readPluginManifest({ claxedo: manifest })).toEqual({
    ...manifest,
    requires: [],
    server: { routes: [], operations: [] },
  })
})

test("bundled status hook templates are validated on their own", () => {
  expect(readStatusHookTemplates([template])).toEqual([template])
  expect(() => readStatusHookTemplates([{ ...template, command: "Bad Name" }])).toThrow(PluginManifestError)
})
