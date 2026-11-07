# Real fixed-script test only; a reviewed pinned recipe owns this process tree.
# No custom native binary. This probe does not establish Worker/Host isolation.
param([Parameter(Mandatory=$true)][ValidateSet('eof-0','eof-1','eof-2','eof-3','eof-4','eof-5','eof-6','eof-7','wrong','trailing','hold','valid-new','valid-existing','leaf-acl','parent-acl','missing-parent','file-leaf','leaf-junction','parent-junction')][string]$Case)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$utf8=[Text.UTF8Encoding]::new($false,$true)
$cases=@('valid-new','valid-existing','eof-0','eof-1','eof-2','eof-3','eof-4','eof-5','eof-6','eof-7','wrong','trailing','hold','leaf-acl','parent-acl','missing-parent','file-leaf','leaf-junction','parent-junction')
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$root=[IO.Path]::GetFullPath($env:TAHTIAPURI_DIRECTORY_SCRIPT_RUN_ROOT)
if([IO.Path]::GetDirectoryName($root) -cne (Join-Path $project '.artifacts/tests/native-directory-script') -or [IO.Path]::GetFileName($root) -cnotmatch '^run-[a-f0-9]{32}$'){throw 'Reviewed directory-script recipe required.'}
$caseRoot=Join-Path $root ('case-'+([Array]::IndexOf($cases,$Case)+1).ToString('00'))
$target=Join-Path $caseRoot 'parent/control'
$clock=[Diagnostics.Stopwatch]::StartNew() # BEFORE Start(), never renewed.
$ctx=[pscustomobject]@{process=$null;startAttempted=$false;started=$false;exitObserved=$false;exitCode=$null;inputBytesWritten=0;requestedInputBytes=$null;writeAttempted=$false;writeReturned=$false;flushAttempted=$false;flushReturned=$false;eofAttempted=$false;eofReturned=$false;inputCloseAttempted=$false;inputCloseReturned=$false;inputCloseKind=$null;stdinEncodingBefore=$null;stdinEncodingAfter=$null;inputClosedBeforeKill=$false;grantWrittenAt=$null;startReturnedAt=$null;killRequested=$false;plannedHoldKill=$false;sampleAbsent=$null;stdout=$null;stderr=$null;failure=$null;events=[Collections.Generic.List[object]]::new();sealed=$false}
function Note([string]$Stage){if($ctx.events.Count -ge 256){Fail 'Event overflow';return};$ctx.events.Add([ordered]@{order=$ctx.events.Count+1;elapsedMs=$clock.ElapsedMilliseconds;stage=$Stage})}
function Fail([string]$Reason){if($null -eq $ctx.failure){$ctx.failure=$Reason}}
function Local([string]$Path,[bool]$Directory){
 $part=[IO.Path]::GetFullPath($Path);$leaf=$true
 while($part){$item=Get-Item -LiteralPath $part -Force
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($leaf -and $item.PSIsContainer -ne $Directory) -or (!$leaf -and !$item.PSIsContainer)){throw 'Redirected recipe input.'}
  $parent=[IO.Path]::GetDirectoryName($part);if(!$parent -or $parent -ceq $part){break};$part=$parent;$leaf=$false
 }
}
function Fresh([string]$Name,$Value){
 $path=Join-Path $caseRoot $Name
 $stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$bytes=$utf8.GetBytes(($Value|ConvertTo-Json -Depth 10)+[Environment]::NewLine);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Policy([string]$Path){
 try{$item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop}catch [Management.Automation.ItemNotFoundException]{return [ordered]@{exists=$false}}
 if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){return [ordered]@{exists=$true;reparse=$true;attributes=[string]$item.Attributes}}
 $security=$item.GetAccessControl([Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access)
 return [ordered]@{exists=$true;reparse=$false;directory=$item.PSIsContainer;sddl=$security.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access)}
}
function Snapshot{[ordered]@{parent=(Policy (Join-Path $caseRoot 'parent'));leaf=(Policy $target);junctionTarget=(Policy (Join-Path $caseRoot 'target'))}}
function Sink($Stream,[int]$Cap){
 $sink=[pscustomobject]@{stream=$Stream;buffer=[byte[]]::new(1024);task=$null;created=0;completed=0;done=$false;bytes=0;cap=$Cap;overflow=$false;error=$null;collected=[IO.MemoryStream]::new()}
 $sink.task=$sink.stream.ReadAsync($sink.buffer,0,$sink.buffer.Length);$sink.created++;return $sink
}
function Drain($Sink){
 if($null -eq $Sink -or $Sink.done -or $null -eq $Sink.task -or !$Sink.task.IsCompleted){return}
 $observed=$false
 try{
  $count=$Sink.task.GetAwaiter().GetResult();$Sink.completed++;$observed=$true
  if($count -eq 0){$Sink.done=$true;return}
  $room=[Math]::Max(0,$Sink.cap-[int]$Sink.collected.Length)
  if($room){$Sink.collected.Write($Sink.buffer,0,[Math]::Min($room,$count))}
  $Sink.bytes=[Math]::Min($Sink.cap+1,$Sink.bytes+$count)
  if($Sink.bytes -gt $Sink.cap){$Sink.overflow=$true;Fail 'Child output overflow'}
  $Sink.task=$Sink.stream.ReadAsync($Sink.buffer,0,$Sink.buffer.Length);$Sink.created++
 }catch{if(!$observed){$Sink.completed++};$Sink.error=$_.Exception.GetType().FullName;$Sink.done=$true;Fail 'Child stream failed'}
}
function Quote-Argument([string]$Value){
 $escaped=[Text.RegularExpressions.Regex]::Replace($Value,'(\\*)"',{param($match) ('\' * ($match.Groups[1].Value.Length*2+1))+'"'})
 $escaped=[Text.RegularExpressions.Regex]::Replace($escaped,'\\+$',{param($match) '\' * ($match.Value.Length*2)})
 return '"'+$escaped+'"'
}
function Stop-Owned{
 if(!$ctx.started -or $ctx.exitObserved -or $ctx.killRequested){return}
 $ctx.killRequested=$true;Note 'owned-child-kill-request'
 try{$ctx.process.Kill()}catch{Fail 'Owned child kill failed'}
}
function Close-Input([bool]$Eof){
 if($ctx.inputCloseAttempted){return}
 if(!$Eof -and !$ctx.exitObserved){Fail 'Post-exit stdin cleanup attempted before actual exit';return}
 $ctx.inputCloseAttempted=$true;$ctx.inputCloseKind=if($Eof){'eof'}else{'after-exit'}
 if($Eof){$ctx.eofAttempted=$true;Note 'explicit-input-eof-enter'}else{Note 'post-exit-stdin-close-enter'}
 try{
  # One owner closes the writer once. No text was written and both encoding
  # preambles were verified empty. Do not close BaseStream separately.
  $ctx.process.StandardInput.Close();$ctx.inputCloseReturned=$true
  if($Eof){$ctx.eofReturned=$true;$ctx.inputClosedBeforeKill=!$ctx.killRequested;Note 'explicit-input-eof-return'}else{Note 'post-exit-stdin-close-return'}
 }catch{Fail 'Single-owner stdin close failed'}
}
function Observe{
 Drain $ctx.stdout;Drain $ctx.stderr
 if($ctx.started -and !$ctx.exitObserved){
  try{if($ctx.process.WaitForExit(10)){$ctx.exitObserved=$true;$ctx.exitCode=$ctx.process.ExitCode;Note 'actual-child-exit'}}catch{Fail 'Actual child exit observation failed'}
 }
}
function Streams-Done{return $null -ne $ctx.stdout -and $null -ne $ctx.stderr -and $ctx.stdout.done -and $ctx.stderr.done -and $ctx.stdout.completed -eq $ctx.stdout.created -and $ctx.stderr.completed -eq $ctx.stderr.created}
function Receipt([bool]$Passed,$Before,$After){
 [ordered]@{schema=1;case=$Case;passed=$Passed;failure=$ctx.failure;scriptDataSha256=$env:TAHTIAPURI_DIRECTORY_SCRIPT_DATA_SHA256;startAttempted=$ctx.startAttempted;startReturned=$ctx.started;startReturnedAtMs=$ctx.startReturnedAt;originalBudgetMs=20000;inputBytesWritten=$ctx.inputBytesWritten;requestedInputBytes=$ctx.requestedInputBytes;writeAttempted=$ctx.writeAttempted;writeReturned=$ctx.writeReturned;flushAttempted=$ctx.flushAttempted;flushReturned=$ctx.flushReturned;eofAttempted=$ctx.eofAttempted;eofReturned=$ctx.eofReturned;inputCloseAttempted=$ctx.inputCloseAttempted;inputCloseReturned=$ctx.inputCloseReturned;inputCloseKind=$ctx.inputCloseKind;stdinEncodingBefore=$ctx.stdinEncodingBefore;stdinEncodingAfter=$ctx.stdinEncodingAfter;authorityMayBeCommitted=($ctx.writeAttempted -and $null -ne $ctx.requestedInputBytes -and $ctx.requestedInputBytes -ge 8);grantWrittenAtMs=$ctx.grantWrittenAt;inputClosedBeforeKill=$ctx.inputClosedBeforeKill;noEofSampleAbsent=$ctx.sampleAbsent;plannedHoldKill=$ctx.plannedHoldKill;killRequested=$ctx.killRequested;actualExitObserved=$ctx.exitObserved;exitCode=$ctx.exitCode;naturalExit=($ctx.exitObserved -and !$ctx.killRequested);streamsDone=(Streams-Done);stdout=if($ctx.stdout){[ordered]@{bytes=$ctx.stdout.bytes;overflow=$ctx.stdout.overflow;created=$ctx.stdout.created;completed=$ctx.stdout.completed;error=$ctx.stdout.error;hex=[BitConverter]::ToString($ctx.stdout.collected.ToArray()).Replace('-','').ToLowerInvariant()}}else{$null};stderr=if($ctx.stderr){[ordered]@{bytes=$ctx.stderr.bytes;overflow=$ctx.stderr.overflow;created=$ctx.stderr.created;completed=$ctx.stderr.completed;error=$ctx.stderr.error;text=$utf8.GetString($ctx.stderr.collected.ToArray())}}else{$null};before=$Before;after=$After;events=@($ctx.events.ToArray());scope='Actual fixed PowerShell script and ONE owned child only; no Worker/Host or descendant inventory';noEofLimit='Absence sample does not prove the script reached its stdin read';upgradesOriginalResult=$false}
}
$before=$null;$after=$null;$passed=$false
try{
 Local $root $true;Local $caseRoot $true
 $dataPath=Join-Path $root 'script-data.json';Local $dataPath $false
 if($env:TAHTIAPURI_DIRECTORY_SCRIPT_DATA_SHA256 -cnotmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $dataPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $env:TAHTIAPURI_DIRECTORY_SCRIPT_DATA_SHA256){throw 'Approved script input changed.'}
 $data=[IO.File]::ReadAllText($dataPath,$utf8)|ConvertFrom-Json
 if((@($data.PSObject.Properties.Name|Sort-Object) -join ',') -cne 'grantHex,schema,script' -or $data.schema -ne 1 -or $data.grantHex -cne '5448444952303031' -or $data.script.Length -lt 1 -or $data.script.Length -gt 16384){throw 'Closed script input differs.'}
 $before=Snapshot;Note 'fixture-before'
 $grant=[Text.Encoding]::ASCII.GetBytes('THDIR001');$bytes=$grant
 if($Case -like 'eof-*'){$count=[int]$Case.Substring(4);$bytes=[byte[]]::new($count);[Array]::Copy($grant,$bytes,$count)}
 elseif($Case -ceq 'wrong'){$bytes=[Text.Encoding]::ASCII.GetBytes('THREC001')}
 elseif($Case -ceq 'trailing'){$bytes=[byte[]]::new(9);[Array]::Copy($grant,$bytes,8);$bytes[8]=0}
 $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)) 'System32/WindowsPowerShell/v1.0/powershell.exe'
 $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.WorkingDirectory=$caseRoot
 $info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
 # Fixed production arguments. -Command is fixed data approved above, not user input.
 $info.Arguments='-NoLogo -NoProfile -NonInteractive -Command '+(Quote-Argument $data.script)
 $info.EnvironmentVariables.Clear()
 foreach($key in @('SystemRoot','WINDIR','TEMP','TMP')){if([Environment]::GetEnvironmentVariable($key)){$info.EnvironmentVariables[$key]=[Environment]::GetEnvironmentVariable($key)}}
 $info.EnvironmentVariables['TAHTIAPURI_PRIVATE_DIR']=$target
 # Framework Process.Start constructs an AutoFlush StreamWriter itself. Its
 # preamble must be empty before Start, not merely before our BaseStream.Write.
 # Read only: no console encoding/codepage settings are changed.
 $encoding=[Console]::InputEncoding
 $ctx.stdinEncodingBefore=[ordered]@{codePage=$encoding.CodePage;webName=$encoding.WebName;preambleHex=[BitConverter]::ToString($encoding.GetPreamble())}
 if($encoding.GetPreamble().Length -ne 0){throw 'Current stdin encoding would add a preamble; no child started.'}
 $ctx.process=[Diagnostics.Process]::new();$ctx.process.StartInfo=$info;Note 'child-start-enter'
 if($clock.ElapsedMilliseconds -ge 20000){throw 'Original deadline expired before Start.'}
 $ctx.startAttempted=$true;$ctx.started=$ctx.process.Start();$ctx.startReturnedAt=$clock.ElapsedMilliseconds;Note 'child-start-return'
 if(!$ctx.started){throw 'Child start returned false.'}
 $ctx.stdout=Sink $ctx.process.StandardOutput.BaseStream 128;$ctx.stderr=Sink $ctx.process.StandardError.BaseStream 32768
 if($clock.ElapsedMilliseconds -ge 20000){Fail 'Original deadline expired on Start return';Stop-Owned}
 $encoding=$ctx.process.StandardInput.Encoding
 $ctx.stdinEncodingAfter=[ordered]@{codePage=$encoding.CodePage;webName=$encoding.WebName;preambleHex=[BitConverter]::ToString($encoding.GetPreamble())}
 if($encoding.GetPreamble().Length -ne 0){Fail 'Returned stdin writer may already contain a preamble';Stop-Owned}
 if(!$ctx.failure){
  if($clock.ElapsedMilliseconds -ge 20000){Fail 'Original deadline expired before input';Stop-Owned}
  else{
   $ctx.requestedInputBytes=$bytes.Length;$ctx.writeAttempted=$true
   $ctx.process.StandardInput.BaseStream.Write($bytes,0,$bytes.Length)
   $ctx.writeReturned=$true;$ctx.inputBytesWritten=$bytes.Length;$ctx.grantWrittenAt=$clock.ElapsedMilliseconds;Note 'raw-input-write-return'
   if($clock.ElapsedMilliseconds -ge 20000){Fail 'Original deadline expired after Write';Stop-Owned}
   if(!$ctx.failure){
    $ctx.flushAttempted=$true;$ctx.process.StandardInput.BaseStream.Flush();$ctx.flushReturned=$true;Note 'raw-input-flush-return'
    if($clock.ElapsedMilliseconds -ge 20000){Fail 'Original deadline expired after Flush';Stop-Owned}
   }
   if(!$ctx.failure -and $Case -cne 'hold'){
    if($clock.ElapsedMilliseconds -ge 20000){Fail 'Original deadline expired before EOF';Stop-Owned}
    else{Close-Input $true;if($clock.ElapsedMilliseconds -ge 20000){Fail 'Original deadline expired after EOF';Stop-Owned}}
   }
  }
 }
 while(!$ctx.exitObserved -or !(Streams-Done)){
  Observe
  if($Case -ceq 'hold' -and !$ctx.killRequested -and $null -ne $ctx.grantWrittenAt -and $clock.ElapsedMilliseconds-$ctx.grantWrittenAt -ge 750){
   if($ctx.exitObserved){Fail 'No-EOF child exited before planned stop'}
   $ctx.sampleAbsent=!(Test-Path -LiteralPath $target);Note 'no-eof-absence-sample'
   if(!$ctx.sampleAbsent){Fail 'No-EOF mutated the target'}
   $ctx.plannedHoldKill=$true;Stop-Owned
  }
  if($clock.ElapsedMilliseconds -ge 20000){Fail 'Original child deadline exceeded';Stop-Owned}
  if($ctx.failure){Stop-Owned}
  if($clock.ElapsedMilliseconds -ge 25000 -and (!$ctx.exitObserved -or !(Streams-Done))){Fail 'Original cleanup observation cap exceeded';break}
 }
 if(!$ctx.exitObserved -or !(Streams-Done)){throw 'Original child or stream ownership remains uncertain.'}
 # No-EOF stdin is disposed only AFTER the owned child really exited.
 Close-Input $false;$after=Snapshot;Note 'fixture-after'
 $out=$utf8.GetString($ctx.stdout.collected.ToArray());$err=$utf8.GetString($ctx.stderr.collected.ToArray())
 if($Case -in @('valid-new','valid-existing')){
  if($ctx.exitCode -ne 0 -or $out -cne "directory-ready`n" -or $ctx.stderr.bytes -ne 0 -or $ctx.killRequested){throw 'Exact success receipt or natural close differs.'}
  if(!$after.leaf.exists -or $after.leaf.reparse -or !$after.leaf.directory){throw 'Valid directory result missing.'}
 }elseif($Case -ceq 'hold'){
  if(!$ctx.plannedHoldKill -or !$ctx.killRequested -or $ctx.exitCode -eq 0 -or $ctx.inputBytesWritten -ne 8 -or $ctx.inputClosedBeforeKill -or !$ctx.sampleAbsent -or $out.Length -ne 0){throw 'No-EOF controlled stop differs.'}
 }else{
  if($ctx.exitCode -ne 1 -or $out.Length -ne 0 -or $ctx.killRequested){throw 'Expected rejection or natural close differs.'}
  $needle=if($Case -like 'eof-*'){'Missing directory grant'}elseif($Case -ceq 'wrong'){'Invalid directory grant'}elseif($Case -ceq 'trailing'){'Trailing directory grant input'}elseif($Case -in @('leaf-acl','parent-acl')){'Invalid access rule'}elseif($Case -ceq 'missing-parent'){'Missing immediate directory parent'}else{'Invalid directory chain'}
  if(!$err.Contains($needle)){throw 'The expected fixed-script rejection reason is missing.'}
 }
 if(($before.parent|ConvertTo-Json -Depth 4 -Compress) -cne ($after.parent|ConvertTo-Json -Depth 4 -Compress)){throw 'Parent policy changed.'}
 if(($before.junctionTarget|ConvertTo-Json -Depth 4 -Compress) -cne ($after.junctionTarget|ConvertTo-Json -Depth 4 -Compress)){throw 'Junction target policy changed.'}
 if($Case -ceq 'valid-new' -and $after.leaf.sddl -cne $before.parent.sddl){throw 'Created leaf policy differs from exact private parent policy.'}
 if($Case -ne 'valid-new' -and (($before|ConvertTo-Json -Depth 6 -Compress) -cne ($after|ConvertTo-Json -Depth 6 -Compress))){throw 'Rejected/existing fixture policy changed.'}
 if($ctx.failure){throw 'An earlier original failure remains.'};$passed=$true
}catch{Fail $_.Exception.Message;Stop-Owned}
finally{
 # Retain this helper and all original handles after a failed observation. The
 # outer reviewed owner may stop the whole tree; never abandon an owned child.
 if($ctx.started){
  while((!$ctx.exitObserved -or !(Streams-Done)) -and $clock.ElapsedMilliseconds -lt 25000){Observe;Stop-Owned}
 }
 if($ctx.exitObserved){Close-Input $false}
 if(!$ctx.exitObserved -or !(Streams-Done) -or $ctx.failure){$passed=$false}
 Fresh 'case-result.json' (Receipt $passed $before $after);$ctx.sealed=$true
 if($ctx.startAttempted -and (!$ctx.exitObserved -or !(Streams-Done))){
  while(!$ctx.exitObserved -or !(Streams-Done)){Observe;[Threading.Thread]::Sleep(25)}
  Close-Input $false
  Fresh 'case-late-observation.json' (Receipt $false $before $after)
 }
 if($ctx.exitObserved -and (Streams-Done)){$ctx.stdout.collected.Dispose();$ctx.stderr.collected.Dispose();$ctx.process.Dispose()}
}
if(!$passed){exit 1}
