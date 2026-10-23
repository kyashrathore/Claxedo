# Installs the claxedo command for the current Windows user, with no admin, and
# given a pairing code from Claxedo's "Connect a machine..." also connects this
# machine, sharing the folder the command runs in once its owner approves it.
#
#   & ([scriptblock]::Create((irm https://<control plane>/api/claxedo/connect.ps1))) <pairing code>
#
# The control plane serves this file at /api/claxedo/connect.ps1 with the
# defaults of -ControlPlane and -MinimumCliVersion filled in, so a code is
# always redeemed where it was minted.
#
# Environment:
#   CLAXEDO_CLI_VERSION   npm version or dist-tag to install (default: latest)
#   CLAXEDO_CLI_TARBALL   one or more local .tgz paths, space-separated; installed
#                         instead of the registry package (a release-check seam)
#   CLAXEDO_INSTALL_DIR   where a private Node and npm prefix go (default: %LOCALAPPDATA%\Claxedo)
param([string]$Code = "", [string]$ControlPlane = "", [string]$MinimumCliVersion = "")

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$NodeMajor = 24
$InstallDir = if ($env:CLAXEDO_INSTALL_DIR) { $env:CLAXEDO_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Claxedo" }
$NodeDir = Join-Path $InstallDir "node"
$NpmPrefix = Join-Path $InstallDir "npm"
$script:StepIndex = 0
$StepTotal = if ($Code) { 4 } else { 2 }

class InstallRefusal : System.Exception { InstallRefusal([string]$message) : base($message) {} }

function Step([string]$text) {
  $script:StepIndex++
  Write-Host "$script:StepIndex/$StepTotal $text"
}

function Refuse([string]$text) { throw [InstallRefusal]::new($text) }

function Add-UserPath([string]$directory) {
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = if ($current) { $current -split ";" } else { @() }
  if ($entries -notcontains $directory) {
    [Environment]::SetEnvironmentVariable("Path", (@($directory) + $entries -join ";"), "User")
  }
  if (($env:Path -split ";") -notcontains $directory) { $env:Path = "$directory;$env:Path" }
}

function Pairing-Refusal([string]$answer) {
  switch -Wildcard ($answer) {
    "*pairing_expired*" { return "This code expired; open Connect a machine... in Claxedo for a new one." }
    "*pairing_used*" { return "This code was already used; open Connect a machine... in Claxedo for a new one." }
    "*pairing_owner_signed_out*" { return "The person who made this code signed out; make a new one in Claxedo." }
    "*pairing_invalid*" { return "This code is not valid; copy the command from Connect a machine... again." }
    default { return "Claxedo did not accept this code; copy the command from Connect a machine... again." }
  }
}

function Report-Pairing {
  if (-not $ControlPlane) { Refuse "This script was not served by Claxedo; copy the command from Connect a machine... again." }
  $body = @{ code = $Code; hostname = $env:COMPUTERNAME; os = "Windows" } | ConvertTo-Json -Compress
  try {
    $answer = Invoke-RestMethod -Method Post -Uri "$ControlPlane/api/claxedo/host/pairings/progress" -ContentType "application/json" -Body $body
  } catch {
    $detail = if ($_.ErrorDetails) { $_.ErrorDetails.Message } else { "" }
    if (-not $detail) { Refuse "Cannot reach $ControlPlane; check this machine's network or proxy." }
    Refuse (Pairing-Refusal $detail)
  }
  if (-not $answer.recorded) { Refuse (Pairing-Refusal ($answer | ConvertTo-Json -Compress)) }
}

function Node-Major {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return 0 }
  return [int]((& $node.Source -p "process.versions.node.split('.')[0]") 2>$null)
}

