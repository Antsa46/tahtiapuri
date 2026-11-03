param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Destination) { throw 'Extraction destination must be new.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
  if ($zip.Entries.Count -gt 2000) { throw 'Unexpected Electron archive entry count.' }
  foreach ($entry in $zip.Entries) {
    $parts = $entry.FullName.Replace('\', '/').Split('/')
    if ([IO.Path]::IsPathRooted($entry.FullName) -or $entry.FullName.Contains(':') -or $parts.Contains('..')) { throw 'Archive path leaves its destination.' }
  }
} finally { $zip.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Destination)
