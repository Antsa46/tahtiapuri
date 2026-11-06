# Compile-only MCP package. Does not install, select or launch a runtime.
param(
 [Parameter(Mandatory=$true)][ValidatePattern('^build-[a-f0-9]{32}$')][string]$WorkerBuild,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$WorkerDigest
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$utf8=[Text.UTF8Encoding]::new($false,$true)
$self=[Diagnostics.Process]::GetCurrentProcess()
$self.PriorityClass=[Diagnostics.ProcessPriorityClass]::BelowNormal
$self.ProcessorAffinity=[IntPtr]1
function Assert-Limits {
 $self.Refresh()
 if($self.PriorityClass -ne [Diagnostics.ProcessPriorityClass]::BelowNormal -or $self.ProcessorAffinity.ToInt64() -ne 1){throw 'Native recovery runner parent limits differ.'}
}
Assert-Limits
$projectRoot=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
function Assert-LocalPath([string]$Path,[bool]$Directory,[bool]$AllowMissing=$false){
 $full=[IO.Path]::GetFullPath($Path)
 if($full.StartsWith('\\') -or $full -match '[%"\r\n!^&|<>]'){throw 'Unsupported private recovery test path.'}
 $current=$full;$leaf=$true
 while($current){
  if(Test-Path -LiteralPath $current){
   $item=Get-Item -LiteralPath $current -Force
   if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($leaf -and $item.PSIsContainer -ne $Directory) -or (!$leaf -and !$item.PSIsContainer)){throw 'Redirected recovery test path or wrong type.'}
   if([IO.Path]::GetFullPath($item.FullName) -cne $current){throw 'Noncanonical recovery test path.'}
  }elseif(!$AllowMissing -or !$leaf){throw 'Required private recovery test path is missing.'}
  $parent=[IO.Path]::GetDirectoryName($current)
  if(!$parent -or $parent -eq $current){break};$current=$parent;$leaf=$false
 }
}
function Hash([string]$Path){Assert-LocalPath $Path $false;return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Assert-Keys($Value,[string[]]$Expected){
 $actual=@($Value.PSObject.Properties.Name|Sort-Object -CaseSensitive)
 if(($actual -join "`n") -cne ((@($Expected|Sort-Object -CaseSensitive)) -join "`n")){throw 'Closed reference metadata shape changed.'}
}
Assert-LocalPath $projectRoot $true
$sourcePaths=@(
 'scripts/native/build-mcp-native.ps1',
 'scripts/native/prepare-mcp-native.mjs',
 'scripts/native/mcp-runtime-package.mjs',
 'apps/mcp/native/bootstrap-file.h',
 'apps/mcp/native/bootstrap-publication.h',
 'apps/mcp/native/broker-io.h',
 'apps/mcp/native/broker-journal.h',
 'apps/mcp/native/broker-relay.h',
 'apps/mcp/native/broker-resources.h',
 'apps/mcp/native/broker-wire.h',
 'apps/mcp/native/broker-worker.h',
 'apps/mcp/native/main-bootstrap.cpp',
 'apps/mcp/native/main-bootstrap.h',
 'apps/mcp/native/main-identity.cpp',
 'apps/mcp/native/main-peer.h',
 'apps/mcp/native/mcp-broker.cpp',
 'packages/windows-runtime/native/common.h',
 'packages/windows-runtime/native/owner-security.h',
 'packages/windows-runtime/native/process-witness.h',
 'packages/windows-runtime/native/owned-job.h'
)

$sourcePins=[ordered]@{};$toolPins=[ordered]@{};$prepared=$null
foreach($path in $sourcePaths){$sourcePins[$path]=Hash (Join-Path $projectRoot $path)}
function Assert-Sources {
 $expectedNative=@($sourcePaths|Where-Object { $_.StartsWith('apps/mcp/native/',[StringComparison]::Ordinal) }|Sort-Object -CaseSensitive)
 $actualNative=@(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'apps/mcp/native') -File -Force|Where-Object { $_.Extension -cin @('.h','.cpp') }|ForEach-Object {'apps/mcp/native/'+$_.Name}|Sort-Object -CaseSensitive)
 if(($expectedNative -join [char]10) -cne ($actualNative -join [char]10)){throw 'Native MCP source path set differs.'}
 $known=@($sourcePaths|ForEach-Object {[IO.Path]::GetFullPath((Join-Path $projectRoot $_))})
 foreach($path in @($sourcePaths|Where-Object { $_ -match '\.(cpp|h)$' })){
  $full=Join-Path $projectRoot $path
  foreach($line in [IO.File]::ReadAllLines($full,$utf8)){
   if($line -match '^\s*#\s*include\s+(.+)$'){
    $value=$Matches[1].Trim()
    if($value.StartsWith('<')){continue}
    if($value -cnotmatch '^"([^"]+)"$'){throw 'Unsupported native project include syntax.'}
    $include=$Matches[1]
    if($include -ceq 'mcp-runtime-pins.h'){continue}
    $target=[IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetDirectoryName($full)) $include))
    if($known -cnotcontains $target){throw 'Native include is outside the pinned source closure.'}
   }
  }
 }
 foreach($pin in $sourcePins.GetEnumerator()){if((Hash (Join-Path $projectRoot $pin.Key)) -cne $pin.Value){throw ('Native MCP source changed: '+$pin.Key)}}
 foreach($pin in $toolPins.GetEnumerator()){if((Hash $pin.Key) -cne $pin.Value){throw 'Native MCP build tool changed.'}}
 foreach($area in @('apps/mcp/native','packages/windows-runtime/native')){
  foreach($path in [IO.Directory]::EnumerateFileSystemEntries((Join-Path $projectRoot $area))){
   if([IO.Path]::GetFileName($path) -ieq 'mcp-runtime-pins.h'){throw 'Project header would shadow the generated worker pins.'}
  }
 }
 if($null -ne $prepared){
  foreach($pin in $prepared.files){$path=Join-Path $output ('package/'+$pin.path);if((Hash $path) -cne $pin.sha256 -or (Get-Item -LiteralPath $path).Length -ne $pin.bytes){throw 'Prepared worker bytes changed.'}}
  if((Hash (Join-Path $output 'mcp-runtime-pins.h')) -cne $prepared.headerSha256){throw 'Generated worker pins changed.'}
 }
}
function Assert-PackageShape {
 if($null -eq $prepared){throw 'Worker preparation missing.'}
 $files=[Collections.Generic.List[string]]::new();$nodes=0
 $package=Join-Path $output 'package';Assert-LocalPath $package $true
 foreach($entry in [IO.Directory]::EnumerateFileSystemEntries($package)){
  if(++$nodes -gt 9){throw 'Worker tree node bound.'}
  $name=[IO.Path]::GetFileName($entry)
  if($name -ceq 'licenses'){
   Assert-LocalPath $entry $true
   foreach($license in [IO.Directory]::EnumerateFileSystemEntries($entry)){
    if(++$nodes -gt 9){throw 'Worker tree node bound.'}
    Assert-LocalPath $license $false;$files.Add('licenses/'+[IO.Path]::GetFileName($license))
   }
  }else{Assert-LocalPath $entry $false;$files.Add($name)}
 }
 if((@($files|Sort-Object -CaseSensitive) -join [char]10) -cne (@($prepared.files.path|Sort-Object -CaseSensitive) -join [char]10)){throw 'Worker tree boundary differs.'}
}
function Assert-BinarySnapshot {
 foreach($entry in $binaryPins.GetEnumerator()){
  $path=Join-Path $output $entry.Key
  if($entry.Value.bytes -lt 1 -or $entry.Value.bytes -gt 4MB -or (Get-Item -LiteralPath $path).Length -ne $entry.Value.bytes -or (Hash $path) -cne $entry.Value.sha256){throw 'Compiled MCP binary changed.'}
 }
 foreach($directory in @('bin','helpers')){
  $expected=@($binaryPins.Keys|Where-Object {$_.StartsWith($directory+'/',[StringComparison]::Ordinal)}|ForEach-Object {[IO.Path]::GetFileName($_)}|Sort-Object -CaseSensitive)
  $actual=@(Get-ChildItem -LiteralPath (Join-Path $output $directory) -Force|Select-Object -ExpandProperty Name|Sort-Object -CaseSensitive)
  if(($actual -join [char]10) -cne ($expected -join [char]10)){throw 'Compiled binary directory is not closed.'}
 }
}
Assert-Sources
$parent=$projectRoot
foreach($component in @('.artifacts','native','mcp-native','builds')){
 $parent=Join-Path $parent $component
 if(!(Test-Path -LiteralPath $parent)){Assert-LocalPath $parent $true $true;[IO.Directory]::CreateDirectory($parent)|Out-Null}
 Assert-LocalPath $parent $true
}
$output=Join-Path $projectRoot ('.artifacts/native/mcp-native/builds/build-'+[Guid]::NewGuid().ToString('N'))
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User
$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
if($owner.Value -ceq $system.Value){throw 'Runner requires the ordinary owning user.'}
function Assert-OutputPolicy {
 Assert-LocalPath $output $true
 $actual=[IO.Directory]::GetAccessControl($output,[Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access)
 if(!$actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $owner.Value){throw 'Private recovery output protection differs.'}
 $rules=@($actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));if($rules.Count -ne 2){throw 'Private recovery output rule count differs.'}
 $inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
 $seen=@{}
 foreach($rule in $rules){$sid=$rule.IdentityReference.Value
  if(($sid -cne $owner.Value -and $sid -cne $system.Value) -or $seen.ContainsKey($sid) -or $rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $rule.InheritanceFlags -ne $inherit -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None){throw 'Private recovery output DACL differs.'}
  $seen[$sid]=$true
 }
}
Assert-LocalPath $output $true $true
if(Test-Path -LiteralPath $output){throw 'Recovery output must be fresh.'}
$security=[Security.AccessControl.DirectorySecurity]::new();$security.SetOwner($owner);$security.SetAccessRuleProtection($true,$false)
$inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
foreach($sid in @($owner,$system)){$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))}
[IO.Directory]::CreateDirectory($output,$security)|Out-Null
Assert-OutputPolicy
foreach($entry in [IO.Directory]::EnumerateFileSystemEntries($output)){throw 'Fresh recovery output is not empty.'}
function Fresh-Text([string]$Path,[string]$Text){
 Assert-OutputPolicy
 if([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path)) -cne $output){throw 'Output escaped the fresh recovery directory.'}
 Assert-LocalPath $Path $false $true
 $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$bytes=$utf8.GetBytes($Text);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Invoke-Owned([string]$Executable,[string]$Arguments,[string]$Step,[int]$BudgetSeconds){
 Assert-Limits;Assert-OutputPolicy;Assert-Sources
 $child=$null;$failure=$null;$timedOut=$false;$exitCode=$null;$actualExit=$false;$killExit=$null;$cleanupErrors=[Collections.Generic.List[string]]::new()
 $clock=[Diagnostics.Stopwatch]::StartNew()
 try{
  $start=@{FilePath=$Executable;WorkingDirectory=$output;RedirectStandardOutput=(Join-Path $output ($Step+'.stdout.txt'));RedirectStandardError=(Join-Path $output ($Step+'.stderr.txt'));NoNewWindow=$true;PassThru=$true}
  if($Arguments.Length -gt 0){$start.ArgumentList=$Arguments}
  $child=Start-Process @start
  $null=$child.Handle
  $remaining=[Math]::Max(0,$BudgetSeconds*1000-[int]$clock.ElapsedMilliseconds)
  if(!$child.WaitForExit($remaining) -or $clock.ElapsedMilliseconds -gt $BudgetSeconds*1000){$timedOut=$true;throw 'Owned native build step deadline exceeded.'}
  $child.Refresh();$actualExit=$child.HasExited;$exitCode=$child.ExitCode
  if(!$actualExit -or $null -eq $exitCode -or $exitCode -ne 0){throw 'Owned native build step did not exit successfully.'}
 }catch{$failure=$_.Exception.Message}
 finally{
  $clock.Stop()
  try{
   if($null -ne $child){
    $needsTermination=$false
    try{$child.Refresh();$needsTermination=!$child.HasExited}catch{$cleanupErrors.Add('initial-observation: '+$_.Exception.Message)}
    if($needsTermination){
     # A limits-readback error must not skip cleanup of an owned live process.
     try{Assert-Limits}catch{$cleanupErrors.Add('limits-readback: '+$_.Exception.Message)}
     $killer=$null
     try{
      $killer=Start-Process -FilePath $taskkill -ArgumentList ('/PID '+$child.Id+' /T /F') -WorkingDirectory $output -RedirectStandardOutput (Join-Path $output ($Step+'.kill.stdout.txt')) -RedirectStandardError (Join-Path $output ($Step+'.kill.stderr.txt')) -NoNewWindow -PassThru
      $null=$killer.Handle
      if(!$killer.WaitForExit(3000)){
       try{$killer.Kill()}catch{$cleanupErrors.Add('taskkill-stop: '+$_.Exception.Message)}
       $null=$killer.WaitForExit(1000)
      }
      $killer.Refresh();if($killer.HasExited){$killer.WaitForExit();$killExit=$killer.ExitCode}
     }catch{$cleanupErrors.Add('taskkill: '+$_.Exception.Message)}
     finally{
      if($null -ne $killer){
       try{if(!$killer.HasExited){$killer.Kill();$null=$killer.WaitForExit(1000)}}catch{$cleanupErrors.Add('taskkill-final-stop: '+$_.Exception.Message)}
       try{$killer.Dispose()}catch{$cleanupErrors.Add('taskkill-dispose: '+$_.Exception.Message)}
      }
     }
    }
   }
  }finally{
   # Always attempt terminal observation and write a receipt, even when a
   # cleanup API throws. Unknown descendants are never reported as verified.
   if($null -ne $child){
    try{
     $actualExit=$child.WaitForExit(3000);$child.Refresh()
     if($actualExit -and $child.HasExited){$child.WaitForExit();$exitCode=$child.ExitCode}else{$actualExit=$false}
    }catch{$actualExit=$false;$cleanupErrors.Add('final-observation: '+$_.Exception.Message)}
    try{$child.Dispose()}catch{$cleanupErrors.Add('child-dispose: '+$_.Exception.Message)}
   }
   Fresh-Text (Join-Path $output ($Step+'.exit.json')) (([ordered]@{actualExitVerified=$actualExit;exitCode=$exitCode;timedOut=$timedOut;elapsedMs=$clock.ElapsedMilliseconds;budgetSeconds=$BudgetSeconds;failure=$failure;cleanupErrors=@($cleanupErrors.ToArray());parentAffinity=1;parentPriority='BelowNormal';limitEvidence='Parent readback immediately before spawn; children inherit, not independently queried';ownedTreeKillExitCode=$killExit;descendantsVerified=$false}|ConvertTo-Json)+[Environment]::NewLine)
  }
 }
 if($failure -or !$actualExit -or $timedOut -or $exitCode -ne 0 -or $cleanupErrors.Count -ne 0){throw ('Native build '+$Step+' failed; evidence retained.')}
 Assert-Sources
}

