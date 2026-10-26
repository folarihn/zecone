# ZecOne — Windows / Node 24 verification.
# Read-only with respect to funds: never signs, broadcasts, funds or moves ZEC/ETH,
# never touches .secrets/ and never creates wallet seeds. Uses a temporary
# payments database so your .state/payments.sqlite is not modified.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-windows.ps1
#   ... -Integration   also runs the browser end-to-end suite (needs Microsoft Edge)
#   ... -WalletUi      also runs the existing wallet UI suite (needs Microsoft Edge)
#   ... -SkipInstall   skip `npm install`
param([switch]$Integration, [switch]$WalletUi, [switch]$SkipInstall)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$results = New-Object System.Collections.Generic.List[object]
function Record($name, $ok, $detail) {
  $results.Add([pscustomobject]@{ Check = $name; Result = $(if ($ok) { 'PASS' } else { 'FAIL' }); Detail = $detail })
  $color = if ($ok) { 'Green' } else { 'Red' }
  Write-Host ("[{0}] {1} {2}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail) -ForegroundColor $color
}
function Run($name, [string[]]$cmd) {
  Write-Host "`n> $($cmd -join ' ')" -ForegroundColor Cyan
  $log = Join-Path $env:TEMP ("zecone-verify-" + ($name -replace '[^a-zA-Z0-9]', '-') + ".log")
  & $cmd[0] $cmd[1..($cmd.Length - 1)] *> $log
  $code = $LASTEXITCODE
  Get-Content $log -Tail 8
  Record $name ($code -eq 0) "exit $code (log: $log)"
  return $code
}
# Works on Windows PowerShell 5.1 and PowerShell 7 (4xx/5xx do not throw).
function Probe($uri, $method = 'Get', $headers = @{}) {
  try {
    $r = Invoke-WebRequest $uri -Method $method -UseBasicParsing -Headers $headers -TimeoutSec 5
    return @{ Status = [int]$r.StatusCode; Acao = $r.Headers['Access-Control-Allow-Origin'] }
  } catch {
    $resp = $_.Exception.Response
    if ($resp) { return @{ Status = [int]$resp.StatusCode; Acao = $resp.Headers['Access-Control-Allow-Origin'] } }
    return @{ Status = 0; Acao = $null }
  }
}
function PortFree($port) {
  try { $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port); $l.Start(); $l.Stop(); return $true } catch { return $false }
}

# ---- toolchain ----
$nodeVersion = (& node --version) 2>$null
Record 'Node 24.x' ($nodeVersion -match '^v24\.') "found $nodeVersion (package.json engines: >=24.12.0 <25)"
$npmVersion = (& npm.cmd --version) 2>$null
Record 'npm available' ([bool]$npmVersion) "npm $npmVersion"
$sqliteOk = (& node -e "require('node:sqlite'); console.log('ok')" 2>$null) -eq 'ok'
Record 'node:sqlite' $sqliteOk 'built-in SQLite module loads'
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
Record 'Rust (cargo)' ([bool]$cargo) $(if ($cargo) { (& cargo --version) } else { 'missing: install Rust 1.97 + MSVC build tools' })
$anvil = Get-Command anvil -ErrorAction SilentlyContinue
Record 'Foundry anvil' ([bool]$anvil) $(if ($anvil) { (& anvil --version | Select-Object -First 1) } else { 'missing: 5 local-EVM Node tests need it (foundryup / Foundry 1.7.1)' })
foreach ($bin in @('target\debug\zecone-zcash.exe', 'target\debug\zecone-refund-signer.exe', 'services\zcash-watch\target\debug\zecone-zcash-watch.exe')) {
  Record "native binary $bin" (Test-Path -LiteralPath $bin) $(if (Test-Path -LiteralPath $bin) { 'present' } else { 'missing: cargo build (see README)' })
}

# ---- ports ----
foreach ($p in 3000, 3210, 4321, 4333) { Record "port $p free" (PortFree $p) $(if (PortFree $p) { 'available' } else { 'in use — stop the other process or change the port' }) }

