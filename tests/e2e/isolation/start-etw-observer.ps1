param([Parameter(Mandatory=$true)][Guid]$RunId, [Parameter(Mandatory=$true)][uint32]$OwnerPid, [ValidateSet('observe','observe-error','observe-launcher-kill','observe-owner-kill','selftest-stop','selftest-crash')][string]$Scenario='observe', [ValidatePattern('^([0-9]{1,5},){3}[0-9]{1,5}$')][string]$Ports='0,0,0,0', [string]$OwnerImage='')
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$binary=Join-Path $root '.artifacts/tests/isolation/native/bin/etw-observer.exe'
if (!(Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'Build the reviewed ETW observer first.' }
if ($Scenario -in @('observe','observe-error','observe-launcher-kill','observe-owner-kill') -and (!$OwnerImage -or $OwnerImage -match '["\r\n]')) { throw 'The known endpoint owner image is required.' }
# The elevated collector can launch only its own fixed cleanup guard, never a probe.
$p=Start-Process -FilePath $binary -Verb RunAs -ArgumentList ($RunId.ToString()+' '+$OwnerPid+' '+$Scenario+' '+$Ports+' "'+$OwnerImage+'"') -PassThru
$null=$p.Handle
$p.WaitForExit();$p.Refresh()
exit $p.ExitCode
