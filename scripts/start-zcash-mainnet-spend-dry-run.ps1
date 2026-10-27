$ErrorActionPreference = "Stop"

$workspace = "C:\Users\Folarihn Top-Boi\Documents\ChatGPT\zecone"
$binary = Join-Path $workspace "services\zcash-mainnet-spend\target\debug\zecone-zcash-mainnet-spend.exe"

if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
    throw "Build the spending wallet first: cargo build --manifest-path services/zcash-mainnet-spend/Cargo.toml"
}

Set-Location -LiteralPath $workspace

& $binary dry-run `
    --wallet "D:\zecone-mainnet\zcash-spend-wallet" `
    --keystore "D:\zecone-mainnet\provisioning\zcash-receiver.keystore.json" `
    --expected-account "c89c7cda1189ef6eaac30df339e43b74142e49dfd1340bad213c10e356eac6b9" `
    --expected-address "u13cvyuec8pnfx8ydcm6f3js5quu3nl2pp56ld8z03548w55qv0xhhwz67npgp0ypevusapedw9davchxwe3k7f8jfghsukkl0zghr3zwf" `
    --birthday 3528700 `
    --server "https://zec.rocks:443" `
    --peer "https://us.zec.stardust.rest:443" `
    --recipient "u13cvyuec8pnfx8ydcm6f3js5quu3nl2pp56ld8z03548w55qv0xhhwz67npgp0ypevusapedw9davchxwe3k7f8jfghsukkl0zghr3zwf" `
    --zatoshis 100000 `
    --max-fee 20000 `
    --journal "D:\zecone-mainnet\zcash-spend-sessions.sqlite" `
    --approval-validity-seconds 3600

exit $LASTEXITCODE
