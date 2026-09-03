param(
  [ValidateSet("unit", "package", "package-test")]
  [string]$Lane = "unit",
  [string]$Package
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

function Assert-LastExitCode([string]$Command) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Command exited $LASTEXITCODE"
  }
}

# Native Windows is a separate Crabbox job because Linux cannot validate the
# Windows process-tree dependency, path rules, or PowerShell execution path.
. (Join-Path $PSScriptRoot "cbx-prepare-windows.ps1")

$env:CI = "true"
$env:OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
& git config --global user.email "github-actions[bot]@users.noreply.github.com"
Assert-LastExitCode "git config user.email"
& git config --global user.name "github-actions[bot]"
Assert-LastExitCode "git config user.name"
& git config --global user.email "github-actions[bot]@users.noreply.github.com"
Assert-LastExitCode "git config user.email"
& git config --global user.name "github-actions[bot]"
Assert-LastExitCode "git config user.name"

if ($Lane -eq "package" -or $Lane -eq "package-test") {
  if (-not $Package -or $Package -notmatch '^@[a-z0-9-]+/[a-z0-9-]+$') {
    throw "The package lane requires a scoped package name"
  }
  if ($Lane -eq "package") {
    bun turbo build "--filter=$Package..."
    Assert-LastExitCode "bun turbo build --filter=$Package..."
  }
  bun turbo test "--filter=$Package" --concurrency=2
  Assert-LastExitCode "bun turbo test --filter=$Package --concurrency=2"
  exit 0
}

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
  --filter=@claxedo/workspace-relay-protocol `
  --filter=@claxedo/workspace-relay `
  --filter=@claxedo/workspace-runtime
Assert-LastExitCode "bun turbo build"

bun turbo test --concurrency=2
Assert-LastExitCode "bun turbo test --concurrency=2"
