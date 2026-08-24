param(
  [switch]$ToolsOnly,
  [switch]$CleanInstall,
  [string]$GitSeedOrigin = "https://github.com/kyashrathore/Claxedo.git",
  [string]$GitSeedRef = "dev"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifest = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$bunVersion = $manifest.packageManager -replace '^bun@', ''
$toolsRoot = Join-Path $env:LOCALAPPDATA "Claxedo\tools"
$downloads = Join-Path $toolsRoot "downloads"
New-Item -ItemType Directory -Force -Path $toolsRoot, $downloads | Out-Null

function Initialize-GitWorkspace {
  $gitPath = Join-Path $root ".git"
  if (Test-Path -LiteralPath $gitPath) {
    return
  }

  # Native-Windows Crabbox syncs a manifest archive and excludes .git. Restore
  # the real public base commit before tests run so Git policy checks observe
  # the same tracked-file index as GitHub Actions. The existing worktree is
  # deliberately left in place as the dirty overlay under test.
  $seedRoot = Join-Path $env:TEMP ("claxedo-git-seed-" + [Guid]::NewGuid().ToString("N"))
  try {
    & git clone --no-checkout --separate-git-dir $gitPath --depth 1 --no-tags --branch $GitSeedRef $GitSeedOrigin $seedRoot
    if ($LASTEXITCODE -ne 0) {
      throw "git clone for $GitSeedOrigin#$GitSeedRef exited $LASTEXITCODE"
    }
    & git -C $root config core.autocrlf false
    if ($LASTEXITCODE -ne 0) {
      throw "git config core.autocrlf exited $LASTEXITCODE"
    }
    & git -C $root reset --mixed --quiet HEAD
    if ($LASTEXITCODE -ne 0) {
      throw "git reset --mixed HEAD exited $LASTEXITCODE"
    }
  } finally {
    Remove-Item -LiteralPath $seedRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Initialize-GitWorkspace

function Add-ToolPath([string]$Path) {
  if (($env:PATH -split ';') -notcontains $Path) {
    $env:PATH = "$Path;$env:PATH"
  }
}

function Expand-ToolArchive([string]$Url, [string]$Archive, [string]$Destination) {
  if (Test-Path $Destination) {
    return
  }

  Write-Output "Downloading $Url"
  & curl.exe --fail --location --silent --show-error --output $Archive $Url
  if ($LASTEXITCODE -ne 0) {
    throw "curl.exe failed with exit code $LASTEXITCODE while downloading $Url"
  }
  Expand-Archive -LiteralPath $Archive -DestinationPath $toolsRoot -Force
}

$nodeChecksums = & curl.exe --fail --location --silent --show-error "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt"
if ($LASTEXITCODE -ne 0) {
  throw "Could not download Node.js 24 checksums"
}
$nodeArchiveName = (($nodeChecksums -join "`n") -split '\s+' |
  Where-Object { $_ -like "node-v24.*-win-x64.zip" } |
  Select-Object -First 1)
if (-not $nodeArchiveName) {
  throw "Could not resolve the latest Node.js 24 release"
}
$nodeDirectory = $nodeArchiveName -replace '\.zip$', ''
$nodePath = Join-Path $toolsRoot $nodeDirectory
Expand-ToolArchive "https://nodejs.org/dist/latest-v24.x/$nodeArchiveName" (Join-Path $downloads $nodeArchiveName) $nodePath
Add-ToolPath $nodePath

$bunDirectory = "bun-windows-x64-baseline"
$bunPath = Join-Path $toolsRoot $bunDirectory
Expand-ToolArchive "https://github.com/oven-sh/bun/releases/download/bun-v$bunVersion/$bunDirectory.zip" (Join-Path $downloads "bun-$bunVersion.zip") $bunPath
Add-ToolPath $bunPath

$rustupHome = Join-Path $toolsRoot "rustup"
$cargoHome = Join-Path $toolsRoot "cargo"
$cargoBin = Join-Path $cargoHome "bin"
$cargoExe = Join-Path $cargoBin "cargo.exe"
$env:RUSTUP_HOME = $rustupHome
$env:CARGO_HOME = $cargoHome
if (-not (Test-Path $cargoExe)) {
  $rustupInstaller = Join-Path $downloads "rustup-init.exe"
  $rustupUrl = "https://win.rustup.rs/x86_64"
  Write-Output "Downloading $rustupUrl"
  & curl.exe --fail --location --silent --show-error --output $rustupInstaller $rustupUrl
  if ($LASTEXITCODE -ne 0) {
    throw "Could not download rustup-init"
  }
  $installer = Start-Process -FilePath $rustupInstaller -ArgumentList @(
    "-y",
    "--profile", "minimal",
    "--default-toolchain", "stable-x86_64-pc-windows-msvc"
  ) -Wait -PassThru
  if ($installer.ExitCode -ne 0) {
    throw "rustup-init exited $($installer.ExitCode)"
  }
}
Add-ToolPath $cargoBin
& (Join-Path $cargoBin "rustup.exe") target add x86_64-pc-windows-msvc
if ($LASTEXITCODE -ne 0) {
  throw "rustup target add exited $LASTEXITCODE"
}

$pythonVersion = "3.12.10"
$pythonPath = Join-Path $toolsRoot "python-$pythonVersion"
if (-not (Test-Path (Join-Path $pythonPath "python.exe"))) {
  $pythonInstaller = Join-Path $downloads "python-$pythonVersion-amd64.exe"
  $pythonUrl = "https://www.python.org/ftp/python/$pythonVersion/python-$pythonVersion-amd64.exe"
  Write-Output "Downloading $pythonUrl"
  & curl.exe --fail --location --silent --show-error --output $pythonInstaller $pythonUrl
  if ($LASTEXITCODE -ne 0) {
    throw "curl.exe failed with exit code $LASTEXITCODE while downloading $pythonUrl"
  }
  $installer = Start-Process -FilePath $pythonInstaller -ArgumentList @(
    "/quiet",
    "InstallAllUsers=0",
    "Include_launcher=0",
    "Include_test=0",
    "Include_pip=1",
    "PrependPath=0",
    "TargetDir=$pythonPath"
  ) -Wait -PassThru
  if ($installer.ExitCode -ne 0) {
    throw "Python installer exited $($installer.ExitCode)"
  }
}
Add-ToolPath $pythonPath
Add-ToolPath (Join-Path $pythonPath "Scripts")

$npmUserBin = Join-Path $env:APPDATA "npm"
Add-ToolPath $npmUserBin
[Environment]::SetEnvironmentVariable("Path", $env:PATH, "User")

# Visual Studio rejects long installation roots; the per-user tools path can
# exceed that limit on managed Windows accounts, so keep this one deliberately
# short.
$buildToolsPath = "C:\ClaxedoBuildTools"
$msbuildPath = Join-Path $buildToolsPath "MSBuild\Current\Bin\MSBuild.exe"
$msvcPath = Join-Path $buildToolsPath "VC\Tools\MSVC"
$spectreLibraries = if (Test-Path $msvcPath) {
  @(Get-ChildItem $msvcPath -Recurse -File -Filter "vcruntime.lib" |
    Where-Object { $_.FullName -like "*\lib\spectre\x64\vcruntime.lib" })
} else {
  @()
}
if (-not (Test-Path $msbuildPath) -or $spectreLibraries.Count -eq 0) {
  $buildToolsInstaller = Join-Path $downloads "vs_BuildTools.exe"
  $buildToolsUrl = "https://aka.ms/vs/17/release/vs_BuildTools.exe"
  Write-Output "Downloading $buildToolsUrl"
  & curl.exe --fail --location --silent --show-error --output $buildToolsInstaller $buildToolsUrl
  if ($LASTEXITCODE -ne 0) {
    throw "curl.exe failed with exit code $LASTEXITCODE while downloading $buildToolsUrl"
  }
  $installer = Start-Process -FilePath $buildToolsInstaller -ArgumentList @(
    "--quiet",
    "--wait",
    "--norestart",
    "--nocache",
    "--installPath", $buildToolsPath,
    "--add", "Microsoft.VisualStudio.Workload.VCTools",
    "--add", "Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre",
    "--includeRecommended"
  ) -Wait -PassThru
  if ($installer.ExitCode -notin @(0, 3010)) {
    throw "Visual Studio Build Tools installer exited $($installer.ExitCode)"
  }
  if (-not (Test-Path $msbuildPath)) {
    throw "Visual Studio Build Tools installation did not provide MSBuild"
  }
  $spectreLibraries = @(Get-ChildItem $msvcPath -Recurse -File -Filter "vcruntime.lib" |
    Where-Object { $_.FullName -like "*\lib\spectre\x64\vcruntime.lib" })
  if ($spectreLibraries.Count -eq 0) {
    throw "Visual Studio Build Tools installation did not provide x64 Spectre libraries"
  }
}
$env:GYP_MSVS_VERSION = "2022"

node --version
bun --version
python --version
npm install --global node-gyp@12.4.0 --no-fund --no-audit

if ($ToolsOnly) {
  return
}

Set-Location $root
if ($CleanInstall) {
  $workspaceRoots = @($root)
  foreach ($workspaceParent in @(
    (Join-Path $root "packages"),
    (Join-Path $root "examples")
  )) {
    if (Test-Path $workspaceParent) {
      $workspaceRoots += @(Get-ChildItem $workspaceParent -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName "package.json") } |
        Select-Object -ExpandProperty FullName)
    }
  }
  $nestedSdkWorkspace = Join-Path $root "packages\sdk\js"
  if (Test-Path (Join-Path $nestedSdkWorkspace "package.json")) {
    $workspaceRoots += $nestedSdkWorkspace
  }

  foreach ($workspaceRoot in @($workspaceRoots | Sort-Object -Unique)) {
    $nodeModules = Join-Path $workspaceRoot "node_modules"
    if (Test-Path $nodeModules) {
      $extendedNodeModules = "\\?\$nodeModules"
      & cmd.exe /d /c rd /s /q $extendedNodeModules
      if ($LASTEXITCODE -ne 0 -or (Test-Path $nodeModules)) {
        throw "Could not remove $nodeModules for a clean install"
      }
    }
  }
}
$env:BUN_INSTALL_CACHE_DIR = Join-Path $toolsRoot "bun-cache-$bunVersion"
bun install --frozen-lockfile
if ($LASTEXITCODE -ne 0) {
  throw "bun install exited $LASTEXITCODE"
}
$windowsProcessTreeManifest = Join-Path $root "packages\claxedo-desktop\node_modules\@vscode\windows-process-tree\package.json"
if (-not (Test-Path $windowsProcessTreeManifest)) {
  throw "Windows process-tree native dependency was not installed"
}
