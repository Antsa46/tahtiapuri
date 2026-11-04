$ErrorActionPreference = 'Stop'
$self = [Diagnostics.Process]::GetCurrentProcess()
$self.PriorityClass = [Diagnostics.ProcessPriorityClass]::BelowNormal
$self.ProcessorAffinity = [IntPtr]1
$self.Refresh()
if ($self.PriorityClass -ne [Diagnostics.ProcessPriorityClass]::BelowNormal -or $self.ProcessorAffinity.ToInt64() -ne 1) { throw 'Compiler limits did not apply.' }
if ((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory * 1KB -lt 6GB) { throw 'Insufficient free memory for serial CPU build.' }
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
function Assert-OwnedPath($Path,[bool]$Directory) {
  $full = [IO.Path]::GetFullPath($Path)
  if ($full -ne $projectRoot -and !$full.StartsWith($projectRoot + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Build path escaped project.' }
  $here = $full; $leaf = $true
  while ($here.Length -ge $projectRoot.Length) {
    if (Test-Path -LiteralPath $here) {
      $item = Get-Item -LiteralPath $here -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($leaf -and $item.PSIsContainer -ne $Directory) -or (!$leaf -and !$item.PSIsContainer)) { throw 'Build path is redirected or has unexpected type.' }
    }
    if ($here -eq $projectRoot) { return }; $leaf = $false; $here = Split-Path -Parent $here
  }
  throw 'Build root was not reached.'
}
function Write-Owned($Path,[byte[]]$Bytes) {
  Assert-OwnedPath $Path $false
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $temporary = Join-Path $parent ('.stage-' + [Guid]::NewGuid().ToString('N'))
  $stream = [IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $stream.Write($Bytes,0,$Bytes.Length) } finally { $stream.Dispose() }
  Assert-OwnedPath $Path $false
  # Replace the directory entry rather than modifying an existing hardlink's contents.
  if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary,$Path,[System.Management.Automation.Language.NullString]::Value) } else { [IO.File]::Move($temporary,$Path) }
}
$inputHashes = @{}
foreach ($path in @($PSCommandPath,(Join-Path $PSScriptRoot 'prepare-native-runtime.ps1'),(Join-Path $projectRoot 'resources/runtimes/llama-cpp-source-cpu.json'))) {
  Assert-OwnedPath $path $false
  $inputHashes[$path] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
& (Join-Path $PSScriptRoot 'prepare-native-runtime.ps1') -CheckOnly
$profilePath = Join-Path $projectRoot 'resources/runtimes/llama-cpp-source-cpu.json'
$profile = Get-Content -LiteralPath $profilePath -Raw -Encoding UTF8 | ConvertFrom-Json
$outputBase = Join-Path $projectRoot '.artifacts/tests/isolation/native-source-runtime'
$outputRoot = Join-Path $outputBase ('runs/' + [Guid]::NewGuid().ToString('N'))
Assert-OwnedPath $outputRoot $true
if (Test-Path -LiteralPath $outputRoot) { throw 'Build directory must be fresh.' }
New-Item -ItemType Directory -Force -Path (Join-Path $outputRoot 'bin') | Out-Null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (!(Test-Path -LiteralPath $vswhere)) { throw 'Existing Visual Studio C++ Build Tools are required. Nothing was installed.' }
$discovery = Join-Path $outputRoot 'vswhere.txt'
$p = Start-Process -FilePath $vswhere -ArgumentList '-latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath' -RedirectStandardOutput $discovery -NoNewWindow -PassThru -Wait
if ($p.ExitCode -ne 0) { throw 'Compiler discovery failed.' }
$installation = (Get-Content -LiteralPath $discovery -Raw).Trim()
$environmentScript = Join-Path $installation 'VC/Auxiliary/Build/vcvars64.bat'
if (!(Test-Path -LiteralPath $environmentScript)) { throw 'Existing x64 compiler environment was not found.' }
foreach ($path in @($environmentScript, $projectRoot, $outputRoot)) {
  if ($path -match '[%"\r\n!^&|<>]') { throw 'Unsupported character in build path.' }
}
$toolset = (Get-Content -LiteralPath (Join-Path $installation 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt') -Raw).Trim()
if ($toolset -notmatch '^14\.[0-9]+\.[0-9]+$') { throw 'Unexpected installed toolset version.' }
$msbuild = Join-Path $installation 'MSBuild/Current/Bin/amd64/MSBuild.exe'
if (!(Test-Path -LiteralPath $msbuild)) { throw 'Existing x64 MSBuild is required.' }
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
$sdkVersion = Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'Include') -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'um/Windows.h') } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (!$sdkVersion) { throw 'An existing Windows 10+ SDK is required.' }
$sdkInclude = Join-Path $sdkRoot ('Include/' + $sdkVersion.Name)
$sdkLib = Join-Path $sdkRoot ('Lib/' + $sdkVersion.Name)
foreach ($required in @('um/x64/kernel32.lib', 'ucrt/x64/ucrt.lib')) {
  if (!(Test-Path -LiteralPath (Join-Path $sdkLib $required))) { throw 'Existing SDK x64 libraries are incomplete.' }
}
$cmake = Join-Path $projectRoot '.local/toolchain/cmake-4.4.5/bin/cmake.exe'
$sourceRoot = Join-Path $projectRoot '.local/native/llama-source-cd959bae'
# MSBuild still creates MAX_PATH-limited temporary tracker files.
# Keep a fresh build tree short without changing machine-wide path settings.
$buildRoot = Join-Path $projectRoot ('.artifacts/b/' + [Guid]::NewGuid().ToString('N').Substring(0,12))
Assert-OwnedPath $buildRoot $true
if (Test-Path -LiteralPath $buildRoot) { throw 'Build tree must be fresh.' }
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
if (!(Test-Path -LiteralPath $cmake) -or !(Test-Path -LiteralPath (Join-Path $sourceRoot 'CMakeLists.txt'))) { throw 'Verified portable CMake and source archive are required.' }
$flags = @('-DCMAKE_UNITY_BUILD_RELOCATABLE=ON','-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL',
  '-DCMAKE_SHARED_LINKER_FLAGS_INIT=/MANIFEST:NO', '-DCMAKE_MODULE_LINKER_FLAGS_INIT=/MANIFEST:NO',
  '-DBUILD_SHARED_LIBS=ON','-DGGML_BACKEND_DL=ON','-DGGML_BACKEND_DIR=',
  '-DGGML_CPU=ON','-DGGML_CPU_ALL_VARIANTS=OFF','-DGGML_NATIVE=OFF','-DGGML_SSE42=OFF','-DGGML_AVX=OFF','-DGGML_AVX2=OFF','-DGGML_BMI2=OFF',
  '-DGGML_OPENMP=OFF','-DGGML_OPENMP_FETCH=OFF','-DGGML_CPU_KLEIDIAI=OFF','-DGGML_LLAMAFILE=OFF','-DGGML_CCACHE=OFF',
  '-DGGML_CUDA=OFF','-DGGML_RPC=OFF','-DGGML_VULKAN=OFF','-DGGML_BLAS=OFF',
  '-DLLAMA_BUILD_COMMON=OFF','-DLLAMA_BUILD_TOOLS=OFF','-DLLAMA_BUILD_SERVER=OFF','-DLLAMA_BUILD_APP=OFF',
  '-DLLAMA_BUILD_EXAMPLES=OFF','-DLLAMA_BUILD_TESTS=OFF','-DLLAMA_BUILD_MTMD=OFF','-DLLAMA_OPENSSL=OFF','-DLLAMA_SUBPROCESS=OFF',
  '-DFETCHCONTENT_FULLY_DISCONNECTED=ON','-DCMAKE_FIND_USE_PACKAGE_REGISTRY=OFF','-DCMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY=OFF',
  '-DCMAKE_DISABLE_FIND_PACKAGE_Git=TRUE','-DGIT_EXE:FILEPATH=','-DLLAMA_BUILD_NUMBER=12110','-DLLAMA_BUILD_COMMIT=cd959bae99ff4bed22bef2604f45241c09bbb8c8',
  '-DGGML_BUILD_COMMIT=cd959bae99ff4bed22bef2604f45241c09bbb8c8')
