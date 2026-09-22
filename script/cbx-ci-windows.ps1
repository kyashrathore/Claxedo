param(
  [ValidateSet("unit", "opencode-node", "package", "package-test")]
  [string]$Lane = "unit",
  [string]$Package,
  [switch]$AclAcceptance,
  [switch]$CleanInstall,
  [string]$NodeVersion,
  # turbo stops at the first failing package; an inventory run wants them all.
  [switch]$Continue
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
. (Join-Path $PSScriptRoot "cbx-prepare-windows.ps1") -CleanInstall:$CleanInstall -NodeVersion $NodeVersion

$env:CI = "true"
$env:OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
if ($AclAcceptance) {
  $env:CLAXEDO_WINDOWS_ACL_ACCEPTANCE = "1"
}
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

bun run build:packages
Assert-LastExitCode "bun run build:packages"

bun run --cwd packages/workspace-runtime test:opencode-node
Assert-LastExitCode "bun run --cwd packages/workspace-runtime test:opencode-node"
if ($Lane -eq "opencode-node") {
  exit 0
}

$turboArguments = @("test", "--concurrency=2")
if ($Continue) {
  $turboArguments += "--continue"
}
bun turbo @turboArguments
Assert-LastExitCode "bun turbo $turboArguments"
