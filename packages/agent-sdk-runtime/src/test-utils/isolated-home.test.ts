import { expect, test } from "bun:test"
import path from "node:path"
import { resolveClaudeExecutable } from "../harnesses/claude/executable"
import { runUnderStandInHome } from "./stand-in-home.mjs"

const packageDir = path.resolve(import.meta.dirname, "../..")

/** Tests that spawn an installed harness CLI are named `*.cli.test.ts`. */
const cliTests = [...new Bun.Glob("**/*.cli.test.ts").scanSync({ cwd: path.join(packageDir, "src"), absolute: true })]

test.skipIf(resolveClaudeExecutable() === undefined)(
  "CLI-spawning tests leave a stand-in for the developer's home untouched",
  async () => {
    const child = await runUnderStandInHome(packageDir, cliTests)

    expect({ code: child.code, output: child.output }).toMatchObject({ code: 0 })
    expect(child.output, "no CLI-spawning test ran, so nothing was proven").toMatch(/\b[1-9]\d* pass\b/)
    expect(child.written).toEqual([])
  },
  300_000,
)