$lines = @('@echo off', ('call "' + $environmentScript + '" >nul'), 'if errorlevel 1 exit /b 1')
$lines += 'set "INCLUDE=' + $sdkInclude + '\um;' + $sdkInclude + '\shared;' + $sdkInclude + '\ucrt;%INCLUDE%"'
$lines += 'set "LIB=' + $sdkLib + '\um\x64;' + $sdkLib + '\ucrt\x64;%LIB%"'
$lines += 'set "UniversalCRTSdkDir=' + $sdkRoot + '\"'
$lines += 'set "UCRTVersion=' + $sdkVersion.Name + '"'
$lines += 'set "WindowsSdkDir=' + $sdkRoot + '\"'
$lines += 'set "WindowsSDKVersion=' + $sdkVersion.Name + '\"'
$lines += 'set "CMAKE_BUILD_PARALLEL_LEVEL=1"' 
$lines += 'set "CL=/MP1 /I"' + $sdkInclude + '\um" /I"' + $sdkInclude + '\shared" /I"' + $sdkInclude + '\ucrt""'
$lines += 'set "LINK=/LIBPATH:"' + $sdkLib + '\um\x64" /LIBPATH:"' + $sdkLib + '\ucrt\x64""' 
$configure = '"' + $cmake + '" -S "' + $sourceRoot + '" -B "' + $buildRoot + '" -G "Visual Studio 17 2022" -A x64 ' + ($flags -join ' ')
$configure += ' "-DCMAKE_GENERATOR_INSTANCE=' + $installation + '" -T "version=' + $toolset + ',host=x64"'
$configure += ' -DCMAKE_SYSTEM_VERSION=' + $sdkVersion.Name
$configure += ' "-DCMAKE_RC_COMPILER:FILEPATH=' + (Join-Path $sdkRoot ('bin/' + $sdkVersion.Name + '/x64/rc.exe')) + '"'
$configure += ' "-DCMAKE_MT:FILEPATH=' + (Join-Path $sdkRoot ('bin/' + $sdkVersion.Name + '/x64/mt.exe')) + '"'
$lines += $configure
$lines += 'if errorlevel 1 exit /b 1'
$lines += '"' + $msbuild + '" "' + (Join-Path $buildRoot 'ALL_BUILD.vcxproj') + '" /nologo /m:1 /p:Configuration=Release /p:Platform=x64 /p:UseMultiToolTask=false /p:MultiProcessorCompilation=false /p:CL_MPCount=1 /p:BuildInParallel=false'
$lines += 'exit /b %errorlevel%'
$command = Join-Path $outputRoot 'build.cmd'
[IO.File]::WriteAllText($command, ($lines -join "`r`n"), [Text.UTF8Encoding]::new($false))
$wrapper = Join-Path $outputRoot 'launch-build.cmd'
[IO.File]::WriteAllText($wrapper, ('@echo off' + "`r`n%SystemRoot%\System32\chcp.com 65001 >nul`r`ncall " + '"' + $command + '"' + "`r`nexit /b %errorlevel%"), [Text.UTF8Encoding]::new($false))
$stdout = Join-Path $outputRoot 'build.stdout.txt'; $stderr = Join-Path $outputRoot 'build.stderr.txt'
$p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/cmd.exe') -ArgumentList ('/d /s /c ""' + $wrapper + '""') -WorkingDirectory $outputRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr -NoNewWindow -PassThru
$null = $p.Handle
$p.WaitForExit(); $p.Refresh()
if ($p.ExitCode -ne 0) { throw 'CPU source build failed; inspect retained logs.' }

