import { expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { runUnderStandInHome } from "./home/stand-in-home.mjs"

const packageDir = path.resolve(import.meta.dirname, "../..")
const engineTest = path.join(packageDir, "src/opencode/ports.integration.test.ts")
const runner = path.resolve(packageDir, "../../script/test-home/run.mjs")

test("bun runs these tests in a temporary home, not the developer's", () => {
  expect(os.homedir().startsWith(realpathSync(os.tmpdir()) + path.sep)).toBe(true)
})

test("a bare bun test refuses to start and leaves a stand-in for the developer's home untouched", async () => {
  const child = await runUnderStandInHome(packageDir, [process.execPath, "test", engineTest])

  expect(child.code).not.toBe(0)
  expect(child.output).toContain("Tests run in a temporary home")
  expect(child.written).toEqual([])
}, 120_000)

test("the embedded OpenCode engine run through the test runner leaves a stand-in for the developer's home untouched", async () => {
  const child = await runUnderStandInHome(packageDir, ["node", runner, process.execPath, "test", engineTest])

  expect({ code: child.code, output: child.output }).toMatchObject({ code: 0 })
  expect(child.output, "the engine test did not run, so nothing was proven").toMatch(/\b[1-9]\d* pass\b/)
  expect(child.written).toEqual([])
}, 120_000)
