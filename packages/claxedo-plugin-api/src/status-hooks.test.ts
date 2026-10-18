import { expect, test } from "bun:test"
import type { StatusHookTemplate } from "./status-hooks"
import { readStatusHookTemplates } from "./status-hooks"
import { PluginManifestError, PluginStatusHooksRefusedError } from "./manifest"
import { pluginManifestSchema, readPluginManifest } from "./manifest-schema"

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

test("a template's Windows installation is validated like the template's own fields", () => {
  const windows: StatusHookTemplate = {
    ...template,
    windows: { wrapper: 'call "%REAL_BIN%" %*', artifacts: [{ file: "hook.cmd", content: "@echo off", mode: 0o755 }] },
  }
  expect(readStatusHookTemplates([windows])).toEqual([windows])
  expect(() => readStatusHookTemplates([{ ...template, windows: { shell: "powershell" } }])).toThrow(PluginManifestError)
  expect(() =>
    readStatusHookTemplates([{ ...template, windows: { artifacts: [{ file: "..\\hook.cmd", content: "", mode: 0o755 }] } }]),
  ).toThrow(PluginManifestError)
})
