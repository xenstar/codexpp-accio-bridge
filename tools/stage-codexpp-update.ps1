param(
  [Parameter(Mandatory = $true)]
  [string]$SourceExe,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedSha256,

  [string]$StageDir = "$PSScriptRoot\..\artifacts\codexpp-pr3128\stage",
  [string]$TargetExe = "C:\Users\Shadman\AppData\Local\Programs\Codex++\codex-plus-plus.exe"
)

$ErrorActionPreference = "Stop"

function Get-NormalizedHash([string]$Value) {
  return ($Value -replace "[^0-9A-Fa-f]", "").ToUpperInvariant()
}

if (-not (Test-Path -LiteralPath $SourceExe)) {
  throw "Source executable not found: $SourceExe"
}
if (-not (Test-Path -LiteralPath $TargetExe)) {
  throw "Installed executable not found: $TargetExe"
}

$expected = Get-NormalizedHash $ExpectedSha256
if (-not $expected) {
  throw "ExpectedSha256 is empty"
}

$sourceHash = (Get-FileHash -LiteralPath $SourceExe -Algorithm SHA256).Hash
if ($sourceHash -ne $expected) {
  throw "Source hash mismatch: expected $expected, got $sourceHash"
}

$targetHash = (Get-FileHash -LiteralPath $TargetExe -Algorithm SHA256).Hash
New-Item -ItemType Directory -Force -Path $StageDir | Out-Null

$stagedExe = Join-Path $StageDir "codex-plus-plus.exe"
Copy-Item -LiteralPath $SourceExe -Destination $stagedExe -Force
$stagedHash = (Get-FileHash -LiteralPath $stagedExe -Algorithm SHA256).Hash
if ($stagedHash -ne $expected) {
  throw "Staged hash mismatch: expected $expected, got $stagedHash"
}

$manifest = [ordered]@{
  schemaVersion = 1
  stagedAtUtc = [DateTime]::UtcNow.ToString("o")
  sourceExe = (Resolve-Path -LiteralPath $SourceExe).Path
  stagedExe = (Resolve-Path -LiteralPath $stagedExe).Path
  targetExe = (Resolve-Path -LiteralPath $TargetExe).Path
  stagedSha256 = $stagedHash
  expectedCurrentSha256 = $targetHash
}
$manifestPath = Join-Path $StageDir "manifest.json"
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding utf8

Write-Output "staged=$stagedExe"
Write-Output "staged_sha256=$stagedHash"
Write-Output "expected_current_sha256=$targetHash"
Write-Output "manifest=$manifestPath"
