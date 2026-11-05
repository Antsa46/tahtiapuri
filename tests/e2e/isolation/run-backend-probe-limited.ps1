param([Parameter(Mandatory=$true)][ValidateSet('unit','normal')][string]$Mode)
$ErrorActionPreference='Stop'
$self=[Diagnostics.Process]::GetCurrentProcess()
$self.PriorityClass=[Diagnostics.ProcessPriorityClass]::BelowNormal
$self.ProcessorAffinity=[IntPtr]1
$self.Refresh()
if($self.PriorityClass -ne [Diagnostics.ProcessPriorityClass]::BelowNormal -or $self.ProcessorAffinity.ToInt64() -ne 1){throw 'Backend launcher limits did not apply.'}
$projectRoot=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$tools=Get-Content -LiteralPath (Join-Path $projectRoot 'scripts/dev/toolchain.json') -Raw|ConvertFrom-Json
$node=Join-Path $projectRoot ('.local/toolchain/node-v'+$tools.node.version+'-win-x64/node.exe')
if(!(Test-Path -LiteralPath $node)){throw 'Existing pinned Node runtime is required.'}
$logRoot=Join-Path $projectRoot ('.artifacts/tests/isolation/backend-probe/launcher/'+$Mode+'-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $logRoot|Out-Null
$arguments='--max-old-space-size=256 '
if($Mode -eq 'unit'){
 $arguments+='--test --test-concurrency=1 '
 foreach($name in @('backend-codec.test.mjs','backend-worker.test.mjs','backend-resources.test.mjs','backend-port.test.mjs')){$arguments+='"'+(Join-Path $PSScriptRoot $name)+'" '}
}else{$arguments+='"'+(Join-Path $PSScriptRoot 'run-backend-probe.mjs')+'" --normal'}
$child=$null
try{
 $child=Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $projectRoot -RedirectStandardOutput (Join-Path $logRoot 'stdout.txt') -RedirectStandardError (Join-Path $logRoot 'stderr.txt') -NoNewWindow -PassThru
 $null=$child.Handle
 # The native broker independently bounds each worker to twenty seconds.
 if(!$child.WaitForExit(60000)){throw 'Owned backend driver exceeded the launcher deadline.'}
 $child.Refresh()
 [IO.File]::WriteAllText((Join-Path $logRoot 'exit.json'),(@{exitCode=$child.ExitCode;affinity=1;priority='BelowNormal';mode=$Mode}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
 Get-Content -LiteralPath (Join-Path $logRoot 'stdout.txt')
 Get-Content -LiteralPath (Join-Path $logRoot 'stderr.txt')
 if($child.ExitCode -ne 0){throw 'Backend probe failed; private diagnostics and any uncertain case roots are retained.'}
}finally{
 if($null -ne $child){
  $child.Refresh()
  if(!$child.HasExited){$child.Kill();if(!$child.WaitForExit(5000)){throw 'Owned backend driver did not stop.'}}
  $child.Dispose()
 }
}
