import { describe, expect, test } from "bun:test"

import { u8PackageBoundarySteps } from "./verify-u8-package-boundary"
import { u8SmokeCommand } from "./u8-smoke-runner"

describe("U8 package boundary public gate", () => {
  test("builds one signed-capable artifact and traces unsigned before signed activation", () => {
    expect(u8PackageBoundarySteps("darwin")).toEqual([
      {
        label: "signed-capable package",
        command: ["bun", "run", "package:mac", "--", "--dir", "--publish", "never"],
        env: { VITE_AUTH_ENABLED: "true", CSC_IDENTITY_AUTO_DISCOVERY: "false" },
      },
      { label: "packaged resource inventory", command: ["bun", "./scripts/verify-package-contents.ts"] },
      { label: "unsigned startup trace", command: ["bun", "./scripts/u8-packaged-smoke.ts"] },
      { label: "signed activation trace", command: ["bun", "./scripts/u8-signed-activation-smoke.ts"] },
    ])
  })

  test("refuses to substitute a non-mac package for the macOS artifact contract", () => {
    expect(() => u8PackageBoundarySteps("linux")).toThrow(/requires macOS/)
  })

  test("reuses the release workflow's exact package without rebuilding it", () => {
    expect(u8PackageBoundarySteps("darwin", { existingPackage: true })).toEqual([
      { label: "packaged resource inventory", command: ["bun", "./scripts/verify-package-contents.ts"] },
      { label: "unsigned startup trace", command: ["bun", "./scripts/u8-packaged-smoke.ts"] },
      { label: "signed activation trace", command: ["bun", "./scripts/u8-signed-activation-smoke.ts"] },
    ])
  })

  test("the two traces select distinct real packaged scenarios", () => {
    expect(u8SmokeCommand("unsigned")).toContain("unsigned startup")
    expect(u8SmokeCommand("signed-activation")).toContain("fixture OAuth activates")
  })
})
