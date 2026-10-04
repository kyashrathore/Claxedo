import { describe, expect, test } from "bun:test"
import { claxedoServerExecArgv } from "./server-runtime-policy"

describe("claxedoServerExecArgv", () => {
  test("uses Node-mode V8 flags with conservative server headroom", () => {
    expect(claxedoServerExecArgv()).toEqual([
      "--expose-gc",
      "--optimize-for-size",
      "--max-old-space-size=512",
    ])
  })

  test("keeps normal JIT execution enabled", () => {
    expect(claxedoServerExecArgv().join(" ")).not.toContain("--jitless")
  })

  test("records a CPU profile only when a profile directory is requested", () => {
    const previous = process.env.CLAXEDO_SERVER_V8_PROF_DIR
    try {
      process.env.CLAXEDO_SERVER_V8_PROF_DIR = "/tmp/claxedo-server-profiles"
      expect(claxedoServerExecArgv()).toEqual([
        "--expose-gc",
        "--optimize-for-size",
        "--max-old-space-size=512",
        "--cpu-prof",
        "--cpu-prof-dir=/tmp/claxedo-server-profiles",
        "--cpu-prof-interval=500",
      ])
      process.env.CLAXEDO_SERVER_V8_PROF_DIR = "  "
      expect(claxedoServerExecArgv()).toHaveLength(3)
    } finally {
      if (previous === undefined) delete process.env.CLAXEDO_SERVER_V8_PROF_DIR
      else process.env.CLAXEDO_SERVER_V8_PROF_DIR = previous
    }
  })
})
