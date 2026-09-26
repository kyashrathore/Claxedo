param(
  [Parameter(Mandatory = $true)][string]$Flow,
  [switch]$Red
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$toolsRoot = Join-Path $env:LOCALAPPDATA "Claxedo\tools"
$nodeDirs = @(Get-ChildItem -LiteralPath $toolsRoot -Directory -Filter "node-v24.*-win-x64")
if ($nodeDirs.Count -ne 1) { throw "Expected one prepared Node 24 directory under $toolsRoot; found $($nodeDirs.Count)" }
$nodeExe = Join-Path $nodeDirs[0].FullName "node.exe"
$bunExe = Join-Path $toolsRoot "bun-windows-x64-baseline\bun.exe"
if (-not (Test-Path -LiteralPath $nodeExe) -or -not (Test-Path -LiteralPath $bunExe)) {
  throw "Prepared Node or Bun executable is missing under $toolsRoot"
}
$homeDir = Join-Path $env:TEMP ("claxedo-e2e-home-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $homeDir | Out-Null

try {
  $env:CLAXEDO_E2E_NODE = $nodeExe
  $env:PATH = "$($nodeDirs[0].FullName);$(Split-Path $bunExe);$env:PATH"
  Set-Location $root
  $env:HOME = $homeDir
  $env:USERPROFILE = $homeDir
  $env:APPDATA = Join-Path $homeDir "AppData\Roaming"
  $env:LOCALAPPDATA = Join-Path $homeDir "AppData\Local"
  $env:XDG_CONFIG_HOME = Join-Path $homeDir ".config"
  $env:XDG_DATA_HOME = Join-Path $homeDir ".local\share"
  $env:XDG_STATE_HOME = Join-Path $homeDir ".local\state"
  $env:XDG_CACHE_HOME = Join-Path $homeDir ".cache"
  $env:CLAXEDO_E2E_PORT_RANGE = "47000-47099"
  if ($Red) { $env:CLAXEDO_E2E_H23_RED = "1" }
  & $bunExe run --cwd packages/harness flows $Flow
  exit $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $homeDir -Recurse -Force
}
