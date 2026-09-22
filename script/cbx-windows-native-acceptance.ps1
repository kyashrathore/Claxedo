param(
  [switch]$AclAcceptance
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

# turbo gates a package's test task behind the app and server suites, so a
# native suite that only needs its own package runs here with bun directly.
. (Join-Path $PSScriptRoot "cbx-prepare-windows.ps1") -ToolsOnly

$env:CI = "true"
if ($AclAcceptance) {
  $env:CLAXEDO_WINDOWS_ACL_ACCEPTANCE = "1"
}

$suites = @(
  @{ Package = "packages\workspace-runtime"; Files = @("src/workspace-files/working-tree.test.ts") },
  @{ Package = "packages\claxedo-desktop"; Files = @("./src/main/apps.test.ts", "./src/main/apps.windows.test.ts") },
  @{ Package = "packages\cli"; Files = @("src/open-url.test.ts", "src/open-url.windows.test.ts") },
  @{ Package = "packages\agent-sdk-runtime"; Files = @("src/harnesses/acp/transport.windows.test.ts", "src/harnesses/codex/app-server-process.windows.test.ts") }
)

$failed = 0
foreach ($suite in $suites) {
  Write-Output "=== SUITE $($suite.Package)"
  Set-Location (Join-Path $root $suite.Package)
  & bun test @($suite.Files) --timeout 30000
  Write-Output "=== SUITE EXIT $($suite.Package) $LASTEXITCODE"
  if ($LASTEXITCODE -ne 0) { $failed += 1 }
  Set-Location $root
}
if ($failed -ne 0) { throw "$failed native suite(s) failed" }