function Install-Node {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $base = "https://nodejs.org/dist/latest-v$NodeMajor.x"
  $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt").Content -split "`n"
  $line = $sums | Where-Object { $_ -match "node-v$NodeMajor\.\d+\.\d+-win-$arch\.zip$" } | Select-Object -First 1
  if (-not $line) { Refuse "No Node $NodeMajor build for win-$arch at $base" }
  $expected, $file = $line.Trim() -split "\s+"
  $temp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Path $temp | Out-Null
  try {
    Write-Host "    installing $file into $NodeDir"
    $zip = Join-Path $temp $file
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$file" -OutFile $zip
    $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { Refuse "sha256 mismatch for ${file}: expected $expected, got $actual" }
    Expand-Archive -Path $zip -DestinationPath $temp
    if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
    Move-Item -Path (Join-Path $temp ($file -replace "\.zip$", "")) -Destination $NodeDir
  } finally {
    Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
  }
  Add-UserPath $NodeDir
}

function Ensure-Node {
  Step "Node $NodeMajor"
  $major = Node-Major
  if ($major -lt $NodeMajor) {
    if ($major -gt 0) { Write-Host "    node $(node --version) found; claxedo needs $NodeMajor or newer" }
    Install-Node
  }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Refuse "npm is missing next to node" }
  $git = Get-Command git -ErrorAction SilentlyContinue
  if (-not $git -and -not (Test-Path (Join-Path $env:ProgramFiles "Git\cmd\git.exe"))) {
    Refuse "Git for Windows is required: install it from https://git-scm.com/download/win and run this again."
  }
}

function Accepted-Cli {
  if (-not $MinimumCliVersion -or $env:CLAXEDO_CLI_TARBALL) { return $null }
  $installed = Get-Command claxedo -ErrorAction SilentlyContinue
  if (-not $installed) { return $null }
  $version = ((& $installed.Source --version) 2>$null | Select-Object -First 1)
  $parsed = $null
  if (-not [System.Version]::TryParse("$version".Trim(), [ref]$parsed)) { return $null }
  if ($parsed -lt [System.Version]$MinimumCliVersion) { return $null }
  Write-Host "    claxedo $version is already installed"
  return $installed.Source
}

function Install-Cli {
  Step "claxedo"
  $accepted = Accepted-Cli
  if ($accepted) { return $accepted }
  New-Item -ItemType Directory -Force -Path $NpmPrefix | Out-Null
  # Install scripts stay off: tree-sitter-powershell, which OpenCode reads only
  # as .wasm, compiles in its own and would need a C++ toolchain. The one script
  # the install needs, the runtime's OpenCode patch step, runs below.
  $packages = if ($env:CLAXEDO_CLI_TARBALL) { $env:CLAXEDO_CLI_TARBALL -split " " } else { @("@claxedo/cli@$(if ($env:CLAXEDO_CLI_VERSION) { $env:CLAXEDO_CLI_VERSION } else { "latest" })") }
  Write-Host "    installing $($packages -join ' ')"
  & npm install -g --ignore-scripts --no-fund --no-audit --loglevel=error --prefix $NpmPrefix @packages
  if ($LASTEXITCODE -ne 0) { Refuse "npm install of $($packages -join ' ') failed" }
  $runtime = Join-Path $NpmPrefix "node_modules\@claxedo\cli\node_modules\@claxedo\workspace-runtime"
  if (-not (Test-Path $runtime)) { $runtime = Join-Path $NpmPrefix "node_modules\@claxedo\workspace-runtime" }
  & node (Join-Path $runtime "scripts\install-opencode-node.mjs") | Out-Null
  if ($LASTEXITCODE -ne 0) { Refuse "applying the workspace runtime's OpenCode patches in $runtime failed" }
  $claxedo = Join-Path $NpmPrefix "claxedo.cmd"
  if (-not (Test-Path $claxedo)) { Refuse "npm finished but $claxedo is not there" }
  Add-UserPath $NpmPrefix
  return $claxedo
}

function Main {
  if ($Code) {
    Step "Checking the code with Claxedo"
    Report-Pairing
  }
  Ensure-Node
  $claxedo = Install-Cli
  if (-not $Code) {
    Write-Host ""
    Write-Host "claxedo is installed at $claxedo"
    Write-Host "Next, connect this machine from Claxedo: Settings > Machines > Connect a machine..."
    return
  }
  Step "Connecting this machine"
  if ($ControlPlane) { $env:CLAXEDO_CONTROL_PLANE_URL = $ControlPlane }
  & $claxedo connect --pair $Code --install-service
}

try {
  Main
} catch [InstallRefusal] {
  Write-Host $_.Exception.Message -ForegroundColor Red
}
