param(
  [Parameter(Mandatory = $true)]
  [string]$BackupExe,

  [string]$TargetExe = "C:\Users\Shadman\AppData\Local\Programs\Codex++\codex-plus-plus.exe",
  [string]$ExpectedSha256
)

$ErrorActionPreference = "Stop"

function Get-NormalizedHash([string]$Value) {
  return ($Value -replace "[^0-9A-Fa-f]", "").ToUpperInvariant()
}

if (-not (Test-Path -LiteralPath $BackupExe)) {
  throw "Rollback executable not found: $BackupExe"
}
if (-not (Test-Path -LiteralPath $TargetExe)) {
  throw "Installed executable not found: $TargetExe"
}

$backupHash = (Get-FileHash -LiteralPath $BackupExe -Algorithm SHA256).Hash
if ($ExpectedSha256) {
  $expected = Get-NormalizedHash $ExpectedSha256
  if ($backupHash -ne $expected) {
    throw "Rollback hash mismatch: expected $expected, got $backupHash"
  }
}

$targetDir = Split-Path -Parent $TargetExe
$targetName = Split-Path -Leaf $TargetExe
$timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
$currentBackup = Join-Path $targetDir "$targetName.pre-rollback-$timestamp.bak"
$next = Join-Path $targetDir "$targetName.rollback-next"

Copy-Item -LiteralPath $BackupExe -Destination $next -Force
$nextHash = (Get-FileHash -LiteralPath $next -Algorithm SHA256).Hash
if ($nextHash -ne $backupHash) {
  Remove-Item -LiteralPath $next -Force
  throw "Prepared rollback hash mismatch"
}

try {
  Move-Item -LiteralPath $TargetExe -Destination $currentBackup
  Move-Item -LiteralPath $next -Destination $TargetExe
} catch {
  if (Test-Path -LiteralPath $next) {
    Remove-Item -LiteralPath $next -Force
  }
  if ((Test-Path -LiteralPath $currentBackup) -and -not (Test-Path -LiteralPath $TargetExe)) {
    Move-Item -LiteralPath $currentBackup -Destination $TargetExe
  }
  throw
}

$installedHash = (Get-FileHash -LiteralPath $TargetExe -Algorithm SHA256).Hash
if ($installedHash -ne $backupHash) {
  Move-Item -LiteralPath $TargetExe -Destination $next
  Move-Item -LiteralPath $currentBackup -Destination $TargetExe
  throw "Rollback hash mismatch after activation"
}

Write-Output "restored_sha256=$installedHash"
Write-Output "replaced_candidate_backup=$currentBackup"
Write-Output "If Codex++ was running, close and reopen it to load the restored binary."
