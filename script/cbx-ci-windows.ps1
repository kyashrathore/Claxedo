param(
  [ValidateSet("unit", "agent-runtime-stats", "package")]
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

$agentRuntimeStats = Join-Path $root "packages\agent-runtime-stats"
if ($Lane -eq "agent-runtime-stats") {
  $toolsRoot = Join-Path $env:LOCALAPPDATA "Claxedo\tools"
  $downloads = Join-Path $toolsRoot "downloads"
  New-Item -ItemType Directory -Force -Path $toolsRoot, $downloads | Out-Null
  $checksums = & curl.exe --fail --location --silent --show-error "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt"
  Assert-LastExitCode "download Node 22 checksums"
  $archiveName = (($checksums -join "`n") -split '\s+' |
    Where-Object { $_ -like "node-v22.*-win-x64.zip" } |
    Select-Object -First 1)
  if (-not $archiveName) {
    throw "Could not resolve the latest Node.js 22 Windows archive"
  }
  $expectedHash = (($checksums | Where-Object { $_ -match "\s+$([regex]::Escape($archiveName))$" }) -split '\s+')[0]
  $nodeDirectory = $archiveName -replace '\.zip$', ''
  $nodePath = Join-Path $toolsRoot $nodeDirectory
  if (-not (Test-Path (Join-Path $nodePath "node.exe"))) {
    $archive = Join-Path $downloads $archiveName
    & curl.exe --fail --location --silent --show-error --output $archive "https://nodejs.org/dist/latest-v22.x/$archiveName"
    Assert-LastExitCode "download Node 22"
    if ((Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant() -ne $expectedHash.ToLowerInvariant()) {
      throw "Node 22 archive checksum mismatch"
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $toolsRoot -Force
  }
  $env:PATH = "$nodePath;$env:PATH"
  if (-not ((node --version) -like "v22.*")) { throw "Node 22 activation failed" }
  Set-Location $agentRuntimeStats
  npm test
  Assert-LastExitCode "npm test"
  node bin/agent-runtime-stats.js --version
  Assert-LastExitCode "agent-runtime-stats --version"
  exit 0
}

# Native Windows is a separate Crabbox job because Linux cannot validate the
# Windows process-tree dependency, path rules, or PowerShell execution path.
. (Join-Path $PSScriptRoot "cbx-prepare-windows.ps1")

$env:CI = "true"
$env:OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"

if ($Lane -eq "package") {
  if (-not $Package -or $Package -notmatch '^@[a-z0-9-]+/[a-z0-9-]+$') {
    throw "The package lane requires a scoped package name"
  }
  bun turbo build "--filter=$Package..."
  Assert-LastExitCode "bun turbo build --filter=$Package..."
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
  --filter=@claxedo/workgraph `
  --filter=@claxedo/workspace-relay-protocol `
  --filter=@claxedo/workspace-relay `
  --filter=@claxedo/workspace-runtime
Assert-LastExitCode "bun turbo build"

bun turbo test --concurrency=2
Assert-LastExitCode "bun turbo test --concurrency=2"
