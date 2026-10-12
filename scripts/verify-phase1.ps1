$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path 'docs/phase1-evidence' | Out-Null
cargo fmt --all -- --check 2>&1 | Tee-Object -FilePath 'docs/phase1-evidence/rust-format.txt'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Set-Content -LiteralPath 'docs/phase1-evidence/rust-format.txt' -Value 'cargo fmt --all -- --check: passed.'
cargo test --locked --offline 2>&1 | Tee-Object -FilePath 'docs/phase1-evidence/rust-tests.txt'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
forge test 2>&1 | Tee-Object -FilePath 'docs/phase1-evidence/contract-tests.txt'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm.cmd run typecheck 2>&1 | Tee-Object -FilePath 'docs/phase1-evidence/typescript.txt'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm.cmd run typecheck:web 2>&1 | Tee-Object -FilePath 'docs/phase1-evidence/typescript-web.txt'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm.cmd test 2>&1 | Tee-Object -FilePath 'docs/phase1-evidence/typescript-tests.txt'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm.cmd run wallet:build 2>&1 | Tee-Object -FilePath 'docs/phase1-evidence/build.txt'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm.cmd run test:ui 2>&1 | Tee-Object -FilePath 'docs/phase1-evidence/ui-tests.txt'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output 'Phase 1 verification passed. This test suite did not send real testnet transactions.'
foreach ($evidenceFile in (Get-ChildItem -LiteralPath 'docs/phase1-evidence' -Filter '*.txt')) {
  $evidenceText = ([System.IO.File]::ReadAllLines($evidenceFile.FullName) | ForEach-Object { $_.TrimEnd() }) -join "`n"
  $evidenceText = $evidenceText.TrimEnd() + "`n"
  [System.IO.File]::WriteAllText($evidenceFile.FullName, $evidenceText, (New-Object System.Text.UTF8Encoding($false)))
}
