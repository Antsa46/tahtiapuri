param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$self = [Diagnostics.Process]::GetCurrentProcess()
$self.PriorityClass = [Diagnostics.ProcessPriorityClass]::BelowNormal
$self.ProcessorAffinity = [IntPtr]1
$root = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$profile = Get-Content -LiteralPath (Join-Path $root 'resources/runtimes/llama-cpp-cpu.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($profile.id -ne 'llama-cpp-v0.9.0-b12110-cpu-x64') { throw 'Unexpected runtime profile.' }
$destination = Join-Path $root '.local/native/llama-v0.9.0-b12110'
Add-Type -AssemblyName System.Net.Http
Add-Type -AssemblyName System.IO.Compression.FileSystem
$client = [Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromSeconds(90)
$client.MaxResponseContentBufferSize = 32MB
function Assert-Identity($Path, $Spec) {
  $item = Get-Item -LiteralPath $Path
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -ne $Spec.bytes -or
      (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Spec.sha256) { throw 'Pinned dependency identity differs.' }
}
function Write-Pinned($Path, [byte[]]$Bytes, $Spec) {
  if ($Bytes.Length -ne $Spec.bytes) { throw 'Dependency size differs.' }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $digest = [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
  if ($digest -ne $Spec.sha256) { throw 'Dependency digest differs.' }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($Bytes, 0, $Bytes.Length) } finally { $stream.Dispose() }
}
$archive = $null
try {
  foreach ($entry in $profile.files.PSObject.Properties) {
    if ($entry.Name -notmatch '^(bin/[a-z0-9.-]+\.dll|include/[a-z0-9.-]+\.h|licenses/LICENSE-[A-Za-z.-]+)$') { throw 'Unexpected dependency path.' }
    $path = Join-Path $destination $entry.Name
    if (Test-Path -LiteralPath $path) { Assert-Identity $path $entry.Value; continue }
    if ($CheckOnly) { throw 'Dependency missing; verification did not download anything.' }
    if ($entry.Value.origin.StartsWith('archive:')) {
      if ($null -eq $archive) {
        $zip = Join-Path $destination 'upstream.zip'
        if (!(Test-Path -LiteralPath $zip)) {
          if ($profile.archive.url -ne 'https://github.com/ggml-org/llama.cpp/releases/download/b12110/llama-b12110-bin-win-cpu-x64.zip') { throw 'Unexpected archive URL.' }
          Write-Pinned $zip ($client.GetByteArrayAsync($profile.archive.url).GetAwaiter().GetResult()) $profile.archive
        }
        Assert-Identity $zip $profile.archive
        $archive = [IO.Compression.ZipFile]::OpenRead($zip)
      }
      $name = $entry.Value.origin.Substring(8)
      $items = @($archive.Entries | Where-Object { $_.FullName -eq $name })
      if ($items.Count -ne 1 -or $items[0].Length -ne $entry.Value.bytes -or $items[0].Length -gt 8MB) { throw 'Unexpected archive member.' }
      $inputStream = $items[0].Open(); $buffer = [IO.MemoryStream]::new()
      try { $inputStream.CopyTo($buffer); Write-Pinned $path $buffer.ToArray() $entry.Value }
      finally { $inputStream.Dispose(); $buffer.Dispose() }
    } else {
      $prefix = 'https://raw.githubusercontent.com/ggml-org/llama.cpp/' + $profile.revision + '/'
      if (!$entry.Value.origin.StartsWith($prefix) -or $entry.Value.bytes -gt 1MB) { throw 'Unexpected upstream source.' }
      Write-Pinned $path ($client.GetByteArrayAsync($entry.Value.origin).GetAwaiter().GetResult()) $entry.Value
    }
    Assert-Identity $path $entry.Value
  }
} finally { if ($null -ne $archive) { $archive.Dispose() }; $client.Dispose() }
Write-Output 'Pinned CPU libraries, matching headers and license notices verified; nothing executed.'
