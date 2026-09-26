import { describe, expect, test } from "bun:test"

import { u8PackageBoundarySteps } from "./verify-u8-package-boundary"

describe("U8 package boundary public gate", () => {
  test("builds one signed-capable artifact and inventories its packaged resources", () => {
    expect(u8PackageBoundarySteps("darwin")).toEqual([
      {
        label: "signed-capable package",
        command: ["bun", "run", "package:mac", "--", "--dir", "--publish", "never"],
        env: { VITE_CLAXEDO_HOSTED_ACTIVATION: "true", CSC_IDENTITY_AUTO_DISCOVERY: "false" },
      },
      { label: "packaged resource inventory", command: ["bun", "./scripts/verify-package-contents.ts"] },
    ])
  })

  test("refuses to substitute a non-mac package for the macOS artifact contract", () => {
    expect(() => u8PackageBoundarySteps("linux")).toThrow(/requires macOS/)
  })

  test("reuses the release workflow's exact package without rebuilding it", () => {
    expect(u8PackageBoundarySteps("darwin", { existingPackage: true })).toEqual([
      { label: "packaged resource inventory", command: ["bun", "./scripts/verify-package-contents.ts"] },
    ])
  })
})
