$ErrorActionPreference = "Stop"

$workspace = "C:\Users\Folarihn Top-Boi\Documents\ChatGPT\zecone"
$binary = Join-Path $workspace "services\zcash-mainnet-spend\target\debug\zecone-zcash-mainnet-spend.exe"
$passphraseFile = "D:\zecone-mainnet\passphrase.txt"

if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
    throw "Spending wallet binary is missing"
}
if (-not (Test-Path -LiteralPath $passphraseFile -PathType Leaf)) {
    throw "Passphrase file is missing"
}

$arguments = @(
    "dry-run",
    "--wallet", "D:\zecone-mainnet\zcash-spend-wallet",
    "--keystore", "D:\zecone-mainnet\provisioning\zcash-receiver.keystore.json",
    "--expected-account", "c89c7cda1189ef6eaac30df339e43b74142e49dfd1340bad213c10e356eac6b9",
    "--expected-address", "u13cvyuec8pnfx8ydcm6f3js5quu3nl2pp56ld8z03548w55qv0xhhwz67npgp0ypevusapedw9davchxwe3k7f8jfghsukkl0zghr3zwf",
    "--birthday", "3528700",
    "--server", "https://zec.rocks:443",
    "--peer", "https://us.zec.stardust.rest:443",
    "--recipient", "u13cvyuec8pnfx8ydcm6f3js5quu3nl2pp56ld8z03548w55qv0xhhwz67npgp0ypevusapedw9davchxwe3k7f8jfghsukkl0zghr3zwf",
    "--zatoshis", "100000",
    "--max-fee", "20000",
    "--journal", "D:\zecone-mainnet\zcash-spend-sessions.sqlite",
    "--approval-validity-seconds", "3600"
)

$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $binary
$start.WorkingDirectory = $workspace
$start.UseShellExecute = $false
$start.RedirectStandardInput = $true
foreach ($argument in $arguments) {
    [void]$start.ArgumentList.Add($argument)
}

$child = [Diagnostics.Process]::new()
$child.StartInfo = $start
if (-not $child.Start()) {
    throw "Could not start spending wallet"
}

try {
    $secret = [IO.File]::ReadAllText($passphraseFile).TrimEnd([char[]]"`r`n")
    $child.StandardInput.WriteLine($secret)
    $child.StandardInput.Flush()
    $secret = $null
    [GC]::Collect()

    while (-not $child.HasExited) {
        $operatorLine = [Console]::ReadLine()
        if ($null -eq $operatorLine) {
            break
        }
        if ($child.HasExited) {
            break
        }
        $child.StandardInput.WriteLine($operatorLine)
        $child.StandardInput.Flush()
        $operatorLine = $null
    }
    $child.WaitForExit()
    exit $child.ExitCode
}
finally {
    $secret = $null
    $operatorLine = $null
    if (-not $child.HasExited) {
        $child.Kill($true)
    }
    $child.Dispose()
}
