param(
  [ValidateSet("unit", "opencode-node", "package", "package-test")]
  [string]$Lane = "unit",
  [string[]]$Package,
  [switch]$AclAcceptance,
  # GitHub's unit job builds only the dist-resolved packages before testing;
  # `package` builds every dependency, which Bun cannot do for local-server on Windows.
  [switch]$BuildPackages,
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
  # `powershell.exe -File` hands a comma list over as one string.
  $Package = @($Package | ForEach-Object { $_ -split "," } | Where-Object { $_ })
  if (-not $Package -or @($Package | Where-Object { $_ -notmatch '^@[a-z0-9-]+/[a-z0-9-]+$' }).Count -gt 0) {
    throw "The package lane requires scoped package names"
  }
  if ($Lane -eq "package") {
    $buildFilters = @($Package | ForEach-Object { "--filter=$_..." })
    bun turbo build @buildFilters
    Assert-LastExitCode "bun turbo build $buildFilters"
  }
  if ($BuildPackages) {
    bun run build:packages
    Assert-LastExitCode "bun run build:packages"
  }
  $testArguments = @("test") + @($Package | ForEach-Object { "--filter=$_" }) + @("--concurrency=2")
  if ($Continue) {
    $testArguments += "--continue"
  }
  bun turbo @testArguments
  Assert-LastExitCode "bun turbo $testArguments"
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
