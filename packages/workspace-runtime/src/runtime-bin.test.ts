import { describe, expect, test } from "bun:test"
import path from "path"
import {
  prependWorkspaceRuntimeBin,
  workspaceRuntimeBinDir,
} from "./runtime-bin"

describe("workspace runtime bundled binaries", () => {
  test("resolves the package .bin directory", () => {
    expect(workspaceRuntimeBinDir().endsWith(path.join("node_modules", ".bin"))).toBe(true)
  })


  test("prepends bundled binaries to terminal PATH once", () => {
    const bin = workspaceRuntimeBinDir()
    expect(prependWorkspaceRuntimeBin("/usr/bin")).toBe(`${bin}${path.delimiter}/usr/bin`)
    expect(prependWorkspaceRuntimeBin(`${bin}${path.delimiter}/usr/bin`)).toBe(`${bin}${path.delimiter}/usr/bin`)
  })
})
