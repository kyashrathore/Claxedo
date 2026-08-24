param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern("^[0-9a-f]{40}$")]
  [string]$SourceCommit
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$desktop = Join-Path $root "packages\claxedo-desktop"

. (Join-Path $PSScriptRoot "cbx-prepare-windows.ps1") -ToolsOnly

# Archives created on macOS can materialize resource forks as AppleDouble
# files on Windows. They are not repository sources, but broad test globs would
# otherwise try to parse names such as `._example.test.ts` as TypeScript.
$appleDoubleFiles = @(
  Get-ChildItem (Join-Path $desktop "src") -Recurse -Force -File -Filter "._*"
  Get-ChildItem (Join-Path $desktop "scripts") -Recurse -Force -File -Filter "._*"
)
if ($appleDoubleFiles.Count -gt 0) {
  $appleDoubleFiles | Remove-Item -Force
  Write-Output "Removed $($appleDoubleFiles.Count) macOS AppleDouble transfer artifacts"
}

function Assert-LastExitCode([string]$Command) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Command exited $LASTEXITCODE"
  }
}

Set-Location $root
$env:CI = "true"
$env:CLAXEDO_CHANNEL = "prod"
# The acceptance workspace may be transferred without .git metadata. Release
# builds provide both inputs explicitly, so exercise those same authoritative
# inputs instead of asking either build to infer them from absent metadata.
$env:OPENCODE_CHANNEL = "windows-e2e"
$env:CLAXEDO_BUILD_SOURCE_COMMIT = $SourceCommit
$env:RUST_TARGET = "x86_64-pc-windows-msvc"
$env:CLAXEDO_DIAGNOSTICS_EXPECTED_ARCH = "x64"
$env:CLAXEDO_DIAGNOSTICS_DEBUG = "1"

bun turbo build `
  --filter=@claxedo/agent-event-runtime `
  --filter=@claxedo/agent-extensions `
  --filter=@claxedo/agent-sdk-runtime `
  --filter=@claxedo/channels `
  --filter=@claxedo/connections `
  --filter=@claxedo/mcp `
  --filter=@claxedo/sandbox-contract `
  --filter=@claxedo/sandbox-manager `
  --filter=@claxedo/wakes `
  --filter=@claxedo/workgraph `
  --filter=@claxedo/workspace-relay-protocol `
  --filter=@claxedo/workspace-relay `
  --filter=@claxedo/workspace-runtime
Assert-LastExitCode "workspace build"

Set-Location $desktop
bun run typecheck
Assert-LastExitCode "desktop typecheck"

bun run build
Assert-LastExitCode "desktop build"

# Build-fixture tests now see artifacts from this exact source commit. The
# package's canonical suite gives every Bun.build fixture a fresh process on
# every platform, rather than reading stale generated output or resolver state.
bun run test
Assert-LastExitCode "desktop tests"

New-Item -ItemType Directory -Force -Path ".artifacts" | Out-Null
$env:CLAXEDO_DIAGNOSTICS_SMOKE_OUTPUT = ".artifacts\diagnostics-source-x86_64-pc-windows-msvc.json"
bun run test:diagnostics-release
Assert-LastExitCode "source diagnostics release tests"

bun run smoke:diagnostics
Assert-LastExitCode "source diagnostics smoke"

$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
bun run package:win -- --x64 --dir --publish never
Assert-LastExitCode "unsigned Windows package"

$env:CLAXEDO_DIAGNOSTICS_SMOKE_OUTPUT = ".artifacts\diagnostics-packaged-x86_64-pc-windows-msvc.json"
bun run smoke:diagnostics:packaged
Assert-LastExitCode "packaged diagnostics smoke"

Write-Output "Windows desktop acceptance passed"
