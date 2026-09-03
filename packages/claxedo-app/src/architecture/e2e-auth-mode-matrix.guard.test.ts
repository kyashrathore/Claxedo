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
const workgraphStressWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/workgraph-stress.yml"), "utf8")
const setupBun = readFileSync(path.join(repoRoot, ".github/actions/setup-bun/action.yml"), "utf8")
const crabboxGroups = readFileSync(path.join(repoRoot, "script/cbx-ci.ts"), "utf8")
const crabboxCi = readFileSync(path.join(repoRoot, "script/cbx-ci-remote.sh"), "utf8")
const crabboxShard = readFileSync(path.join(repoRoot, "script/cbx-e2e-shard.sh"), "utf8")
const authMode = readFileSync(path.join(appRoot, "e2e/auth-mode.ts"), "utf8")
const buildApp = readFileSync(path.join(appRoot, "scripts/build-e2e-app.ts"), "utf8")
const serveApp = readFileSync(path.join(appRoot, "scripts/serve-e2e-app.ts"), "utf8")
const matrixRunner = readFileSync(path.join(appRoot, "scripts/run-e2e-auth-matrix.ts"), "utf8")
/** Every process that starts this app's vite config for the e2e suite. */
const viteLaunchers = Object.fromEntries(
  [
    "scripts/build-e2e-app.ts",
    "scripts/serve-e2e-app.ts",
    "e2e/playwright/live-user-hosted-relay.spec.ts",
    "e2e/playwright/real-cloud-relay.spec.ts",
    "e2e/helpers/desktop-signed-server.ts",
  ].map((file) => [file, readFileSync(path.join(appRoot, file), "utf8")] as const),
)
const packageJson = JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>
}
const coreE2EJob = workflow.slice(workflow.indexOf("\n  e2e:\n"), workflow.indexOf("\n  e2e-onboarding:\n"))
const reusableE2EBuildJob = workflow.slice(workflow.indexOf("\n  e2e-build:\n"), workflow.indexOf("\n  e2e:\n"))

