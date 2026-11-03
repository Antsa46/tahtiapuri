param(
  [ValidateSet("install", "build", "typecheck", "test", "test:e2e", "test:model", "models:prepare", "cuda:prepare", "start")]
  [string]$Task = "start"
)
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$tools = Get-Content -LiteralPath "$PSScriptRoot/dev/toolchain.json" -Raw | ConvertFrom-Json
$cache = Join-Path $projectRoot ".local/cache/downloads"
$toolRoot = Join-Path $projectRoot ".local/toolchain"
New-Item -ItemType Directory -Force -Path $cache, $toolRoot | Out-Null
function Get-VerifiedArchive($Url, $File, $Sha256) {
  $destination = Join-Path $cache $File
  if (!(Test-Path -LiteralPath $destination)) {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $destination
  }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash.ToLowerInvariant() -ne $Sha256) {
    throw "Archive checksum mismatch: $File. Remove the file and retry."
  }
  return $destination
}
$nodeDir = Join-Path $toolRoot "node-v$($tools.node.version)-win-x64"
$nodeExe = Join-Path $nodeDir "node.exe"
if (!(Test-Path -LiteralPath $nodeExe)) {
  $archive = Get-VerifiedArchive $tools.node.downloadUrl $tools.node.archive $tools.node.sha256
  Expand-Archive -LiteralPath $archive -DestinationPath $toolRoot -Force
}
$previousPath = $env:Path
$previousPathExt = $env:PATHEXT
$previousState = $env:PNPM_CONFIG_STATE_DIR
try {
  $env:Path = "$nodeDir;$($env:SystemRoot)\System32;$previousPath"
  $env:PATHEXT = ".COM;.EXE;.BAT;.CMD"
  $env:PNPM_CONFIG_STATE_DIR = Join-Path $projectRoot ".local/cache/pnpm-state"
  function Invoke-ProjectNode {
    $nativeArguments = @($args | ForEach-Object {
      if ([string]$_ -like '*"*') { throw "Unsupported quote in project command argument." }
      '"' + [string]$_ + '"'
    })
    $process = Start-Process -FilePath $nodeExe -ArgumentList $nativeArguments -NoNewWindow -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "Project command failed (exit $($process.ExitCode))." }
  }
  $pnpmRoot = Join-Path $toolRoot "pnpm"
  $pnpmEntry = Join-Path $pnpmRoot "node_modules/pnpm/bin/pnpm.mjs"
  if (!(Test-Path -LiteralPath $pnpmEntry)) {
    $npm = Join-Path $nodeDir "node_modules/npm/bin/npm-cli.js"
    $npmCache = Join-Path $projectRoot ".local/cache/npm"
    Invoke-ProjectNode $npm install --prefix $pnpmRoot --cache $npmCache --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org "pnpm@$($tools.pnpm.version)"
  }
  Invoke-ProjectNode (Join-Path $PSScriptRoot "dev/verify-pnpm.mjs")
  $pnpmBinaryDir = Join-Path $pnpmRoot "node_modules/@pnpm/exe.win32-x64"
  if (!(Test-Path -LiteralPath (Join-Path $pnpmBinaryDir "pnpm.exe"))) { throw "Pinned pnpm native package missing." }
  $env:Path = "$pnpmBinaryDir;$($env:Path)"
  if ($Task -eq "cuda:prepare") {
    foreach ($component in $tools.cuda.components) {
      $url = "https://developer.download.nvidia.com/compute/cuda/redist/" + $component.relativePath
      $archive = Get-VerifiedArchive $url (Split-Path $component.relativePath -Leaf) $component.sha256
      Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $toolRoot "cuda") -Force
    }
  } elseif ($Task -eq "install") {
    if (Test-Path -LiteralPath "pnpm-lock.yaml") {
      Invoke-ProjectNode $pnpmEntry install --frozen-lockfile --ignore-scripts
    } else {
      Invoke-ProjectNode $pnpmEntry install --no-frozen-lockfile --ignore-scripts
    }
    $electronDir = Join-Path $toolRoot "electron-$($tools.electron.version)"
    if (!(Test-Path -LiteralPath (Join-Path $electronDir "electron.exe"))) {
      $archive = Get-VerifiedArchive $tools.electron.url $tools.electron.file $tools.electron.sha256
      Expand-Archive -LiteralPath $archive -DestinationPath $electronDir -Force
    }
    Write-Output "Project dependencies and verified Electron runtime are ready."
  } else {
    Invoke-ProjectNode $pnpmEntry run $Task
  }
} finally {
  $env:Path = $previousPath
  $env:PATHEXT = $previousPathExt
  $env:PNPM_CONFIG_STATE_DIR = $previousState
}
