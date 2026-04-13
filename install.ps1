param(
  [Parameter(Position = 0)]
  [string]$Version
)

$ErrorActionPreference = 'Stop'

$Repo = 'huanghuoguoguo/tlive'
$InstallDir = if ($env:TLIVE_HOME) { $env:TLIVE_HOME } else { Join-Path $HOME '.tlive' }
$AppDir = Join-Path $InstallDir 'app'
$BinDir = Join-Path $HOME '.local\bin'

function Write-Info([string]$Message) {
  Write-Host "[INFO] $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
  Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Fail([string]$Message) {
  throw $Message
}

function Get-LatestVersion {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{
    Accept = 'application/vnd.github.v3+json'
  }
  if (-not $release.tag_name) {
    Fail 'Failed to get latest version'
  }
  return [string]$release.tag_name
}

function Normalize-Version([string]$InputVersion) {
  if ([string]::IsNullOrWhiteSpace($InputVersion)) {
    return $null
  }
  if ($InputVersion.StartsWith('v')) {
    return $InputVersion
  }
  return "v$InputVersion"
}

function Check-Node {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    Fail 'Node.js 20+ is required but was not found in PATH. Install Node.js first: https://nodejs.org'
  }

  $nodeVersion = (& node -p "process.versions.node").Trim()
  $major = [int]($nodeVersion.Split('.')[0])
  if ($major -lt 20) {
    Fail "Node.js 20+ is required (found v$nodeVersion)"
  }

  Write-Info "Node.js v$nodeVersion ✓"
}

function Install-Dependencies([string]$TargetDir) {
  Push-Location $TargetDir
  try {
    try {
      & npm ci --production --ignore-scripts
      if ($LASTEXITCODE -ne 0) {
        throw 'npm ci failed'
      }
    } catch {
      & npm install --production --ignore-scripts
      if ($LASTEXITCODE -ne 0) {
        throw 'npm install failed'
      }
    }

    $postinstall = Join-Path $TargetDir 'scripts\postinstall.js'
    if (Test-Path $postinstall) {
      Write-Info 'Running tlive postinstall...'
      & node $postinstall
      if ($LASTEXITCODE -ne 0) {
        throw 'postinstall failed'
      }
    }
  } finally {
    Pop-Location
  }
}

Write-Host ''
Write-Host '  ╔═══════════════════════════════════════╗'
Write-Host '  ║       TLive Installer (Windows)      ║'
Write-Host '  ╚═══════════════════════════════════════╝'
Write-Host ''

Check-Node

$ResolvedVersion = Normalize-Version $Version
if (-not $ResolvedVersion) {
  $ResolvedVersion = Get-LatestVersion
}
Write-Info "Version: $ResolvedVersion"

$DownloadUrl = "https://github.com/$Repo/releases/download/$ResolvedVersion/tlive-$ResolvedVersion.tar.gz"
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("tlive-install-" + [guid]::NewGuid().ToString('N'))
$Tarball = Join-Path $TempRoot 'tlive.tar.gz'
$StagedDir = Join-Path $TempRoot 'app'
$BackupDir = $null

try {
  New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null

  Write-Info "Downloading tlive $ResolvedVersion..."
  Invoke-WebRequest -Uri $DownloadUrl -OutFile $Tarball -Headers @{
    Accept = 'application/octet-stream'
  }

  Write-Info 'Preparing staged install...'
  New-Item -ItemType Directory -Force -Path $StagedDir | Out-Null
  & tar -xzf $Tarball -C $StagedDir
  if ($LASTEXITCODE -ne 0) {
    throw 'Failed to extract release package. Make sure tar.exe is available in PATH.'
  }

  Write-Info 'Installing dependencies...'
  Install-Dependencies $StagedDir

  Write-Info "Installing to $AppDir..."
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  if (Test-Path $AppDir) {
    $BackupDir = Join-Path $InstallDir ("app-backup-" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
    Move-Item -Force $AppDir $BackupDir
  }
  Move-Item -Force $StagedDir $AppDir

  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

  $cmdWrapper = @'
@echo off
setlocal
if defined TLIVE_HOME (
  set "TLIVE_HOME_EFFECTIVE=%TLIVE_HOME%"
) else (
  set "TLIVE_HOME_EFFECTIVE=%USERPROFILE%\.tlive"
)
node "%TLIVE_HOME_EFFECTIVE%\app\scripts\cli.js" %*
'@
  Set-Content -Path (Join-Path $BinDir 'tlive.cmd') -Value $cmdWrapper -Encoding ASCII

  $psWrapper = @'
if ($env:TLIVE_HOME) {
  $tliveHome = $env:TLIVE_HOME
} else {
  $tliveHome = Join-Path $HOME '.tlive'
}
& node (Join-Path $tliveHome 'app\scripts\cli.js') @args
'@
  Set-Content -Path (Join-Path $BinDir 'tlive.ps1') -Value $psWrapper -Encoding ASCII

  Write-Info "Created wrappers in $BinDir"

  $pathEntries = ($env:Path -split ';') | Where-Object { $_ }
  if ($pathEntries -notcontains $BinDir) {
    Write-Warn "$BinDir is not in your PATH"
    Write-Host ''
    Write-Host '  Add this to your PowerShell profile or user PATH:'
    Write-Host "    `$env:Path += ';$BinDir'"
    Write-Host ''
  }

  Write-Host ''
  Write-Info "Installation complete! Run 'tlive --help' to get started."
  if ($BackupDir -and (Test-Path $BackupDir)) {
    Write-Info "Previous version backed up to $BackupDir"
  }
  Write-Host ''
} catch {
  if ($BackupDir -and (Test-Path $BackupDir) -and -not (Test-Path $AppDir)) {
    try {
      Move-Item -Force $BackupDir $AppDir
    } catch {
      Write-Warn "Failed to restore backup from $BackupDir"
    }
  }
  throw
} finally {
  if (Test-Path $TempRoot) {
    Remove-Item -Recurse -Force $TempRoot
  }
}