$node=Join-Path $projectRoot '.local/toolchain/node-v24.22.2-win-x64/node.exe'
if((Hash $node) -cne '1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9'){throw 'Pinned Node differs.'}
$toolPins[$node]=Hash $node
$trustedWindows=[Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
$programFilesX86=[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
$system32=Join-Path $trustedWindows 'System32'
$taskkill=Join-Path $system32 'taskkill.exe';$cmd=Join-Path $system32 'cmd.exe'
$vswhere=Join-Path $programFilesX86 'Microsoft Visual Studio/Installer/vswhere.exe'
Assert-LocalPath $vswhere $false;$toolPins[$vswhere]=Hash $vswhere
if((Get-AuthenticodeSignature -LiteralPath $vswhere).Status -ne 'Valid'){throw 'Visual Studio locator signature unavailable.'}
foreach($dir in @('bin','helpers','objects')){Assert-OutputPolicy;[IO.Directory]::CreateDirectory((Join-Path $output $dir))|Out-Null}
Fresh-Text (Join-Path $output 'owner.marker') ('TAHTIAPURI_MCP_NATIVE_BUILD_V1'+[char]10)
Fresh-Text (Join-Path $output 'source-inputs.json') (($sourcePins|ConvertTo-Json -Depth 4)+[Environment]::NewLine)

$environmentBefore=@{}
foreach($entry in @(Get-ChildItem Env:)){
 if($entry.Name -match '^(CL$|_CL_$|LINK$|_LINK_$|INCLUDE$|LIB$|LIBPATH$|NODE_|ELECTRON_|UV_|OPENSSL_|INSPECTOR|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|PATH$)'){
  $environmentBefore[$entry.Name]=$entry.Value;[Environment]::SetEnvironmentVariable($entry.Name,$null,'Process')
 }
}
$env:PATH=$system32+';'+$trustedWindows
$passed=$false;$failure=$null;$descriptor=$null;$binaryPins=[ordered]@{}
try{
 $prepare=Join-Path $PSScriptRoot 'prepare-mcp-native.mjs'
 Invoke-Owned $node ('--max-old-space-size=256 "'+$prepare+'" --build-root "'+$output+'" --worker-build '+$WorkerBuild+' --worker-digest '+$WorkerDigest) 'prepare' 90
 $prepared=[IO.File]::ReadAllText((Join-Path $output 'prepared-worker.json'),$utf8)|ConvertFrom-Json
 if($prepared.schema -ne 1 -or $prepared.digest -cne $WorkerDigest -or $prepared.workerBuild -cne $WorkerBuild -or @($prepared.files).Count -ne 8){throw 'Prepared package receipt differs.'}
 Assert-Sources
 Invoke-Owned $vswhere '-utf8 -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath' 'vswhere' 30
 $installation=[IO.File]::ReadAllText((Join-Path $output 'vswhere.stdout.txt'),$utf8).Trim()
 $environmentScript=Join-Path $installation 'VC/Auxiliary/Build/vcvars64.bat';$toolPins[$environmentScript]=Hash $environmentScript
 $sdkRoot=Join-Path $programFilesX86 'Windows Kits/10';Assert-LocalPath $sdkRoot $true
 $sdk=Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'Include') -Directory | Where-Object { $_.Name -match '^10\.[0-9]+\.[0-9]+\.[0-9]+$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'um/Windows.h')) } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
 if(!$sdk){throw 'Existing x64 Windows SDK required. Nothing is installed.'}
 $include=Join-Path $sdkRoot ('Include/'+$sdk.Name);$lib=Join-Path $sdkRoot ('Lib/'+$sdk.Name)
 foreach($path in @('um/x64/kernel32.lib','um/x64/userenv.lib','um/x64/advapi32.lib','um/x64/bcrypt.lib','um/x64/ws2_32.lib','um/x64/OneCoreUAP.lib','ucrt/x64/ucrt.lib')){Assert-LocalPath (Join-Path $lib $path) $false}
 $prelude=@('@echo off',('"'+$system32+'\chcp.com" 65001 >nul'),('set "PATH='+$system32+';'+$trustedWindows+'"'),('call "'+$environmentScript+'" >nul'),'if errorlevel 1 exit /b 1')
 $discover=@($prelude)+@(('"'+$system32+'\where.exe" cl.exe > "'+(Join-Path $output 'compiler-path.txt')+'"'),'if errorlevel 1 exit /b 1',('"'+$system32+'\where.exe" link.exe > "'+(Join-Path $output 'linker-path.txt')+'"'),'exit /b %errorlevel%')
 Fresh-Text (Join-Path $output 'discover.cmd') (($discover -join [Environment]::NewLine)+[Environment]::NewLine)
 Invoke-Owned $cmd ('/d /s /c ""'+(Join-Path $output 'discover.cmd')+'""') 'discover' 45
 $compiler=([IO.File]::ReadAllLines((Join-Path $output 'compiler-path.txt'),$utf8)|Select-Object -First 1).Trim()
 $linker=([IO.File]::ReadAllLines((Join-Path $output 'linker-path.txt'),$utf8)|Select-Object -First 1).Trim()
 foreach($tool in @($compiler,$linker)){
  Assert-LocalPath $tool $false;$signature=Get-AuthenticodeSignature -LiteralPath $tool
  if($signature.Status -ne 'Valid' -or !$signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch '(^|, )O=Microsoft Corporation(,|$)'){throw 'MSVC signature unavailable or unexpected publisher.'}
  $toolPins[$tool]=Hash $tool
 }
 $lines=[Collections.Generic.List[string]]::new()
 foreach($line in $prelude){$lines.Add($line)}
 $lines.Add('set "INCLUDE='+$include+'\um;'+$include+'\shared;'+$include+'\ucrt;%INCLUDE%"')
 $lines.Add('set "LIB='+$lib+'\um\x64;'+$lib+'\ucrt\x64;%LIB%"')
 $targets=[ordered]@{'bin/mcp-broker.exe'='apps/mcp/native/mcp-broker.cpp';'helpers/main-bootstrap.exe'='apps/mcp/native/main-bootstrap.cpp';'helpers/main-identity.exe'='apps/mcp/native/main-identity.cpp'}
 foreach($entry in $targets.GetEnumerator()){
  $object=Join-Path $output ('objects/'+[IO.Path]::GetFileNameWithoutExtension($entry.Key)+'.obj')
  $lines.Add('"'+$compiler+'" /nologo /std:c++17 /EHsc /utf-8 /O2 /W4 /WX /MT /guard:cf /DUNICODE /D_UNICODE /I"'+$output+'" "'+(Join-Path $projectRoot $entry.Value)+'" /Fo:"'+$object+'" /Fe:"'+(Join-Path $output $entry.Key)+'" /link /INCREMENTAL:NO /DYNAMICBASE /NXCOMPAT userenv.lib advapi32.lib bcrypt.lib ws2_32.lib OneCoreUAP.lib')
  $lines.Add('if errorlevel 1 exit /b 1')
 }
 $lines.Add('exit /b 0')
 Fresh-Text (Join-Path $output 'build.cmd') (($lines -join [Environment]::NewLine)+[Environment]::NewLine)
 Fresh-Text (Join-Path $output 'launch.cmd') (('@echo off',('%SystemRoot%\System32\chcp.com 65001 >nul'),('call "'+(Join-Path $output 'build.cmd')+'"'),'exit /b %errorlevel%') -join [Environment]::NewLine)
 Invoke-Owned $cmd ('/d /s /c ""'+(Join-Path $output 'launch.cmd')+'""') 'compile' 90
 foreach($path in $targets.Keys){$binaryPins[$path]=[ordered]@{bytes=(Get-Item -LiteralPath (Join-Path $output $path)).Length;sha256=(Hash (Join-Path $output $path))}}
 if((@(Get-ChildItem -LiteralPath (Join-Path $output 'helpers') -Force|Select-Object -ExpandProperty Name|Sort-Object) -join ',') -cne 'main-bootstrap.exe,main-identity.exe'){throw 'Helper directory is not closed.'}
 Fresh-Text (Join-Path $output 'binary-pins.json') (($binaryPins|ConvertTo-Json -Depth 4)+[Environment]::NewLine)
 $binaryPinsDigest=Hash (Join-Path $output 'binary-pins.json')
 Invoke-Owned $node ('--max-old-space-size=256 "'+$prepare+'" --verify-build-root "'+$output+'" --worker-digest '+$WorkerDigest+' --binary-pins-digest '+$binaryPinsDigest) 'verify-final' 90
 $final=[IO.File]::ReadAllText((Join-Path $output 'verify-final.stdout.txt'),$utf8)|ConvertFrom-Json
 if($final.verified -ne $true -or $final.digest -cne $WorkerDigest -or $final.binaryPinsDigest -cne $binaryPinsDigest){throw 'Final native output verification differs.'}
 Assert-Sources;Assert-PackageShape;Assert-BinarySnapshot;Assert-OutputPolicy
 $manifest=[ordered]@{schema=1;id='tahtiapuri-native-mcp-v1';protocols=@('TMCT/1','TMCP/1');scope='Compile-only local package; no runtime, isolation, recovery, or installer acceptance';sdk=$sdk.Name;sourceHashes=$sourcePins;toolHashes=$toolPins;workerDigest=$WorkerDigest;generatedHeaderSha256=$prepared.headerSha256;binaries=$binaryPins;affinity=1;priority='BelowNormal';limitsEvidence='Parent readback before spawn; children inherit, not independently queried'}
 Fresh-Text (Join-Path $output 'build-manifest.json') (($manifest|ConvertTo-Json -Depth 7)+[Environment]::NewLine)
 $descriptor=[ordered]@{schema=1;id='tahtiapuri-native-mcp-v1';protocols=@('TMCT/1','TMCP/1');broker=$binaryPins['bin/mcp-broker.exe'];helpers=[ordered]@{'main-bootstrap.exe'=$binaryPins['helpers/main-bootstrap.exe'];'main-identity.exe'=$binaryPins['helpers/main-identity.exe']};package=[ordered]@{path='package';manifest='runtime-manifest.json';digest=$WorkerDigest};buildManifestSha256=(Hash (Join-Path $output 'build-manifest.json'))}
 # Only trusted composition may pin this descriptor. Its location is not trust.
 Fresh-Text (Join-Path $output 'runtime-descriptor.pending.json') (($descriptor|ConvertTo-Json -Depth 7)+[Environment]::NewLine)
 Assert-Sources;Assert-PackageShape;Assert-BinarySnapshot;Assert-OutputPolicy
 # No failed build is selected by path or a latest pointer. An uncertain rename
 # preserves evidence, emits no trusted descriptor digest and fails the recipe.
 [IO.File]::Move((Join-Path $output 'runtime-descriptor.pending.json'),(Join-Path $output 'runtime-descriptor.json'))
 $passed=$true
}catch{$failure=$_.Exception.Message}
finally{
 foreach($name in $environmentBefore.Keys){[Environment]::SetEnvironmentVariable($name,$environmentBefore[$name],'Process')}
 Fresh-Text (Join-Path $output 'result.json') (([ordered]@{passed=$passed;failure=$failure;brokerExecuted=$false;helpersExecuted=$false;inspectorBuilt=$false;modelExecuted=$false;lpacProfileCreated=$false;descriptorSha256=if($passed){Hash (Join-Path $output 'runtime-descriptor.json')}else{$null}}|ConvertTo-Json -Depth 4)+[Environment]::NewLine)
}
[Console]::WriteLine((@{passed=$passed;buildRoot=$output;descriptorSha256=if($passed){Hash (Join-Path $output 'runtime-descriptor.json')}else{$null}}|ConvertTo-Json -Compress))
if(!$passed){throw 'Native MCP build failed; private evidence preserved.'}
