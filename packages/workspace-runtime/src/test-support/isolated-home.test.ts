import { expect, test } from "bun:test"
import path from "node:path"
import { runUnderStandInHome } from "../../../agent-sdk-runtime/src/test-utils/stand-in-home.mjs"

const packageDir = path.resolve(import.meta.dirname, "../..")

test("the embedded OpenCode engine leaves a stand-in for the developer's home untouched", async () => {
  const child = await runUnderStandInHome(packageDir, [path.join(packageDir, "src/opencode/ports.integration.test.ts")])

  expect({ code: child.code, output: child.output }).toMatchObject({ code: 0 })
  expect(child.output, "the engine test did not run, so nothing was proven").toMatch(/\b[1-9]\d* pass\b/)
  expect(child.written).toEqual([])
}, 120_000)
