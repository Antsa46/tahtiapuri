param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$self = [Diagnostics.Process]::GetCurrentProcess()
$self.PriorityClass = [Diagnostics.ProcessPriorityClass]::BelowNormal
$self.ProcessorAffinity = [IntPtr]1
$root = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$profile = Get-Content -LiteralPath (Join-Path $root 'resources/runtimes/llama-cpp-source-cpu.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($profile.id -ne 'llama-cpp-v0.9.0-source-cpu' -or $profile.downloads.Count -ne 2) { throw 'Unexpected source profile.' }
Add-Type -AssemblyName System.Net.Http
Add-Type -AssemblyName System.IO.Compression.FileSystem
$client = [Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromSeconds(90)
$client.MaxResponseContentBufferSize = 128MB
function Digest([IO.Stream]$Stream) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($Stream)).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}
# Windows PowerShell otherwise reports existing paths over MAX_PATH as missing.
function Native-Path($Path) {
  if ($Path.StartsWith('\\?\')) { return $Path }
  return '\\?\' + [IO.Path]::GetFullPath($Path)
}
function Regular($Path) {
  $file = Get-Item -LiteralPath (Native-Path $Path) -Force
  if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Dependency must be an ordinary file.' }
  return $file
}
function Check-Parents($Path,$Stop) {
  $here = Split-Path -Parent $Path
  while ($here.Length -ge $Stop.Length) {
    if (Test-Path -LiteralPath (Native-Path $here)) {
      $item = Get-Item -LiteralPath (Native-Path $here) -Force
      if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Dependency parent is not an ordinary directory.' }
    }
    if ($here -eq $Stop) { return }; $here = Split-Path -Parent $here
  }
  throw 'Dependency path escaped its root.'
}
try {
  $seen = @{}
  foreach ($download in $profile.downloads) {
    if ($download.id -eq 'cmake-4.4.5') {
      $target = '.local/toolchain/cmake-4.4.5'
      $expectedUrl = 'https://github.com/Kitware/CMake/releases/download/v4.4.5/cmake-4.4.5-windows-x86_64.zip'
      $prefix = 'cmake-4.4.5-windows-x86_64/'
    } elseif ($download.id -eq 'llama-source-cd959bae') {
      $target = '.local/native/llama-source-cd959bae'
      $expectedUrl = 'https://codeload.github.com/ggml-org/llama.cpp/zip/cd959bae99ff4bed22bef2604f45241c09bbb8c8'
      $prefix = 'llama.cpp-cd959bae99ff4bed22bef2604f45241c09bbb8c8/'
    } else { throw 'Unexpected dependency.' }
    if ($seen.ContainsKey($download.id) -or $download.target -ne $target -or $download.url -ne $expectedUrl -or $download.prefix -ne $prefix -or
        $download.sha256 -notmatch '^[0-9a-f]{64}$' -or $download.bytes -le 0 -or $download.bytes -gt 128MB) { throw 'Unexpected dependency metadata.' }
    $seen[$download.id] = $true
    $archivePath = Join-Path $root ('.local/downloads/native-runtime/' + $download.id + '.zip')
    Check-Parents $archivePath $root
    if (!(Test-Path -LiteralPath $archivePath)) {
      if ($CheckOnly) { throw 'Archive missing; verification did not download anything.' }
      $bytes = $client.GetByteArrayAsync($download.url).GetAwaiter().GetResult()
      $stream = [IO.MemoryStream]::new($bytes,$false)
      try { $hash = Digest $stream } finally { $stream.Dispose() }
      if ($bytes.Length -ne $download.bytes -or $hash -ne $download.sha256) { throw 'Downloaded archive identity differs.' }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $archivePath) | Out-Null
      $output = [IO.File]::Open($archivePath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      try { $output.Write($bytes,0,$bytes.Length) } finally { $output.Dispose() }
    }
    $item = Regular $archivePath
    if ($item.Length -ne $download.bytes -or (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $download.sha256) { throw 'Archive identity differs.' }
    $destination = [IO.Path]::GetFullPath((Join-Path $root $target))
    $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
      if ($archive.Entries.Count -gt 20000) { throw 'Archive entry budget exceeded.' }
      $total = 0L; $names = @{}
      foreach ($entry in $archive.Entries) {
        $total += $entry.Length
        if ($total -gt 512MB -or $entry.Length -gt 64MB -or !$entry.FullName.StartsWith($prefix,[StringComparison]::Ordinal) -or
            (($entry.ExternalAttributes -shr 16) -band 0xf000) -eq 0xa000) { throw 'Archive member rejected.' }
        $relative = $entry.FullName.Substring($prefix.Length)
        if (!$relative) { continue }
        if ([IO.Path]::IsPathRooted($relative) -or $relative -match '(^|/)\.\.(/|$)|[:\\]') { throw 'Archive path rejected.' }
        $path = [IO.Path]::GetFullPath((Join-Path $destination $relative))
        if (!$path.StartsWith($destination + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escaped destination.' }
        Check-Parents $path $root
        if ($entry.FullName.EndsWith('/')) { continue }
        if ($names.ContainsKey($path)) { throw 'Duplicate archive path.' }; $names[$path] = $true
        if (!(Test-Path -LiteralPath (Native-Path $path))) {
          if ($CheckOnly) { throw ('Extracted source missing: ' + $relative) }
          New-Item -ItemType Directory -Force -Path (Native-Path (Split-Path -Parent $path)) | Out-Null
          $inputStream = $entry.Open(); $output = [IO.File]::Open((Native-Path $path),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
          try { $inputStream.CopyTo($output) } finally { $inputStream.Dispose(); $output.Dispose() }
        }
        $file = Regular $path
        $inputStream = $entry.Open()
        try { $expected = Digest $inputStream } finally { $inputStream.Dispose() }
        if ($file.Length -ne $entry.Length -or (Get-FileHash -LiteralPath (Native-Path $path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Extracted source identity differs.' }
      }
      # Additional files must not become compiler/CMake input outside the archive.
      $directories = [Collections.Generic.Stack[string]]::new()
      $directories.Push((Native-Path $destination))
      while ($directories.Count -gt 0) {
        foreach ($file in Get-ChildItem -LiteralPath $directories.Pop() -Force) {
          if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point in extracted tree.' }
          if ($file.PSIsContainer) { $directories.Push($file.FullName); continue }
          $normal = $file.FullName
          if ($normal.StartsWith('\\?\')) { $normal = $normal.Substring(4) }
          if (!$names.ContainsKey($normal)) { throw 'Unexpected extracted file.' }
        }
      }
    } finally { $archive.Dispose() }
    Write-Output ($download.id + ': archive and complete extracted tree verified.')
  }
} finally { $client.Dispose() }