# ---- install, build, static checks, unit tests ----
if (-not $SkipInstall) { Run 'npm install' @('npm.cmd', 'install', '--no-audit', '--no-fund') | Out-Null }
Record 'qrcode-generator installed' (Test-Path 'node_modules\qrcode-generator\qrcode.js') 'QR dependency for checkout'
Run 'sdk:build' @('npm.cmd', 'run', 'sdk:build') | Out-Null
Run 'typecheck' @('npm.cmd', 'run', 'typecheck') | Out-Null
Run 'typecheck:web' @('npm.cmd', 'run', 'typecheck:web') | Out-Null
Run 'lint' @('npm.cmd', 'run', 'lint') | Out-Null
Run 'payment/SDK/watcher tests' @('node', '--import', 'tsx', '--test', 'tests/payments.test.ts', 'tests/payments-api.test.ts', 'tests/payments-integration.test.ts', 'tests/sdk.test.ts', 'tests/watch-bridge.test.ts') | Out-Null
Run 'full Node test suite' @('npm.cmd', 'test') | Out-Null
Run 'production build (turbopack)' @('npm.cmd', 'run', 'build:web') | Out-Null

# ---- runtime: API, web app, example DApp (temporary DB) ----
$tmp = Join-Path $env:TEMP ("zecone-verify-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
$env:ZECONE_PAYMENTS_DB = Join-Path $tmp 'payments.sqlite'
$env:ACCESS_PASS_STATE = Join-Path $tmp 'access-pass.json'
$env:ZECONE_DEMO_OBSERVER_DELAY = '3'
$env:ZECONE_DEMO_OBSERVER_STEP = '1'
$procs = @()
try {
  $procs += Start-Process -PassThru -WindowStyle Hidden node -ArgumentList '--import', 'tsx', 'services/payments/server.ts' -RedirectStandardOutput "$tmp\api.log" -RedirectStandardError "$tmp\api.err"
  $procs += Start-Process -PassThru -WindowStyle Hidden node -ArgumentList 'node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3000' -RedirectStandardOutput "$tmp\web.log" -RedirectStandardError "$tmp\web.err"
  $procs += Start-Process -PassThru -WindowStyle Hidden node -ArgumentList '--import', 'tsx', 'examples/access-pass/server.ts' -RedirectStandardOutput "$tmp\dapp.log" -RedirectStandardError "$tmp\dapp.err"
  $deadline = (Get-Date).AddSeconds(60)
  do { Start-Sleep -Milliseconds 500; try { $h = Invoke-RestMethod 'http://127.0.0.1:4321/api/v1/health' -TimeoutSec 2 } catch { $h = $null } } until ($h -or (Get-Date) -gt $deadline)
  Record 'payments API starts' ([bool]$h) "mode=$($h.mode) livePayoutEnabled=$($h.livePayoutEnabled) zcashBroadcastEnabled=$($h.zcashBroadcastEnabled)"
  Record 'live payout and broadcast disabled' ($h -and -not $h.livePayoutEnabled -and -not $h.zcashBroadcastEnabled) 'health flags'
  do { Start-Sleep -Milliseconds 500; try { $w = Invoke-WebRequest 'http://127.0.0.1:3000/' -UseBasicParsing -TimeoutSec 3 } catch { $w = $null } } until ($w -or (Get-Date) -gt $deadline.AddSeconds(30))
  Record 'web app serves /' ($w -and $w.StatusCode -eq 200) "HTTP $($w.StatusCode)"
  try { $proxied = Invoke-RestMethod 'http://127.0.0.1:3000/zecone/api/v1/quote/preview?amountUsd=1.00' -TimeoutSec 5 } catch { $proxied = $null }
  Record 'web -> API connectivity (same-origin rewrite)' ($proxied.zecAmount -eq '0.02') "quote preview zecAmount=$($proxied.zecAmount)"
  try {
    $created = Invoke-RestMethod 'http://127.0.0.1:3000/api/checkout' -Method Post -ContentType 'application/json' -Headers @{ Origin = 'http://127.0.0.1:3000' } -Body '{"product":"access-pass"}'
    $id = $created.payment.id; $t = $created.payment.checkoutToken
    $view = Invoke-WebRequest "http://127.0.0.1:4321/api/v1/checkout/$id`?token=$t" -UseBasicParsing -Headers @{ Origin = 'http://127.0.0.1:4333' }
    $cv = ($view.Content | ConvertFrom-Json).checkout
    Record 'demo checkout is simulated (no payable address)' ($cv.simulated -and -not $cv.zcashAddress -and -not $cv.paymentUri) "simulated=$($cv.simulated)"
    Record 'CORS: public checkout readable cross-origin' ($view.Headers['Access-Control-Allow-Origin'] -eq '*') "ACAO=$($view.Headers['Access-Control-Allow-Origin'])"
    $list = Probe 'http://127.0.0.1:4321/api/v1/payments' 'Get' @{ Origin = 'http://evil.example' }
    Record 'CORS: authenticated API not browser-readable' ($list.Status -eq 401 -and -not $list.Acao) "HTTP $($list.Status), no ACAO"
    Start-Sleep -Seconds 12
    $done = (Invoke-RestMethod "http://127.0.0.1:4321/api/v1/checkout/$id`?token=$t").checkout
    Record 'demo observer completes server-side' ($done.state -eq 'COMPLETED' -and $done.evidenceKind -eq 'recorded-mainnet-replay') "state=$($done.state) evidence=$($done.evidenceKind)"
  } catch { Record 'demo checkout flow' $false $_.Exception.Message }
  try { $cfg = Invoke-RestMethod 'http://127.0.0.1:4333/api/config' -TimeoutSec 5 } catch { $cfg = $null }
  Record 'Access Pass example starts' ([bool]$cfg) "mode=$($cfg.mode)"
  $demo = Probe 'http://127.0.0.1:4321/api/v1/demo/pay_00000000000000000000000000' 'Post'
  Record 'no public completion route' ($demo.Status -eq 404) "HTTP $($demo.Status)"
} finally {
  $procs | ForEach-Object { if ($_ -and -not $_.HasExited) { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } }
  Remove-Item Env:ZECONE_PAYMENTS_DB, Env:ACCESS_PASS_STATE, Env:ZECONE_DEMO_OBSERVER_DELAY, Env:ZECONE_DEMO_OBSERVER_STEP -ErrorAction SilentlyContinue
}

# ---- wallet launcher compatibility (does not open a browser or pair) ----
Run 'wallet:build (webpack)' @('npm.cmd', 'run', 'wallet:build') | Out-Null
Record 'launcher prerequisites' ((Test-Path '.next\BUILD_ID') -and (Test-Path 'Launch-ZecOne.cmd') -and (Test-Path 'scripts\launch-wallet.ps1')) '.next/BUILD_ID + Launch-ZecOne.cmd present'
$surface = Select-String -Path 'services\wallet\server.ts' -Pattern 'ZECONE_SURFACE \?\?= "wallet"' -Quiet
Record 'wallet gateway serves the wallet at /' $surface 'services/wallet/server.ts sets ZECONE_SURFACE=wallet'

if ($WalletUi) { Run 'wallet UI suite (Edge)' @('npx.cmd', 'playwright', 'test') | Out-Null }
if ($Integration) { Run 'browser end-to-end (Edge)' @('npx.cmd', 'playwright', 'test', '-c', 'playwright.integration.config.ts') | Out-Null }

Write-Host "`n==== Summary ====" -ForegroundColor Cyan
$results | Format-Table -AutoSize | Out-String -Width 220 | Write-Host
$failed = ($results | Where-Object Result -eq 'FAIL').Count
Write-Host "$failed check(s) failed. Logs in $env:TEMP\zecone-verify-*.log"
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
exit $failed
