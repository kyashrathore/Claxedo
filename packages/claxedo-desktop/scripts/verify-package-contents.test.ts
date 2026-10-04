import { describe, expect, test } from "bun:test"
import { canSmokePackagedBinary } from "./verify-package-contents"

describe("packaged native smoke policy", () => {
  test("executes helpers only for the host platform and architecture", () => {
    expect(canSmokePackagedBinary({ platform: process.platform, arch: process.arch })).toBe(true)
    expect(canSmokePackagedBinary({ platform: process.platform === "win32" ? "darwin" : "win32", arch: process.arch })).toBe(false)
    expect(canSmokePackagedBinary({ platform: process.platform, arch: process.arch === "arm64" ? "x64" : "arm64" })).toBe(false)
  })
})
