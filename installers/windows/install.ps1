#Requires -Version 5.1

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$ServerUrl,

  [Parameter(Position = 1)]
  [string]$EnrollmentToken,

  [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$MinimumNodeMajor = 24
$PackageName = "@mininglamp-oss/octo-harness"
$LockStreams = @()
$PreparedUpdate = $false
$Channel = if ($env:OCTO_HARNESS_CHANNEL) { $env:OCTO_HARNESS_CHANNEL } else { "stable" }
$Profile = if ($env:OCTO_HARNESS_PROFILE) { $env:OCTO_HARNESS_PROFILE } else { "default" }
$HarnessHome = if ($env:OCTO_HARNESS_HOME) {
  $env:OCTO_HARNESS_HOME
} else {
  Join-Path $env:LOCALAPPDATA "OctoHarness"
}

function Show-Usage {
  @"
Install Octo Harness for the current Windows user.

Usage:
  & ([scriptblock]::Create((irm https://SERVER/octo-harness/install.ps1))) ``
    "https://SERVER" "octo_enroll_..."

On first install, the enrollment token may be omitted and entered securely.
An already enrolled profile can be repaired or updated without another token.
Environment overrides:
  OCTO_HARNESS_CHANNEL       stable (default) or beta
  OCTO_HARNESS_PROFILE       profile name (default: default)
  OCTO_HARNESS_HOME          state directory (default: %LOCALAPPDATA%\OctoHarness)
  OCTO_HARNESS_NPM_SPEC      npm package spec used instead of the channel default
"@
}

function Write-InstallerInfo([string]$Message) {
  Write-Host "[octo-harness] $Message"
}

function Fail([string]$Message) {
  throw "[octo-harness] $Message"
}

function Refresh-ProcessPath {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = (@($machinePath, $userPath) | Where-Object { $_ }) -join ";"
}

function Get-NodeMajor {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $node) { return 0 }
  $rawMajor = & $node.Source -p "Number(process.versions.node.split('.')[0])" 2>$null
  if ($LASTEXITCODE -ne 0) { return 0 }
  $major = 0
  if (-not [int]::TryParse(([string]$rawMajor).Trim(), [ref]$major)) { return 0 }
  return $major
}

function Ensure-Node {
  $major = Get-NodeMajor
  if ($major -lt $MinimumNodeMajor) {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $winget) {
      Fail "Node.js 24+ is required and winget is unavailable. Install Node.js 24+ and rerun this command."
    }
    Write-InstallerInfo "Installing the current Node.js LTS with winget"
    & $winget.Source install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { Fail "winget could not install Node.js (exit $LASTEXITCODE)" }
    Refresh-ProcessPath
    $major = Get-NodeMajor
  }
  if ($major -lt $MinimumNodeMajor) {
    Fail "Node.js 24+ is required; the active node.exe reports major version $major"
  }
}

function Test-PathContains([string]$PathValue, [string]$Entry) {
  if (-not $PathValue) { return $false }
  $expected = $Entry.TrimEnd("\")
  foreach ($candidate in ($PathValue -split ";")) {
    if ($candidate.Trim().TrimEnd("\").Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

function Ensure-UserPath([string]$GlobalBin) {
  if (-not (Test-PathContains $env:Path $GlobalBin)) {
    $env:Path = "$GlobalBin;$env:Path"
  }

  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not (Test-PathContains $machinePath $GlobalBin) -and -not (Test-PathContains $userPath $GlobalBin)) {
    $newUserPath = if ($userPath) { "$GlobalBin;$userPath" } else { $GlobalBin }
    [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
    Write-InstallerInfo "Added npm global bin to the current user's PATH"
  }
}

function Test-FullyQualifiedWindowsPath([string]$PathValue) {
  if (-not $PathValue) { return $false }
  return $PathValue -match '^[A-Za-z]:[\\/]' -or
    $PathValue -match '^[\\/]{2}[^\\/]+[\\/]+[^\\/]+'
}

function Open-InstallerLock([string]$PathValue, [string]$Description) {
  $parent = Split-Path -Parent $PathValue
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  try {
    return [IO.File]::Open($PathValue, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch {
    Fail "$Description is already running or its lock cannot be opened: $PathValue"
  }
}

if ($Help) {
  Show-Usage
  return
}
if (-not $ServerUrl) {
  Show-Usage
  Fail "ServerUrl is required"
}
if ($env:OS -ne "Windows_NT") {
  Fail "this installer supports Windows only"
}
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($architecture -notin @("AMD64", "ARM64")) {
  Fail "unsupported Windows architecture: $architecture"
}

$parsedServerUrl = $null
if (-not [Uri]::TryCreate($ServerUrl, [UriKind]::Absolute, [ref]$parsedServerUrl) -or
    $parsedServerUrl.Scheme -ne "https" -or
    -not $parsedServerUrl.Host -or
    $parsedServerUrl.UserInfo -or
    $parsedServerUrl.Query -or
    $parsedServerUrl.Fragment) {
  Fail "ServerUrl must be an HTTPS base URL without user info, query, or fragment"
}
$ServerUrl = $ServerUrl.TrimEnd("/")
if ($Channel -notin @("stable", "beta")) {
  Fail "OCTO_HARNESS_CHANNEL must be stable or beta"
}
if ($Profile -notmatch "^[A-Za-z0-9._-]+$") {
  Fail "OCTO_HARNESS_PROFILE contains unsupported characters"
}
if (-not (Test-FullyQualifiedWindowsPath $HarnessHome)) {
  Fail "OCTO_HARNESS_HOME must be an absolute path"
}

$profileIdentity = Join-Path $HarnessHome "identity\runtime.json"
if (-not $EnrollmentToken -and -not (Test-Path -LiteralPath $profileIdentity -PathType Leaf)) {
  $secureToken = Read-Host "Enrollment token" -AsSecureString
  $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  try {
    $EnrollmentToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
  }
}
if (-not $EnrollmentToken -and -not (Test-Path -LiteralPath $profileIdentity -PathType Leaf)) {
  Fail "EnrollmentToken must not be empty on first install"
}

try {
  Ensure-Node
  $npm = Get-Command npm.cmd, npm.exe, npm -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $npm) { Fail "npm is required but was not installed with Node.js" }

  $npmTag = if ($Channel -eq "stable") { "latest" } else { "beta" }
  $npmSpec = if ($env:OCTO_HARNESS_NPM_SPEC) {
    $env:OCTO_HARNESS_NPM_SPEC
  } else {
    "$PackageName@$npmTag"
  }
  if ($npmSpec -match '^[A-Za-z][A-Za-z0-9+.-]*://') {
    $npmSpecUri = $null
    if (-not [Uri]::TryCreate($npmSpec, [UriKind]::Absolute, [ref]$npmSpecUri) -or
        $npmSpecUri.UserInfo -or $npmSpecUri.Query -or $npmSpecUri.Fragment) {
      Fail "OCTO_HARNESS_NPM_SPEC URL must not contain user info, query, or fragment"
    }
  }

  $npmPrefixOutput = & $npm.Source prefix --global
  if ($LASTEXITCODE -ne 0) { Fail "npm could not resolve its global prefix (exit $LASTEXITCODE)" }
  $npmPrefix = ([string]($npmPrefixOutput | Select-Object -Last 1)).Trim()
  if (-not (Test-FullyQualifiedWindowsPath $npmPrefix)) {
    Fail "npm returned an invalid global prefix"
  }

  $homeHasRuntime = $false
  foreach ($runtimeMarker in @("config.json", "profiles", "state.db", "agent-work.db", "octo-daemon.pid", "sockets")) {
    if (Test-Path -LiteralPath (Join-Path $HarnessHome $runtimeMarker)) {
      $homeHasRuntime = $true
      break
    }
  }

  New-Item -ItemType Directory -Path $HarnessHome -Force | Out-Null
  $homeLock = Open-InstallerLock -PathValue (Join-Path $HarnessHome ".installer.lock") -Description "Harness Home installer"
  $LockStreams += $homeLock
  $globalLock = Open-InstallerLock -PathValue (Join-Path $npmPrefix ".octo-harness-installer.lock") -Description "npm global package installer"
  $LockStreams += $globalLock

  $cli = Join-Path $npmPrefix "octo-harness.cmd"
  $cliEntrypoint = Join-Path $npmPrefix "node_modules\@mininglamp-oss\octo-harness\apps\cli\dist\index.js"
  $existingCliCommand = $null
  $existingCliPrefixArguments = @()
  if (Test-Path -LiteralPath $cli -PathType Leaf) {
    $existingCliCommand = $cli
  } elseif (Test-Path -LiteralPath $cliEntrypoint -PathType Leaf) {
    $node = Get-Command node.exe -ErrorAction Stop | Select-Object -First 1
    $existingCliCommand = $node.Source
    $existingCliPrefixArguments = @($cliEntrypoint)
  }

  if ($existingCliCommand) {
    $existingSetupHelp = (& $existingCliCommand @existingCliPrefixArguments setup --help 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
      Fail "the installed CLI cannot describe its setup contract; no npm files were changed"
    }
    if ($existingSetupHelp -notmatch "--prepare-update" -or $existingSetupHelp -notmatch "--recover-update") {
      Fail "the installed CLI predates safe updates. Stop its foreground daemon, remove any legacy npm link, then rerun this installer"
    }
    Write-InstallerInfo "Draining the existing daemon before updating the npm package"
    & $existingCliCommand @existingCliPrefixArguments --home $HarnessHome --profile $Profile setup --prepare-update --wait-drained
    if ($LASTEXITCODE -ne 0) {
      Fail "the installed CLI could not prepare a safe package update; no npm files were changed"
    }
    $PreparedUpdate = $true
  } elseif ($homeHasRuntime) {
    Fail "Harness Home contains Runtime state but the current npm prefix has no usable CLI. Stop the existing daemon and repair or remove the legacy npm link before retrying"
  }

  if ($env:OCTO_HARNESS_NPM_SPEC) {
    Write-InstallerInfo "Installing the configured OCTO_HARNESS_NPM_SPEC with npm"
  } else {
    Write-InstallerInfo "Installing $PackageName@$npmTag with npm"
  }
  & $npm.Source install --global --no-audit --no-fund $npmSpec
  $npmInstallExit = $LASTEXITCODE
  if ($npmInstallExit -ne 0) {
    if ($PreparedUpdate) {
      $recoveryCliCommand = $null
      $recoveryCliPrefixArguments = @()
      if (Test-Path -LiteralPath $cli -PathType Leaf) {
        $recoveryCliCommand = $cli
      } elseif (Test-Path -LiteralPath $cliEntrypoint -PathType Leaf) {
        $node = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($node) {
          $recoveryCliCommand = $node.Source
          $recoveryCliPrefixArguments = @($cliEntrypoint)
        }
      }
      if ($recoveryCliCommand) {
        & $recoveryCliCommand @recoveryCliPrefixArguments --home $HarnessHome --profile $Profile setup --recover-update --start
        if ($LASTEXITCODE -eq 0) {
          Write-InstallerInfo "Restored the previous service after the failed npm update"
        } else {
          Write-Warning "Automatic service recovery failed; repair the npm package, then run 'octo-harness setup --recover-update --start'"
        }
      } else {
        Write-Warning "Automatic service recovery could not find a CLI; repair the npm package, then run 'octo-harness setup --recover-update --start'"
      }
    }
    Fail "npm install failed (exit $npmInstallExit)"
  }

  Ensure-UserPath $npmPrefix
  if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
    Fail "npm completed but $cli is missing"
  }

  $loginHelp = (& $cli login --help 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) {
    Fail "the installed package does not provide 'octo-harness login'"
  }
  if ($loginHelp -notmatch "--enroll-token-stdin") {
    Fail "the installed login command does not implement secure enrollment"
  }
  $setupHelp = (& $cli setup --help 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0 -or
      $setupHelp -notmatch "--prepare-update" -or
      $setupHelp -notmatch "--recover-update") {
    Fail "the installed package does not implement the installer update contract"
  }

  $setupArguments = @(
    "--home", $HarnessHome,
    "--profile", $Profile,
    "login",
    "--server-url", $ServerUrl,
    "--agent-work-url", "$($ServerUrl.TrimEnd('/'))/agent-worker",
    "--channel", $Channel,
    "--enroll-token-stdin",
    "--install-service",
    "--autostart",
    "--start",
    "--wait-online"
  )
  Write-InstallerInfo "Logging in this device and reconciling the current-user service"
  $EnrollmentToken | & $cli @setupArguments
  $loginExit = $LASTEXITCODE
  if ($loginExit -ne 0) {
    if ($PreparedUpdate) {
      & $cli --home $HarnessHome --profile $Profile setup --recover-update --start
      if ($LASTEXITCODE -eq 0) {
        Write-InstallerInfo "Restored the service after the updated login failed"
      } else {
        Write-Warning "Service recovery also failed; repair the package, then run 'octo-harness setup --recover-update --start'"
      }
    }
    Fail "octo-harness login failed (exit $loginExit); rerun this installer after correcting the reported problem"
  }

  Write-InstallerInfo "Installation complete"
  Write-InstallerInfo "Run: octo-harness --home `"$HarnessHome`" --profile `"$Profile`" doctor"
} finally {
  $EnrollmentToken = $null
  foreach ($lockStream in $LockStreams) {
    if ($lockStream) { $lockStream.Dispose() }
  }
}
