$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectPath
$running = $false
try { $running = (Invoke-RestMethod 'http://127.0.0.1:3210/api/health' -TimeoutSec 2).ok } catch {}
if (-not $running) {
  if (-not (Test-Path -LiteralPath '.next/BUILD_ID')) { throw 'Build the wallet first with npm run wallet:build. See docs/PHASE1-RUNBOOK.md.' }
  $nodePath = (Get-Command node).Source
  Start-Process -FilePath $nodePath -ArgumentList @('--import','tsx','services/wallet/server.ts') -WorkingDirectory $projectPath -WindowStyle Hidden -RedirectStandardOutput '.state/wallet-server.log' -RedirectStandardError '.state/wallet-server-error.log'
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 500
    try { if ((Invoke-RestMethod 'http://127.0.0.1:3210/api/health' -TimeoutSec 1).ok) { $running = $true; break } } catch {}
  }
  if (-not $running) { throw 'The local wallet could not start. Check .state/wallet-server-error.log.' }
}
& node --import tsx scripts/pair-wallet.ts
if ($LASTEXITCODE -ne 0) { throw 'Could not create a local pairing link.' }
$pairing = Get-Content -LiteralPath '.secrets/browser-pairing.json' -Raw | ConvertFrom-Json
Start-Process ('http://127.0.0.1:3210/#pair=' + $pairing.token)
