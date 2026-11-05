param([Parameter(Mandatory=$true)][ValidateSet('unit','batch-a')][string]$Mode)
$ErrorActionPreference='Stop'
$self=[Diagnostics.Process]::GetCurrentProcess()
$self.PriorityClass=[Diagnostics.ProcessPriorityClass]::BelowNormal
$self.ProcessorAffinity=[IntPtr]1
$self.Refresh()
if($self.PriorityClass -ne [Diagnostics.ProcessPriorityClass]::BelowNormal -or $self.ProcessorAffinity.ToInt64() -ne 1){throw 'Backend lifecycle launcher limits did not apply.'}
$projectRoot=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$tools=Get-Content -LiteralPath (Join-Path $projectRoot 'scripts/dev/toolchain.json') -Raw -Encoding UTF8|ConvertFrom-Json
$node=Join-Path $projectRoot ('.local/toolchain/node-v'+$tools.node.version+'-win-x64/node.exe')
if(!(Test-Path -LiteralPath $node)){throw 'Existing pinned Node runtime is required.'}
$logRoot=Join-Path $projectRoot ('.artifacts/tests/isolation/backend-lifecycle/launcher/'+$Mode+'-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $logRoot|Out-Null
$arguments='--max-old-space-size=256 '
if($Mode -eq 'unit'){
 $arguments+='--test --test-concurrency=1 '
 foreach($name in @('backend-lifecycle-results.test.mjs','backend-lifecycle-owner.test.mjs','backend-port.test.mjs')){$arguments+='"'+(Join-Path $PSScriptRoot $name)+'" '}
}else{$arguments+='"'+(Join-Path $PSScriptRoot 'run-backend-lifecycle-probe.mjs')+'" --batch-a'}
$child=$null
try{
 $child=Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $projectRoot -RedirectStandardOutput (Join-Path $logRoot 'stdout.txt') -RedirectStandardError (Join-Path $logRoot 'stderr.txt') -NoNewWindow -PassThru
 $null=$child.Handle
 # Cases are serial; the native broker bounds each worker to twenty seconds.
 $deadline=[DateTime]::UtcNow.AddMinutes(3)
 while(!$child.WaitForExit(1000)){if([DateTime]::UtcNow -gt $deadline){throw 'Owned lifecycle driver exceeded the launcher deadline.'}}
 $child.Refresh()
 [IO.File]::WriteAllText((Join-Path $logRoot 'exit.json'),(@{exitCode=$child.ExitCode;affinity=1;priority='BelowNormal';maxOldSpaceMiB=256;mode=$Mode}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
 Get-Content -LiteralPath (Join-Path $logRoot 'stdout.txt') -Encoding UTF8
 Get-Content -LiteralPath (Join-Path $logRoot 'stderr.txt') -Encoding UTF8
 if($child.ExitCode -ne 0){throw 'Backend lifecycle probe failed; private evidence and uncertain case roots remain.'}
}finally{
 if($null -ne $child){
  $child.Refresh()
  if(!$child.HasExited){$child.Kill();if(!$child.WaitForExit(5000)){throw 'Owned lifecycle driver did not stop.'}}
  $child.Dispose()
 }
}
