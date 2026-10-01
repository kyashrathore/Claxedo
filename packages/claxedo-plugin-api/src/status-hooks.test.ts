import { expect, test } from "bun:test"
import type { StatusHookTemplate } from "./status-hooks"
import { readPluginManifest } from "./manifest"
const manifest = { id: "status-hooks", name: "Status hooks", version: "1.0.0", app: "./app.ts" }
const template: StatusHookTemplate = {
  command: "example",
  provider: "example",
  install: { type: "wrapper-flags", args: ["--hook", "{{notify}}"] },
  events: { Begin: "running", End: "done" },
  subagent: ["worker_id"],
}
test("reads status hook templates from a plugin manifest", () => {
  expect(readPluginManifest({ claxedo: { ...manifest, statusHooks: [template] } }).statusHooks).toEqual([template])
})
