/**
 * GUARD: the watched browser suite must exercise every flow both with the
 * historical synthetic Test User and as a loopback visitor with no user.
 *
 * The Test User used to be implicit (`navigator.webdriver === true`), so a
 * green Playwright suite said nothing about the state real unsigned local
 * users actually run. This guard binds together the config registry, package
 * entrypoints, and CI matrix so removing any half of the pair fails loudly.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const appRoot = path.resolve(import.meta.dir, "../..")
const repoRoot = path.resolve(appRoot, "../..")
const config = readFileSync(path.join(appRoot, "playwright.config.ts"), "utf8")
const workflow = readFileSync(path.join(repoRoot, ".github/workflows/test.yml"), "utf8")
const matrixRunner = readFileSync(path.join(appRoot, "scripts/run-e2e-auth-matrix.ts"), "utf8")
const packageJson = JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>
}

describe("e2e auth mode matrix", () => {
  test("Playwright owns both explicit modes and a real no-user Vite composition", () => {
    expect(config).toContain('const authModes = ["test-user", "local-unsigned"] as const')
    expect(config).toContain("VITE_CLAXEDO_DISABLE_TEST_AUTH_BYPASS=1")
    expect(config).toContain("VITE_CLERK_PUBLISHABLE_KEY=")
    expect(config).toContain("VITE_AUTH_ENABLED=true")
  })

  test("default, core, and mobile entrypoints use the failure-aggregating matrix runner", () => {
    expect(matrixRunner).toContain('const authModes = ["test-user", "local-unsigned"] as const')
    expect(matrixRunner).toContain("for (const authMode of authModes)")
    expect(matrixRunner).toContain("if (exitCode !== 0 && firstFailure === 0)")

    for (const script of ["test:e2e", "test:e2e:core", "test:e2e:mobile"]) {
      const command = packageJson.scripts[script]
      expect(command, `${script} must exist`).toBeTruthy()
      expect(command, `${script} must use the matrix runner`).toContain("run-e2e-auth-matrix.ts")
      expect(command, `${script} must not stop before the unsigned pass`).not.toContain("&&")
    }
  })

  test("every watched CI job runs once per auth mode and keeps artifacts distinct", () => {
    expect(workflow).toContain("auth-mode: [test-user, local-unsigned]")
    expect(workflow).toContain("CLAXEDO_E2E_AUTH_MODE: ${{ matrix.auth-mode }}")
    expect(workflow).toContain("playwright-linux-${{ matrix.auth-mode }}-shard${{ matrix.shard }}")
    expect(workflow).toContain("playwright-workgraph-real-${{ matrix.auth-mode }}")
  })
})
