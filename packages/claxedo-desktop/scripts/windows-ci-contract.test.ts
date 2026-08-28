import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"

const root = path.resolve(import.meta.dirname, "../../..")
const workflow = readFileSync(path.join(root, ".github/workflows/test.yml"), "utf8")
const changePolicy = readFileSync(path.join(root, "script/ci-changes.mjs"), "utf8")
const releaseWorkflow = readFileSync(path.join(root, ".github/workflows/release-claxedo.yml"), "utf8")
const releaseGatesWorkflow = readFileSync(path.join(root, ".github/workflows/release-gates.yml"), "utf8")
const crabboxRunner = readFileSync(path.join(root, "script/cbx-ci.ts"), "utf8")
const prepare = readFileSync(path.join(root, "script/cbx-prepare-windows.ps1"), "utf8")
const acceptance = readFileSync(path.join(root, "script/cbx-test-windows.ps1"), "utf8")
const desktopManifest = JSON.parse(readFileSync(path.join(root, "packages/claxedo-desktop/package.json"), "utf8")) as {
  dependencies: Record<string, string>
  scripts: Record<string, string>
}
const mcpManifest = JSON.parse(readFileSync(path.join(root, "packages/claxedo-mcp/package.json"), "utf8")) as {
  dependencies: Record<string, string>
}
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  patchedDependencies?: Record<string, string>
  claxedoDependencyPatches?: Record<string, string>
  scripts: Record<string, string>
}

describe("Windows CI contract", () => {
  test("runs the Windows unit matrix only for affected native surfaces", () => {
    expect(workflow).toContain("settings: ${{ fromJSON(needs.changes.outputs.unit_matrix) }}")
    expect(workflow).toContain("if: needs.changes.outputs.unit == 'true'")
    expect(changePolicy).toContain('{ name: "windows", host: "windows-latest" }')
    expect(changePolicy).toContain("const WINDOWS_PREFIXES = [")
    expect(workflow).not.toContain("continue-on-error: ${{ matrix.settings.host == 'windows-latest' }}")
    expect(acceptance).toContain("bun run test")
    expect(desktopManifest.scripts.test).toBe(
      "bun run test:broad && bun run test:bundle-single && bun run test:server-boot && bun run test:compile-cache",
    )
    expect(desktopManifest.scripts["test:broad"]).toContain(
      "--path-ignore-patterns='**/bundle-single-instance.test.ts'",
    )
    expect(desktopManifest.scripts["test:broad"]).toContain("--path-ignore-patterns='**/claxedo-server-boot.test.ts'")
    expect(desktopManifest.scripts["test:broad"]).toContain(
      "--path-ignore-patterns='**/opencode-compile-cache-boot.test.ts'",
    )
    expect(desktopManifest.scripts["test:bundle-single"]).toContain("bun test ./scripts/bundle-single-instance.test.ts")
    expect(desktopManifest.scripts["test:server-boot"]).toContain("bun test ./scripts/claxedo-server-boot.test.ts")
    expect(desktopManifest.scripts["test:compile-cache"]).toContain(
      "bun test ./scripts/opencode-compile-cache-boot.test.ts",
    )
    expect(acceptance.indexOf("\nbun run build\n")).toBeLessThan(acceptance.indexOf("\nbun run test\n"))
  })

  test("applies dependency patches after Bun resolves peer variants", () => {
    expect(manifest.patchedDependencies).toBeUndefined()
    expect(manifest.claxedoDependencyPatches).not.toHaveProperty("effect@4.0.0-beta.83")
    expect(manifest.scripts.postinstall).toStartWith("bun script/apply-dependency-patches.ts")
  })

  test("prepares bare Windows hosts from the repository's toolchain contract", () => {
    expect(prepare).toContain("$bunVersion = $manifest.packageManager")
    expect(prepare).toContain("https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt")
    expect(prepare).toContain("Microsoft.VisualStudio.Workload.VCTools")
    expect(prepare).toContain("Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre")
    expect(prepare).toContain("bun install --frozen-lockfile")
    expect(prepare).not.toContain("--linker hoisted")
    expect(prepare).toContain("[switch]$CleanInstall")
    expect(prepare).toContain("$workspaceRoots = @($root)")
    expect(prepare).toContain("Get-ChildItem $workspaceParent -Directory")
    expect(prepare).toContain('Join-Path $workspaceRoot "node_modules"')
    expect(acceptance).toContain('$env:OPENCODE_CHANNEL = "windows-e2e"')
    expect(acceptance).toContain('[ValidatePattern("^[0-9a-f]{40}$")]')
    expect(acceptance).toContain("$env:CLAXEDO_BUILD_SOURCE_COMMIT = $SourceCommit")
    expect(prepare).toContain('throw "bun install exited $LASTEXITCODE"')
    expect(prepare).toContain('throw "Windows process-tree native dependency was not installed"')
  })

  test("keeps desktop compilation behind explicit release entrypoints", () => {
    expect(workflow).not.toContain("packages/claxedo-desktop")
    expect(workflow).not.toContain("test:e2e:desktop")
    expect(releaseWorkflow).toContain("- name: Build desktop")
    expect(releaseGatesWorkflow).toContain("- name: Build desktop")
    expect(crabboxRunner).toContain('if (arg === "--release")')
    expect(crabboxRunner).toContain('"pr-e2e-desktop-macos"')
    expect(crabboxRunner).toContain("is release-only; rerun with --release")
    expect(crabboxRunner).toContain("if (options.release) jobs =")
  })

  test("declares the MCP SDK modules bundled by the Windows build", () => {
    expect(mcpManifest.dependencies).toMatchObject({
      ajv: "8.20.0",
      "ajv-formats": "3.0.1",
      "zod-to-json-schema": "3.25.2",
    })
  })

  test("uses the shared UI's canonical Marked version", () => {
    expect(desktopManifest.dependencies.marked).toBeUndefined()
  })
})
