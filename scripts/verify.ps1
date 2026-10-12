$ErrorActionPreference = 'Continue' # Native tools write normal build progress to stderr.
New-Item -ItemType Directory -Force -Path 'docs/evidence' | Out-Null
cargo fmt --all -- --check 2>&1 | Tee-Object -FilePath 'docs/evidence/rust-format.txt'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Set-Content -LiteralPath 'docs/evidence/rust-format.txt' -Value 'cargo fmt --all -- --check: exit code 0; no formatting differences.' -Encoding UTF8
cargo test --locked --offline 2>&1 | Tee-Object -FilePath 'docs/evidence/rust-tests.txt'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
forge test 2>&1 | Tee-Object -FilePath 'docs/evidence/contract-tests.txt'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm.cmd run typecheck 2>&1 | Tee-Object -FilePath 'docs/evidence/typescript.txt'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm.cmd test 2>&1 | Tee-Object -FilePath 'docs/evidence/typescript-tests.txt'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output 'Offline verification complete. No public testnet transaction was sent.'
foreach ($evidenceFile in (Get-ChildItem -LiteralPath 'docs/evidence' -Filter '*.txt')) {
    $contents = Get-Content -LiteralPath $evidenceFile.FullName -Raw
    [System.IO.File]::WriteAllText($evidenceFile.FullName, $contents, (New-Object System.Text.UTF8Encoding($false)))
}