& (Join-Path $PSScriptRoot 'prepare-native-runtime.ps1') -CheckOnly
$installed = Join-Path $projectRoot '.local/native/llama-v0.9.0-source-cpu'
$expected = @('ggml-base.dll','ggml.dll','llama.dll','ggml-cpu.dll')
if (($profile.dlls -join ',') -ne ($expected -join ',')) { throw 'Unexpected CPU DLL closure.' }
$files = @{}
foreach ($name in $expected) {
  $built = Join-Path $buildRoot ('bin/Release/' + $name)
  $item = Get-Item -LiteralPath $built
  if ($item.Length -gt 16MB -or $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected compiled library.' }
  $data = [IO.File]::ReadAllBytes($built)
  if ($data.Length -lt 256) { throw 'Truncated compiled image.' }
  $pe = [BitConverter]::ToUInt32($data,0x3c)
  if ($pe + 160 -gt $data.Length -or [BitConverter]::ToUInt32($data,$pe) -ne 0x4550 -or [BitConverter]::ToUInt16($data,$pe+4) -ne 0x8664 -or
      [BitConverter]::ToUInt16($data,$pe+24) -ne 0x20b) { throw 'Unexpected PE image.' }
  if ([BitConverter]::ToUInt32($data,$pe+24+112+16) -ne 0 -or [BitConverter]::ToUInt32($data,$pe+24+112+20) -ne 0) { throw 'CPU DLL contains resources; manifest-free condition not established.' }
  $target = Join-Path $installed ('bin/' + $name)
  Write-Owned $target $data
  $digest = (Get-FileHash -LiteralPath $built -Algorithm SHA256).Hash.ToLowerInvariant()
  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest) { throw 'Compiled copy differs.' }
  $files['bin/' + $name] = @{bytes=$item.Length;sha256=$digest;origin='local-source-build';resourceDirectoryAbsent=$true}
}
foreach ($entry in $profile.headersAndLicense.PSObject.Properties) {
  $prefix = 'https://raw.githubusercontent.com/ggml-org/llama.cpp/' + $profile.revision + '/'
  if (!$entry.Value.origin.StartsWith($prefix) -or $entry.Name -notmatch '^(include/[a-z0-9.-]+\.h|licenses/LICENSE-llama\.cpp)$') { throw 'Unexpected source resource.' }
  $relative = $entry.Value.origin.Substring($prefix.Length)
  if ($relative -match '(^|/)\.\.(/|$)|[:\\]') { throw 'Unexpected upstream path.' }
  $original = Join-Path $sourceRoot $relative
  if ((Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value.sha256) { throw 'Header/license differs from pinned ABI.' }
  $target = Join-Path $installed $entry.Name
  Write-Owned $target ([IO.File]::ReadAllBytes($original))
  $files[$entry.Name] = $entry.Value
}
foreach ($path in $inputHashes.Keys) {
  if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $inputHashes[$path]) { throw 'Build instructions changed during compilation.' }
}
$compilerMetadataPath = Join-Path $buildRoot 'CMakeFiles/4.4.5/CMakeCXXCompiler.cmake'
$compilerMetadata = Get-Content -LiteralPath $compilerMetadataPath -Raw
function Selected-Tool($Key) {
  $matches = [regex]::Matches($compilerMetadata,('(?m)^set\(' + $Key + ' "([^"\r\n]+)"\)'))
  if ($matches.Count -ne 1) { throw 'Selected compiler tool metadata is missing or ambiguous.' }
  $path = [IO.Path]::GetFullPath($matches[0].Groups[1].Value)
  if (!$path.StartsWith($installation + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'CMake selected a different compiler installation.' }
  return $path
}
$observedTools = @{}
foreach ($entry in @(@{name='compiler';path=(Selected-Tool 'CMAKE_CXX_COMPILER')},
                     @{name='linker';path=(Selected-Tool 'CMAKE_LINKER')},
                     @{name='msbuild';path=$msbuild})) {
  $tool = Get-Item -LiteralPath $entry.path
  $observedTools[$entry.name] = @{path=$tool.FullName;version=$tool.VersionInfo.FileVersion;sha256=(Get-FileHash -LiteralPath $tool.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
}
$receipt = @{schema=1;id=$profile.id;revision=$profile.revision;backend=$profile.backend;files=$files;
  sourceProfileSha256=(Get-FileHash -LiteralPath $profilePath -Algorithm SHA256).Hash.ToLowerInvariant();
  recipeSha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant();
  prepareSha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'prepare-native-runtime.ps1') -Algorithm SHA256).Hash.ToLowerInvariant();
  affinity=1;priority='BelowNormal';buildFlags=$flags;sourceVerifiedBeforeAndAfter=$true;
  build=@{root=$buildRoot;generator='Visual Studio 17 2022';instance=$installation;toolset=$toolset;sdk=$sdkVersion.Name;tools=$observedTools;
    compilerMetadataSha256=(Get-FileHash -LiteralPath $compilerMetadataPath -Algorithm SHA256).Hash.ToLowerInvariant();
    commandSha256=(Get-FileHash -LiteralPath $command -Algorithm SHA256).Hash.ToLowerInvariant();
    cacheSha256=(Get-FileHash -LiteralPath (Join-Path $buildRoot 'CMakeCache.txt') -Algorithm SHA256).Hash.ToLowerInvariant();
    overrides=@('/p:UseMultiToolTask=false','/p:MultiProcessorCompilation=false','/p:CL_MPCount=1','/p:BuildInParallel=false')}}
Write-Owned (Join-Path $outputBase 'runtime-manifest.json') ([Text.UTF8Encoding]::new($false).GetBytes(($receipt | ConvertTo-Json -Depth 12)))
Write-Output 'Four CPU libraries without DLL manifests installed privately; source and portable CMake verified; installed compiler/SDK identities recorded; no model run.'

