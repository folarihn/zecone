# ZecOne — Windows / Node 24 verification.
#
# Safe by design: never signs, broadcasts, funds or moves ZEC/ETH, never touches
# .secrets/, never creates wallet seeds, and never edits your .state/payments.sqlite.
# It runs its OWN isolated instances of the payment API, web app and Access Pass on
# dedicated ports with a temporary database, and stops only the processes it started.
# Services you already run on 3000 / 4321 / 4333 are identified and reported, not
# touched (unless you pass -StopStaleZecOne, which stops only ZecOne processes from
# THIS repository that are running outdated code).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-windows.ps1 -Integration -WalletUi
#     -Integration      also run the browser end-to-end suite (Microsoft Edge, isolated ports)
#     -WalletUi         also run the existing wallet UI suite (Microsoft Edge, port 3211)
#     -SkipInstall      skip `npm install`
#     -SkipBuild        skip production builds (use the existing .next build)
#     -StopStaleZecOne  stop outdated ZecOne services from this repo found on the default ports
#
# Logs: .state\verify-windows\<timestamp>\ (gitignored). Exit code = number of FAIL checks.
param([switch]$Integration, [switch]$WalletUi, [switch]$SkipInstall, [switch]$SkipBuild, [switch]$StopStaleZecOne)

$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
Set-Location -LiteralPath $root
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logDir = Join-Path $root ".state\verify-windows\$stamp"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$transcript = Join-Path $logDir 'transcript.txt'
Start-Transcript -Path $transcript -Force | Out-Null

# Isolated ports for this script's own services (distinct from dev defaults and from the
# integration suite's 4391/3091/4393).
$ApiPort = 4381; $WebPort = 3081; $DappPort = 4383
$Api = "http://127.0.0.1:$ApiPort"; $Web = "http://127.0.0.1:$WebPort"; $Dapp = "http://127.0.0.1:$DappPort"

$results = New-Object System.Collections.Generic.List[object]
function Record($name, $status, $detail) {
  $results.Add([pscustomobject]@{ Check = $name; Result = $status; Detail = $detail })
  $color = @{ PASS = 'Green'; FAIL = 'Red'; WARN = 'Yellow'; INFO = 'Gray' }[$status]
  Write-Host ("[{0}] {1} — {2}" -f $status, $name, $detail) -ForegroundColor $color
}
function Check($name, $ok, $detail) { if ($ok) { Record $name 'PASS' $detail } else { Record $name 'FAIL' $detail } }

function Run($name, [string[]]$cmd) {
  Write-Host "`n> $($cmd -join ' ')" -ForegroundColor Cyan
  $log = Join-Path $logDir (($name -replace '[^a-zA-Z0-9]+', '-') + '.log')
  & $cmd[0] $cmd[1..($cmd.Length - 1)] *> $log
  $code = $LASTEXITCODE
  Get-Content $log -Tail 12
  Check $name ($code -eq 0) "exit $code (log: $log)"
  return $code
}

# HTTP helper that works on Windows PowerShell 5.1 and PowerShell 7 and always
# returns the status code and response body (so API errors are visible).
function Http($method, $uri, $body = $null, $headers = @{}) {
  try {
    $p = @{ Uri = $uri; Method = $method; UseBasicParsing = $true; TimeoutSec = 10; Headers = $headers }
    if ($body -ne $null) { $p.Body = $body; $p.ContentType = 'application/json' }
    $r = Invoke-WebRequest @p
    return [pscustomobject]@{ Status = [int]$r.StatusCode; Body = $r.Content; Headers = $r.Headers }
  } catch {
    $status = 0; $text = $_.Exception.Message; $hdrs = @{}
    $resp = $_.Exception.Response
    if ($resp) {
      $status = [int]$resp.StatusCode
      if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $text = $_.ErrorDetails.Message }
      elseif ($resp.GetType().GetMethod('GetResponseStream')) {
        try { $text = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd() } catch {}
      }
      try { $hdrs = $resp.Headers } catch {}
    }
    return [pscustomobject]@{ Status = $status; Body = $text; Headers = $hdrs }
  }
}
function Json($r) { try { return $r.Body | ConvertFrom-Json } catch { return $null } }
function Header($r, $name) { try { $v = $r.Headers[$name]; if ($v -is [array]) { return $v[0] } return $v } catch { return $null } }

