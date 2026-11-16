param(
  [Parameter(Mandatory = $true)]
  [string]$ManifestPath,

  [string]$LogPath = "$env:TEMP\codexpp-stage-activation.log"
)

$ErrorActionPreference = "Stop"

function Write-Log([string]$Message) {
  $line = "{0:o} {1}" -f [DateTime]::UtcNow, $Message
  Add-Content -LiteralPath $LogPath -Value $line
}

if (-not (Test-Path -LiteralPath $ManifestPath)) {
  throw "Stage manifest not found: $ManifestPath"
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
foreach ($name in @("stagedExe", "targetExe", "stagedSha256", "expectedCurrentSha256")) {
  if (-not $manifest.$name) {
    throw "Stage manifest is missing $name"
  }
}
if (-not (Test-Path -LiteralPath $manifest.stagedExe)) {
  throw "Staged executable not found: $($manifest.stagedExe)"
}
if (-not (Test-Path -LiteralPath $manifest.targetExe)) {
  throw "Installed executable not found: $($manifest.targetExe)"
}

$stagedHash = (Get-FileHash -LiteralPath $manifest.stagedExe -Algorithm SHA256).Hash
if ($stagedHash -ne $manifest.stagedSha256) {
  throw "Staged hash changed: expected $($manifest.stagedSha256), got $stagedHash"
}

$targetHash = (Get-FileHash -LiteralPath $manifest.targetExe -Algorithm SHA256).Hash
if ($targetHash -ne $manifest.expectedCurrentSha256) {
  throw "Installed executable changed since staging: expected $($manifest.expectedCurrentSha256), got $targetHash"
}

$targetDir = Split-Path -Parent $manifest.targetExe
$targetName = Split-Path -Leaf $manifest.targetExe
$timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
$backup = Join-Path $targetDir "$targetName.pre-activation-$timestamp.bak"
$next = Join-Path $targetDir "$targetName.next"

Copy-Item -LiteralPath $manifest.stagedExe -Destination $next -Force
$nextHash = (Get-FileHash -LiteralPath $next -Algorithm SHA256).Hash
if ($nextHash -ne $manifest.stagedSha256) {
  Remove-Item -LiteralPath $next -Force
  throw "Prepared hash mismatch: expected $($manifest.stagedSha256), got $nextHash"
}

try {
  # Renaming a running Windows executable is supported; the current process
  # keeps its loaded image and model connection while the path changes.
  Move-Item -LiteralPath $manifest.targetExe -Destination $backup
  Move-Item -LiteralPath $next -Destination $manifest.targetExe
} catch {
  if (Test-Path -LiteralPath $next) {
    Remove-Item -LiteralPath $next -Force
  }
  if ((Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $manifest.targetExe)) {
    Move-Item -LiteralPath $backup -Destination $manifest.targetExe
  }
  throw
}

$installedHash = (Get-FileHash -LiteralPath $manifest.targetExe -Algorithm SHA256).Hash
if ($installedHash -ne $manifest.stagedSha256) {
  Move-Item -LiteralPath $manifest.targetExe -Destination $next
  Move-Item -LiteralPath $backup -Destination $manifest.targetExe
  throw "Activated hash mismatch: expected $($manifest.stagedSha256), got $installedHash"
}

Write-Log "activated sha256=$installedHash backup=$backup"
Write-Output "activated_sha256=$installedHash"
Write-Output "backup=$backup"
Write-Output "The running Codex++ process was not stopped. The staged build will load on its next normal start."
