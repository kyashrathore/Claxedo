import { expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { assertDataDirUntouched } from "./build-compile-cache"

test("the daemon entry proves it was launched before it opens any store", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dir, "claxedo-server-entry.ts"), "utf8")
  const gate = source.indexOf("claxedoServerStartup(process.env)")
  const firstStore = source.indexOf("createLocalAgentPluginsComposition")
  expect(gate).toBeGreaterThan(-1)
  expect(firstStore).toBeGreaterThan(gate)
})

test("a data directory the build's import wrote into fails the build by name", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-compile-cache-test-"))
  try {
    expect(() => assertDataDirUntouched(dataDir, "entry.js")).not.toThrow()
    fs.writeFileSync(path.join(dataDir, "claxedo.db"), "")
    expect(() => assertDataDirUntouched(dataDir, "entry.js")).toThrow(/wrote to its data directory \(claxedo\.db\)/)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