describe("e2e auth mode matrix", () => {
  test("Playwright owns both explicit modes and a real no-user Vite composition", () => {
    expect(authMode).toContain('e2eAuthModes = ["test-user", "local-unsigned"] as const')
    expect(authMode).toContain('VITE_CLAXEDO_DISABLE_TEST_AUTH_BYPASS: "1"')
    expect(authMode).toContain('VITE_CLERK_PUBLISHABLE_KEY: ""')
    expect(authMode).toContain('VITE_AUTH_ENABLED: "true"')
    expect(config).toContain("resolveE2EAuthMode()")
  })

  /**
   * `vite.cloud.config.ts` refuses to resolve a browser auth adapter
   * implicitly, so a launcher that restates the build environment instead of
   * reading `e2eAppViteEnvironment` does not serve a subtly different app — it
   * exits before it can listen, and every spec behind it then fails on the
   * launcher's own health gate rather than on anything it meant to test. The
   * failure surfaces far from its cause, so the single owner is guarded here
   * rather than left to each launcher to remember.
   */
  test("every e2e vite launcher reads the one build-environment owner", () => {
    expect(authMode).toContain("export function e2eAppViteEnvironment(")
    expect(authMode).toContain('VITE_CLAXEDO_AUTH_ADAPTER: "clerk"')
    expect(authMode).toContain('VITE_CLAXEDO_E2E: "1"')
    for (const [name, source] of Object.entries(viteLaunchers)) {
      // The spread into the child's env, not a mention in prose: a launcher
      // that documents the owner but stops passing it still fails to start.
      expect(source, `${name} must spread e2eAppViteEnvironment into its child env`).toMatch(
        /\.\.\.e2eAppViteEnvironment\(/,
      )
      expect(source, `${name} must not restate the adapter selection`).not.toContain("VITE_CLAXEDO_AUTH_ADAPTER")
    }
  })

  test("default, core, and mobile entrypoints use the failure-aggregating matrix runner", () => {
    expect(matrixRunner).toContain('import { e2eAuthModes } from "../e2e/auth-mode"')
    expect(matrixRunner).toContain("for (const authMode of e2eAuthModes)")
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
    expect(workflow).toContain("playwright-onboarding-${{ matrix.auth-mode }}")
  })

  test("CI builds each auth composition once and six shards preview its exact artifact", () => {
    expect(workflow).toContain("name: claxedo-e2e-workspace-dist-${{ github.sha }}-${{ github.run_attempt }}")
    expect(workflow).toContain("e2e-build:")
    expect(workflow).toContain("name: claxedo-app-e2e-test-user-${{ github.sha }}-${{ github.run_attempt }}")
    expect(workflow).toContain("name: claxedo-app-e2e-local-unsigned-${{ github.sha }}-${{ github.run_attempt }}")
    expect(workflow).toContain("needs: [changes, e2e-build]")
    expect(workflow).toContain("shard: [1, 2, 3, 4, 5, 6]")
    expect(workflow).toContain("--shard=${{ matrix.shard }}/6")
    expect(workflow).toContain("CLAXEDO_E2E_SERVE_MODE: preview")
    expect(reusableE2EBuildJob.match(/VITE_CLAXEDO_SETTINGS_CONNECTIONS_ENABLED: "true"/g)).toHaveLength(2)
    expect(reusableE2EBuildJob.match(/VITE_CLAXEDO_SETTINGS_SANDBOX_PROVIDERS_ENABLED: "true"/g)).toHaveLength(2)
    expect(workflow).not.toContain("CLAXEDO_E2E_PREBUILT")
    expect(crabboxCi).not.toContain("CLAXEDO_E2E_PREBUILT")
    expect(crabboxShard).not.toContain("CLAXEDO_E2E_PREBUILT")
    expect(crabboxCi).toContain("CLAXEDO_E2E_SERVE_MODE=build-preview")
    expect(crabboxCi).toContain("CLAXEDO_E2E_SERVE_MODE=preview")
    expect(crabboxShard).toContain("CLAXEDO_E2E_SERVE_MODE=build-preview")
    expect(coreE2EJob).toContain("Download reusable workspace dist")
    expect(coreE2EJob).not.toContain("bun turbo build")
    expect(workflow).not.toContain("e2e-workgraph:")
    expect(workflow).not.toContain("e2e-workgraph-journey:")
    expect(workflow).not.toContain("run: bun run test:e2e:workgraph")
    expect(workflow).not.toContain("run: bun run test:e2e:journey")
    expect(packageJson.scripts["test:e2e"]).toContain("test:e2e:core:base test:e2e:onboarding")
    expect(packageJson.scripts["test:e2e:core"]).not.toContain("test:e2e:workgraph")
    expect(packageJson.scripts["test:e2e:mobile:mode"]).toContain('--grep-invert "@workgraph-real"')
    expect(crabboxGroups).not.toContain("pr-e2e-workgraph")
    expect(workgraphStressWorkflow).toContain("workflow_dispatch:")
    expect(workgraphStressWorkflow).not.toContain("\n  schedule:")

    expect(buildApp).toContain("e2eAppViteEnvironment(authMode)")
    expect(buildApp).toContain("claxedo-e2e-build.json")
    expect(serveApp).toContain('if (mode === "build-preview")')
    expect(serveApp).toContain("E2E artifact auth mode")
    expect(serveApp).toContain("E2E artifact commit")
  })

  test("Windows skips the measured-slower Bun download cache", () => {
    expect(setupBun).toContain("if: runner.os != 'Windows'")
    expect(setupBun).toContain("if: runner.os != 'Windows' && steps.bun-cache.outputs.cache-hit != 'true'")
  })

  test("CI gates the signed org-team multiplayer proof with the real-tier environment", () => {
    const stepStart = workflow.indexOf("- name: Run signed web relay e2e")
    const signedRelayStep = workflow.slice(
      stepStart,
      workflow.indexOf("- name: Upload Playwright artifacts", stepStart),
    )
    expect(signedRelayStep).toContain('CLAXEDO_TIER_REAL_E2E: "1"')
    expect(signedRelayStep).toContain("e2e/playwright/web-signed-org-team-multiplayer.spec.ts")
  })
})
