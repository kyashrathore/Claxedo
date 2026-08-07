import { describe, expect, test } from "bun:test"
import { claxedoServerExecArgv } from "./server-runtime-policy"

describe("claxedoServerExecArgv", () => {
  test("uses Electron's supported V8 flag transport with conservative server headroom", () => {
    expect(claxedoServerExecArgv()).toEqual([
      "--js-flags=--expose-gc --optimize-for-size --max-old-space-size=512",
    ])
  })

  test("keeps normal JIT execution enabled", () => {
    expect(claxedoServerExecArgv().join(" ")).not.toContain("--jitless")
  })
})
