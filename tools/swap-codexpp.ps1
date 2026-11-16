param(
  [Parameter(Mandatory = $true)]
  [string]$SourceExe,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedSha256,

  [string]$TargetExe = "$env:LOCALAPPDATA\Programs\Codex++\codex-plus-plus.exe",
  [string]$BackupExe = "$env:LOCALAPPDATA\Programs\Codex++\codex-plus-plus.exe.pre-websocket-fix.bak",
  [string]$LogPath = "$env:TEMP\codexpp-atomic-swap.log"
)

# Deliberate maintenance only. Do not run this while Codex++ is carrying the
# active model connection; use stage-codexpp-update.ps1 instead.
$ErrorActionPreference = "Stop"

function Write-Log([string]$Message) {
  $line = "{0:o} {1}" -f [DateTime]::UtcNow, $Message
  Add-Content -LiteralPath $LogPath -Value $line
}

function Get-ExpectedHash([string]$Value) {
  return ($Value -replace "[^0-9A-Fa-f]", "").ToUpperInvariant()
}

function Get-CodexPlusProcesses([string]$Path) {
  return @(
    Get-CimInstance Win32_Process -Filter "Name='codex-plus-plus.exe'" |
      Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $Path) }
  )
}

function Wait-ProxyHealth([int]$TimeoutSeconds = 60) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $response = Invoke-WebRequest `
        -UseBasicParsing `
        -Method Post `
        -Uri "http://127.0.0.1:57321/proxy-status" `
        -ContentType "application/json" `
        -Body "{}" `
        -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        return $true
      }
    } catch {
    }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Stop-CodexPlus([string]$Path) {
  $processes = Get-CodexPlusProcesses $Path
  foreach ($process in $processes) {
    Write-Log "stopping pid=$($process.ProcessId)"
    & taskkill.exe /PID $process.ProcessId /T /F 2>$null | Out-Null
  }

  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ((Get-CodexPlusProcesses $Path).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if ((Get-CodexPlusProcesses $Path).Count -gt 0) {
    throw "Codex++ processes did not stop within 15 seconds"
  }
}

function Start-CodexPlus([string]$Path) {
  Write-Log "starting $Path"
  Start-Process -FilePath $Path -WorkingDirectory (Split-Path -Parent $Path)
}

function Install-Candidate([string]$Path, [string]$ExpectedHash) {
  Copy-Item -LiteralPath $Path -Destination $TargetExe -Force
  $actual = (Get-FileHash -LiteralPath $TargetExe -Algorithm SHA256).Hash
  if ($actual -ne $ExpectedHash) {
    throw "Installed executable hash mismatch: expected $ExpectedHash, got $actual"
  }
  Write-Log "installed sha256=$actual"
}

function Restore-Backup {
  if (-not (Test-Path -LiteralPath $BackupExe)) {
    Write-Log "rollback unavailable: $BackupExe is missing"
    return
  }

  try {
    Stop-CodexPlus $TargetExe
    Copy-Item -LiteralPath $BackupExe -Destination $TargetExe -Force
    $hash = (Get-FileHash -LiteralPath $TargetExe -Algorithm SHA256).Hash
    Write-Log "restored backup sha256=$hash"
    Start-CodexPlus $TargetExe
  } catch {
    Write-Log "rollback failed: $($_.Exception.Message)"
  }
}

try {
  $expected = Get-ExpectedHash $ExpectedSha256
  if (-not $expected) {
    throw "ExpectedSha256 is empty"
  }
  if (-not (Test-Path -LiteralPath $SourceExe)) {
    throw "Source executable not found: $SourceExe"
  }
  if (-not (Test-Path -LiteralPath $TargetExe)) {
    throw "Installed executable not found: $TargetExe"
  }

  $sourceHash = (Get-FileHash -LiteralPath $SourceExe -Algorithm SHA256).Hash
  if ($sourceHash -ne $expected) {
    throw "Source hash mismatch: expected $expected, got $sourceHash"
  }
  Write-Log "source verified sha256=$sourceHash"

  if (-not (Test-Path -LiteralPath $BackupExe)) {
    Copy-Item -LiteralPath $TargetExe -Destination $BackupExe -Force
    $backupHash = (Get-FileHash -LiteralPath $BackupExe -Algorithm SHA256).Hash
    $targetHash = (Get-FileHash -LiteralPath $TargetExe -Algorithm SHA256).Hash
    if ($backupHash -ne $targetHash) {
      throw "Rollback backup hash mismatch"
    }
    Write-Log "created rollback backup sha256=$backupHash"
  }

  $staged = "$TargetExe.next"
  Copy-Item -LiteralPath $SourceExe -Destination $staged -Force
  $stagedHash = (Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash
  if ($stagedHash -ne $expected) {
    throw "Staged executable hash mismatch: expected $expected, got $stagedHash"
  }

  Stop-CodexPlus $TargetExe
  Install-Candidate $staged $expected
  Remove-Item -LiteralPath $staged -Force
  Start-CodexPlus $TargetExe

  if (-not (Wait-ProxyHealth 60)) {
    throw "Codex++ proxy did not become healthy within 60 seconds"
  }

  $running = Get-CodexPlusProcesses $TargetExe
  if ($running.Count -eq 0) {
    throw "Codex++ process is not running after relaunch"
  }
  Write-Log "swap complete pid=$($running[0].ProcessId) proxy=healthy"
  exit 0
} catch {
  Write-Log "swap failed: $($_.Exception.Message)"
  Restore-Backup
  exit 1
}
