import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"

const root = path.resolve(import.meta.dirname, "../../..")
const workflow = readFileSync(path.join(root, ".github/workflows/test.yml"), "utf8")
const prepare = readFileSync(path.join(root, "script/cbx-prepare-windows.ps1"), "utf8")
const acceptance = readFileSync(path.join(root, "script/cbx-test-windows.ps1"), "utf8")
const desktopManifest = JSON.parse(readFileSync(path.join(root, "packages/claxedo-desktop/package.json"), "utf8")) as {
  dependencies: Record<string, string>
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
  test("runs the unit matrix on Windows as a blocking check", () => {
    expect(workflow).toContain("- name: windows\n            host: windows-latest")
    expect(workflow).not.toContain("continue-on-error: ${{ matrix.settings.host == 'windows-latest' }}")
    expect(acceptance).toContain("--path-ignore-patterns=opencode-compile-cache-boot.test.ts")
    expect(acceptance).toContain("bun test ./scripts/opencode-compile-cache-boot.test.ts --max-concurrency=1")
    expect(acceptance).toContain('Assert-LastExitCode "desktop compile-cache boot tests"')
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
    expect(prepare).toContain('throw "bun install exited $LASTEXITCODE"')
    expect(prepare).toContain('throw "Windows process-tree native dependency was not installed"')
  })

  test("builds the local-server distribution before packaged desktop fixtures", () => {
    const desktopLaneStart = workflow.indexOf("  e2e-desktop:")
    const nextLaneStart = workflow.indexOf("\n  e2e-workgraph-journey:", desktopLaneStart)
    const desktopLane = workflow.slice(desktopLaneStart, nextLaneStart)
    const localServerBuild = desktopLane.indexOf("bun run --cwd packages/claxedo-local-server build")
    const desktopE2e = desktopLane.indexOf("run: bun run test:e2e:desktop")

    expect(desktopLaneStart).toBeGreaterThan(-1)
    expect(nextLaneStart).toBeGreaterThan(desktopLaneStart)
    expect(localServerBuild).toBeGreaterThan(-1)
    expect(desktopE2e).toBeGreaterThan(localServerBuild)
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
