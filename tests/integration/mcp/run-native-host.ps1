param([Parameter(Mandatory=$true)][ValidatePattern('^run-[a-f0-9]{32}$')][string]$BootstrapRun)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$outputRoot = Join-Path $root ('.artifacts/tests/native-mcp-host/run-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $outputRoot
$Run = 'tests'
$node = Join-Path $root '.local/toolchain/node-v24.22.2-win-x64/node.exe'
if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -ne '1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9') { throw 'Node pin mismatch' }
$out = Join-Path $outputRoot "$Run.stdout.txt"; $err = Join-Path $outputRoot "$Run.stderr.txt"
if ((Test-Path $out) -or (Test-Path $err)) { throw 'Run exists' }

$accepted = Join-Path $root ('.artifacts/tests/native-mcp-bootstrap/' + $BootstrapRun)
$receipt = Get-Content -LiteralPath (Join-Path $accepted 'receipt.json') -Raw | ConvertFrom-Json
$env:TAHTIAPURI_NATIVE_IDENTITY_HELPER = Join-Path $accepted 'main-identity.exe'
$env:TAHTIAPURI_NATIVE_BOOTSTRAP_HELPER = Join-Path $accepted 'main-bootstrap.exe'
if ((Get-FileHash $env:TAHTIAPURI_NATIVE_IDENTITY_HELPER -Algorithm SHA256).Hash.ToLowerInvariant() -ne $receipt.identityHelperSha256) { throw 'Identity helper pin changed' }
if ((Get-FileHash $env:TAHTIAPURI_NATIVE_BOOTSTRAP_HELPER -Algorithm SHA256).Hash.ToLowerInvariant() -ne $receipt.publicationHelperSha256) { throw 'Publication helper pin changed' }
$required = @('apps/desktop/src/main/child-environment.ts','apps/desktop/src/main/native-bootstrap-operation.ts','apps/desktop/src/main/native-development-bootstrap.ts','apps/desktop/src/main/native-main-identity.ts','apps/desktop/src/main/private-directory.ts','apps/mcp/native/bootstrap-file.h','apps/mcp/native/bootstrap-publication.h','apps/mcp/native/main-bootstrap.cpp','apps/mcp/native/main-bootstrap.h','apps/mcp/native/main-identity.cpp','apps/mcp/native/main-peer.h','packages/windows-runtime/native/common.h','tests/integration/mcp/native-bootstrap-probe.cpp','tests/integration/mcp/native-bootstrap.integration.test.ts','tests/integration/mcp/native-publication.integration.test.ts','tests/integration/mcp/run-native-bootstrap.ps1')
if (@(Compare-Object $required @($receipt.source.psobject.Properties.Name)).Count -ne 0 -or $receipt.passed -ne 47 -or $receipt.failed -ne 0 -or $receipt.pending -ne 0) { throw 'Unaccepted bootstrap build receipt' }
foreach ($property in $receipt.source.psobject.Properties) {
  if ((Get-FileHash (Join-Path $root $property.Name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $property.Value) { throw 'Accepted helper source changed' }
}


$inputs = @{}
$paths = @('apps/desktop/src/main/native-development-host.ts','apps/desktop/src/main/native-mcp-helpers.ts','apps/desktop/src/main/native-operation-deadline.ts','apps/desktop/src/main/native-bootstrap-operation.ts','apps/desktop/src/main/native-development-bootstrap.ts','apps/desktop/src/main/native-mcp-helpers.test.ts','apps/desktop/src/main/native-development-wire.test.ts','apps/desktop/src/main/native-main-connection.test.ts','apps/desktop/src/main/development-owner.ts','apps/desktop/src/main/development-host.ts','apps/desktop/src/main/development-host.test.ts','tests/integration/mcp/native-host.integration.test.ts','apps/backend/src/modules/development/application/development-service.ts','apps/backend/src/modules/assistant/application/assistant-service.ts','apps/desktop/src/main/native-main-connection.ts','apps/desktop/src/main/native-development-admission.ts','apps/desktop/src/main/native-development-wire.ts','apps/desktop/src/main/native-development-writer.ts','tests/integration/mcp/run-native-host.ps1')
foreach ($path in $paths) { $inputs[$path] = (Get-FileHash (Join-Path $root $path) -Algorithm SHA256).Hash.ToLowerInvariant() }
$inputs | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputRoot "$Run.inputs.json") -Encoding UTF8

$arguments = @('node_modules/vitest/vitest.mjs','run','tests/integration/mcp/native-host.integration.test.ts','apps/desktop/src/main/development-host.test.ts','apps/desktop/src/main/native-mcp-helpers.test.ts','apps/desktop/src/main/native-development-wire.test.ts','apps/desktop/src/main/native-main-connection.test.ts','--testTimeout=30000','--hookTimeout=30000','--maxWorkers=1','--no-file-parallelism','--reporter=json',("--outputFile=" + [char]34 + (Join-Path $outputRoot "tests.json") + [char]34))
$p = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $root -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
$null = $p.Handle
$p.PriorityClass = 'BelowNormal'; $p.ProcessorAffinity = [IntPtr]1
if (!$p.WaitForExit(120000)) {
  $p.Refresh()
  $cleanup = [ordered]@{ deadline='host-tests'; rootAlreadyExited=$p.HasExited; taskkillExitCode=$null; rootExited=$false; descendantsVerified=$false }
  if (!$p.HasExited) {
    $killer = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/taskkill.exe') -ArgumentList ('/PID ' + $p.Id + ' /T /F') -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $outputRoot 'cleanup.stdout.txt') -RedirectStandardError (Join-Path $outputRoot 'cleanup.stderr.txt')
    $null = $killer.Handle
    if (!$killer.WaitForExit(3000)) { $killer.Kill(); $null = $killer.WaitForExit(1000) }
    if ($killer.HasExited) { $killer.WaitForExit(); $killer.Refresh(); $cleanup.taskkillExitCode = $killer.ExitCode }
  }
  $cleanup.rootExited = $p.WaitForExit(3000)
  $cleanup | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputRoot 'cleanup-uncertain.json') -Encoding UTF8
  throw 'Test deadline; descendant cleanup is not independently verified. No success receipt.'

}
$p.WaitForExit(); $p.Refresh()
Write-Output "Test process exit: $($p.ExitCode)"
Get-Content -LiteralPath $err
foreach ($path in $paths) {
  if ((Get-FileHash (Join-Path $root $path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $inputs[$path]) { throw 'Test source changed during run' }
}
if ($p.ExitCode -ne 0) { exit $p.ExitCode }
$result = Get-Content -LiteralPath (Join-Path $outputRoot 'tests.json') -Raw | ConvertFrom-Json
if (!$result.success -or $result.numTotalTests -ne 97 -or $result.numPassedTests -ne 97 -or $result.numFailedTests -ne 0 -or $result.numPendingTests -ne 0 -or $result.numTodoTests -ne 0) { throw 'Incomplete host test result' }
@{ source=$inputs; passed=97; failed=0; pending=0; identityHelperSha256=$receipt.identityHelperSha256; publicationHelperSha256=$receipt.publicationHelperSha256 } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $outputRoot 'receipt.json') -Encoding UTF8
Write-Output 'Native Main host integration passed: 97/97'