function PortOwner($port) {
  $conn = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $conn) { return $null }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" -ErrorAction SilentlyContinue
  return [pscustomobject]@{ Pid = $conn.OwningProcess; Name = $proc.Name; Path = $proc.ExecutablePath; CommandLine = $proc.CommandLine }
}

function StopTree($procId) {
  # Polite first, then forced; /T includes child processes (e.g. Next.js workers).
  & taskkill.exe /PID $procId /T *> $null
  Start-Sleep -Seconds 3
  if (Get-Process -Id $procId -ErrorAction SilentlyContinue) { & taskkill.exe /PID $procId /T /F *> $null }
}

# ------------------------------------------------------------------ toolchain
Write-Host "Logs: $logDir" -ForegroundColor Cyan
$nodeVersion = (& node --version) 2>$null
Check 'Node 24.x' ($nodeVersion -match '^v24\.') "found $nodeVersion (package.json engines: >=24.12.0 <25)"
$npmVersion = (& npm.cmd --version) 2>$null
Check 'npm available' ([bool]$npmVersion) "npm $npmVersion"
$sqliteOk = (& node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.exec('create table t(x)');console.log('ok')" 2>$null) -eq 'ok'
Check 'node:sqlite' $sqliteOk 'built-in SQLite opens and writes'
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
Check 'Rust (cargo)' ([bool]$cargo) $(if ($cargo) { (& cargo --version) } else { 'missing: install Rust 1.97 + MSVC build tools' })
$anvil = Get-Command anvil -ErrorAction SilentlyContinue
Check 'Foundry anvil' ([bool]$anvil) $(if ($anvil) { (& anvil --version | Select-Object -First 1) } else { 'missing: 5 local-EVM Node tests need it' })
foreach ($bin in @('target\debug\zecone-zcash.exe', 'target\debug\zecone-refund-signer.exe', 'target\debug\inspect-mainnet-ufvk.exe')) {
  Check "native binary $bin" (Test-Path -LiteralPath $bin) $(if (Test-Path -LiteralPath $bin) { 'present' } else { 'missing: cargo build (see README)' })
}

# ------------------------------------------------------------------ what is already running
# Default dev ports are reported, never killed (except stale ZecOne with -StopStaleZecOne).
$known = @{ 3000 = 'web'; 3210 = 'wallet gateway'; 3211 = 'wallet UI tests'; 4321 = 'payments API'; 4333 = 'Access Pass' }
foreach ($port in 3000, 3210, 3211, 4321, 4333) {
  $owner = PortOwner $port
  if (-not $owner) { Record "port $port ($($known[$port]))" 'INFO' 'free'; continue }
  $fromRepo = $owner.CommandLine -and $owner.CommandLine.ToLower().Contains($root.ToLower())
  $identity = ''; $stale = $false
  if ($port -eq 4321) {
    $h = Json (Http 'GET' "http://127.0.0.1:4321/api/v1/health")
    if ($h -and $h.service -eq 'zecone-payments') { $identity = "zecone-payments v$($h.apiVersion) mode=$($h.mode)" }
    elseif ($h -and $h.status -eq 'ok' -and $h.livePayoutEnabled -ne $null) { $identity = 'zecone-payments (OUTDATED: started before the current code; no quote preview, old request format)'; $stale = $true }
  } elseif ($port -eq 4333) {
    $c = Json (Http 'GET' "http://127.0.0.1:4333/api/config")
    if ($c -and $c.service -eq 'zecone-access-pass') { $identity = 'zecone-access-pass (current)' }
    elseif ($fromRepo) { $identity = 'Access Pass (OUTDATED code)'; $stale = $true }
  } elseif ($port -eq 3000) {
    $s = Json (Http 'GET' "http://127.0.0.1:3000/api/site-health")
    if ($s -and $s.service -eq 'zecone-web') { $identity = "zecone-web -> $($s.paymentsApi)" } elseif ($fromRepo) { $identity = 'ZecOne web (OUTDATED code)'; $stale = $true }
  }
  if (-not $identity) { $identity = if ($fromRepo) { 'ZecOne process from this repo' } else { 'NOT ZecOne' } }
  $detail = "pid $($owner.Pid) $($owner.Name): $identity | $($owner.CommandLine)"
  if ($stale -and $fromRepo -and $StopStaleZecOne) {
    StopTree $owner.Pid
    Record "port $port ($($known[$port]))" 'WARN' "stopped outdated ZecOne service — $detail"
  } elseif ($stale) {
    Record "port $port ($($known[$port]))" 'WARN' "outdated ZecOne service; restart it (or re-run with -StopStaleZecOne) — $detail"
  } elseif ($fromRepo -or $identity -like 'zecone-*') {
    Record "port $port ($($known[$port]))" 'INFO' "existing ZecOne service, left running — $detail"
  } else {
    Record "port $port ($($known[$port]))" 'WARN' "used by another application; this script uses isolated ports — $detail"
  }
}
foreach ($port in $ApiPort, $WebPort, $DappPort, 4391, 3091, 4393) {
  $owner = PortOwner $port
  Check "isolated port $port free" (-not $owner) $(if ($owner) { "in use by pid $($owner.Pid) $($owner.Name): $($owner.CommandLine)" } else { 'available' })
}

# ------------------------------------------------------------------ install, build, static checks, tests
if (-not $SkipInstall) { Run 'npm install' @('npm.cmd', 'install', '--no-audit', '--no-fund') | Out-Null }
Check 'qrcode-generator installed' (Test-Path 'node_modules\qrcode-generator\qrcode.js') 'QR dependency for checkout'
Run 'sdk:build' @('npm.cmd', 'run', 'sdk:build') | Out-Null
Run 'typecheck' @('npm.cmd', 'run', 'typecheck') | Out-Null
Run 'typecheck:web' @('npm.cmd', 'run', 'typecheck:web') | Out-Null
Run 'lint' @('npm.cmd', 'run', 'lint') | Out-Null
Run 'payment/SDK/watcher tests' @('node', '--import', 'tsx', '--test', 'tests/payments.test.ts', 'tests/payments-api.test.ts', 'tests/payments-integration.test.ts', 'tests/sdk.test.ts', 'tests/watch-bridge.test.ts') | Out-Null
Run 'full Node test suite' @('npm.cmd', 'test') | Out-Null
if (-not $SkipBuild) { Run 'production build (turbopack)' @('npm.cmd', 'run', 'build:web') | Out-Null }

# ------------------------------------------------------------------ runtime: own isolated services
$tmp = Join-Path $logDir 'runtime'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$owned = New-Object System.Collections.Generic.List[object]
function StartOwned($name, [string[]]$arguments, [hashtable]$vars) {
  $saved = @{}
  foreach ($k in $vars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process'); [Environment]::SetEnvironmentVariable($k, $vars[$k], 'Process') }
  try {
    $p = Start-Process -PassThru -WindowStyle Hidden -FilePath 'node' -ArgumentList $arguments -WorkingDirectory $root `
      -RedirectStandardOutput (Join-Path $tmp "$name.out.log") -RedirectStandardError (Join-Path $tmp "$name.err.log")
    $owned.Add([pscustomobject]@{ Name = $name; Process = $p })
    return $p
  } finally {
    foreach ($k in $vars.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
  }
}
function WaitFor($uri, $seconds, $predicate) {
  $deadline = (Get-Date).AddSeconds($seconds)
  do {
    $r = Http 'GET' $uri
    $j = Json $r
    if ($r.Status -eq 200 -and $j -and (& $predicate $j)) { return $j }
    Start-Sleep -Milliseconds 700
  } until ((Get-Date) -gt $deadline)
  return $null
}
function ShowLog($name) { foreach ($f in "$name.out.log", "$name.err.log") { $p = Join-Path $tmp $f; if (Test-Path $p) { Write-Host "--- $f"; Get-Content $p -Tail 15 } } }

$common = @{
  NEXT_TELEMETRY_DISABLED = '1'
  ZECONE_PAYMENTS_MODE = 'demo'; ZECONE_PAYMENTS_HOST = '127.0.0.1'; ZECONE_PAYMENTS_PORT = "$ApiPort"
  ZECONE_PAYMENTS_DB = (Join-Path $tmp 'payments.sqlite')
  ZECONE_DEMO_OBSERVER = '1'; ZECONE_DEMO_OBSERVER_DELAY = '3'; ZECONE_DEMO_OBSERVER_STEP = '1'
  ZECONE_BASE_URL = $Api; ZECONE_PUBLIC_URL = $Web; ZECONE_WEB_URL = $Web
  ZECONE_SIWE_DOMAINS = "127.0.0.1:$WebPort,localhost:$WebPort,127.0.0.1:$DappPort"
  ZECONE_OPERATOR_TOKEN = ''
  ACCESS_PASS_HOST = '127.0.0.1'; ACCESS_PASS_PORT = "$DappPort"; ACCESS_PASS_PUBLIC_URL = $Dapp
  ACCESS_PASS_STATE = (Join-Path $tmp 'access-pass.json')
}
try {
  $apiProc = StartOwned 'payments' @('--import', 'tsx', 'services/payments/server.ts') $common
  $h = WaitFor "$Api/api/v1/health" 60 { param($j) $j.service -eq 'zecone-payments' }
  Check 'payments API starts (own instance)' ($h -and $h.pid -eq $apiProc.Id) $(if ($h) { "service=$($h.service) v$($h.apiVersion) pid=$($h.pid) (started $($apiProc.Id)) mode=$($h.mode)" } else { 'no healthy response'; ShowLog 'payments' })
  Check 'live payout, broadcast and settlement disabled' ($h -and -not $h.livePayoutEnabled -and -not $h.zcashBroadcastEnabled -and $h.settlement -eq 'disabled') "livePayoutEnabled=$($h.livePayoutEnabled) zcashBroadcastEnabled=$($h.zcashBroadcastEnabled) settlement=$($h.settlement)"

  $webProc = StartOwned 'web' @('node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', "$WebPort") $common
  $s = WaitFor "$Web/api/site-health" 120 { param($j) $j.service -eq 'zecone-web' }
  Check 'web app starts (own instance)' ([bool]$s) $(if ($s) { "service=$($s.service) target=$($s.paymentsApi)" } else { 'no response'; ShowLog 'web' })
  Check 'web targets OUR payments API' ($s -and $s.paymentsApi -eq $Api -and $s.payments.pid -eq $apiProc.Id) "web -> $($s.paymentsApi), API pid $($s.payments.pid)"

  $q = Http 'GET' "$Web/zecone/api/v1/quote/preview?amountUsd=1.00"
  $qj = Json $q
  Check 'web -> API same-origin proxy (quote preview)' ($q.Status -eq 200 -and $qj.zecAmount -eq '0.02') "HTTP $($q.Status) zecAmount=$($qj.zecAmount) body=$($q.Body)"
  $blocked = Http 'GET' "$Web/zecone/api/v1/payments"
  Check 'proxy refuses authenticated API paths' ($blocked.Status -eq 404) "HTTP $($blocked.Status)"

  $c = Http 'POST' "$Web/api/checkout" '{"product":"access-pass"}' @{ Origin = $Web }
  $cj = Json $c
  Check 'demo checkout created via website' ($c.Status -eq 201 -and $cj.payment.id) "HTTP $($c.Status) body=$($c.Body)"
  if ($cj.payment.id) {
    $id = $cj.payment.id; $t = $cj.payment.checkoutToken
    $view = Http 'GET' "$Api/api/v1/checkout/$id`?token=$t" $null @{ Origin = $Dapp }
    $cv = (Json $view).checkout
    Check 'demo checkout is simulated (no payable address/URI)' ($cv.simulated -eq $true -and -not $cv.zcashAddress -and -not $cv.paymentUri) "simulated=$($cv.simulated) address=$($cv.zcashAddress)"
    Check 'CORS: public checkout readable cross-origin' ((Header $view 'Access-Control-Allow-Origin') -eq '*') "ACAO=$(Header $view 'Access-Control-Allow-Origin')"
    $list = Http 'GET' "$Api/api/v1/payments" $null @{ Origin = 'http://evil.example' }
    Check 'CORS: authenticated API not browser-readable' ($list.Status -eq 401 -and -not (Header $list 'Access-Control-Allow-Origin')) "HTTP $($list.Status) ACAO=$(Header $list 'Access-Control-Allow-Origin')"
    $sse = Http 'GET' "$Web/zecone/api/v1/checkout/$id/events?token=$t"
    Check 'checkout SSE endpoint via web proxy' ($sse.Body -match 'event: checkout') "HTTP $($sse.Status) $(($sse.Body -split "`n")[0])"
    $states = @()
    $deadline = (Get-Date).AddSeconds(30)
    do {
      Start-Sleep -Seconds 1
      $cur = (Json (Http 'GET' "$Web/zecone/api/v1/checkout/$id`?token=$t")).checkout
      if ($cur -and ($states.Count -eq 0 -or $states[-1] -ne $cur.state)) { $states += $cur.state }
    } until (($cur -and $cur.state -eq 'COMPLETED') -or (Get-Date) -gt $deadline)
    Check 'demo replay advances server-side to COMPLETED' ($cur.state -eq 'COMPLETED' -and $cur.evidenceKind -eq 'recorded-mainnet-replay') "states: $($states -join ' -> ') evidence=$($cur.evidenceKind)"
  }

  $dappProc = StartOwned 'access-pass' @('--import', 'tsx', 'examples/access-pass/server.ts') $common
  $d = WaitFor "$Dapp/api/config" 60 { param($j) $j.service -eq 'zecone-access-pass' }
  Check 'Access Pass starts (own instance)' ($d -and $d.pid -eq $dappProc.Id -and $d.zeconeApi -eq $Api -and $d.zeconeWeb -eq $Web) $(if ($d) { "pid=$($d.pid) api=$($d.zeconeApi) web=$($d.zeconeWeb)" } else { 'no response'; ShowLog 'access-pass' })
  $forged = Http 'POST' "$Dapp/webhooks/zecone" '{"id":"evt_x","type":"payment.completed"}' @{ 'X-ZecOne-Signature' = "t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()),v1=$('0' * 64)" }
  Check 'Access Pass rejects forged webhooks' ($forged.Status -eq 401 -or $forged.Status -eq 503) "HTTP $($forged.Status) $($forged.Body)"
  $demo = Http 'POST' "$Api/api/v1/demo/pay_00000000000000000000000000"
  Check 'no public completion route' ($demo.Status -eq 404) "HTTP $($demo.Status)"
} finally {
  foreach ($o in $owned) { if ($o.Process -and -not $o.Process.HasExited) { StopTree $o.Process.Id } }
  Start-Sleep -Seconds 1
  foreach ($o in $owned) { Check "stopped own $($o.Name) process" ($o.Process.HasExited -or -not (Get-Process -Id $o.Process.Id -ErrorAction SilentlyContinue)) "pid $($o.Process.Id)" }
}

# ------------------------------------------------------------------ wallet launcher (no browser, no pairing)
if (-not $SkipBuild) { Run 'wallet:build (webpack)' @('npm.cmd', 'run', 'wallet:build') | Out-Null }
Check 'launcher prerequisites' ((Test-Path '.next\BUILD_ID') -and (Test-Path 'Launch-ZecOne.cmd') -and (Test-Path 'scripts\launch-wallet.ps1')) '.next/BUILD_ID + Launch-ZecOne.cmd present'
Check 'wallet gateway serves the wallet at /' (Select-String -Path 'services\wallet\server.ts' -Pattern 'ZECONE_SURFACE \?\?= "wallet"' -Quiet) 'services/wallet/server.ts sets ZECONE_SURFACE=wallet'

if ($WalletUi) { Run 'wallet UI suite (Edge, port 3211)' @('npx.cmd', 'playwright', 'test') | Out-Null }
if ($Integration) {
  $env:ZECONE_IT_DIR = Join-Path $logDir 'integration'
  New-Item -ItemType Directory -Force -Path $env:ZECONE_IT_DIR | Out-Null
  $code = Run 'browser end-to-end (Edge, isolated ports 4391/3091/4393)' @('npx.cmd', 'playwright', 'test', '-c', 'playwright.integration.config.ts', '--output', (Join-Path $logDir 'integration\artifacts'))
  if ($code -ne 0 -and (Test-Path (Join-Path $env:ZECONE_IT_DIR 'results.json'))) {
    Write-Host 'Failed browser tests:' -ForegroundColor Red
    $rj = Get-Content (Join-Path $env:ZECONE_IT_DIR 'results.json') -Raw | ConvertFrom-Json
    foreach ($suite in $rj.suites) { foreach ($spec in $suite.specs) { if (-not $spec.ok) { Write-Host " - $($spec.title)"; foreach ($t in $spec.tests) { foreach ($res in $t.results) { if ($res.error) { Write-Host "   $($res.error.message)" } } } } } }
  }
  Remove-Item Env:ZECONE_IT_DIR -ErrorAction SilentlyContinue
}

# ------------------------------------------------------------------ summary
Write-Host "`n==== Summary ====" -ForegroundColor Cyan
$results | Format-Table -AutoSize -Wrap | Out-String -Width 240 | Write-Host
$results | ConvertTo-Json -Depth 3 | Set-Content -Path (Join-Path $logDir 'summary.json') -Encoding UTF8
$failed = @($results | Where-Object Result -eq 'FAIL').Count
$warned = @($results | Where-Object Result -eq 'WARN').Count
Write-Host "$failed FAIL, $warned WARN. Logs: $logDir"
Stop-Transcript | Out-Null
exit $failed
