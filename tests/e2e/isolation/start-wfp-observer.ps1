param([Parameter(Mandatory=$true)][Guid]$RunId, [Parameter(Mandatory=$true)][uint32]$OwnerPid)
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$binary=Join-Path $root '.artifacts/tests/isolation/native/bin/wfp-observer.exe'
if (!(Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'Build the reviewed native observer first.' }
# Only this fixed read-only observer is elevated. The test driver is never elevated.
$p=Start-Process -FilePath $binary -Verb RunAs -ArgumentList ($RunId.ToString()+' '+$OwnerPid) -PassThru
$null=$p.Handle
$p.WaitForExit();$p.Refresh()
exit $p.ExitCode
