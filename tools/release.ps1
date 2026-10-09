# Publishes a new Channel Saver version:
#   1. sets the version in manifest.json
#   2. builds dist/channel-saver.zip (unzips to a "channel-saver" folder)
#   3. commits + pushes, creates GitHub release vX.Y.Z with the ZIP attached
#   4. only then updates version.json, so no installed copy is told about an
#      update whose ZIP isn't downloadable yet
#
# Usage: powershell -ExecutionPolicy Bypass -File tools/release.ps1 -Version 1.3.0 -Notes "What changed"
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Notes = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must look like 1.3.0" }
$repo = 'buddyanalysis/Channel-Saver'
$download = "https://github.com/$repo/releases/latest/download/channel-saver.zip"
# Everything the extension loads: top-level .js/.css/.html/.json (except version.json), INSTALL.txt, lib, icons.
$files = @(Get-ChildItem -File | Where-Object { $_.Extension -in '.js', '.css', '.html', '.json' -and $_.Name -ne 'version.json' } | ForEach-Object Name) + 'INSTALL.txt', 'lib', 'icons'

# 1. manifest version (keeps the file's formatting otherwise)
$manifest = Get-Content manifest.json -Raw
$manifest = $manifest -replace '"version":\s*"[^"]+"', "`"version`": `"$Version`""
[IO.File]::WriteAllText((Join-Path $root 'manifest.json'), $manifest)
# The dashboard compares its own build number with the running manifest to
# spot an extension that wasn't reloaded after an update — keep them equal.
$dash = Get-Content dashboard.js -Raw
$dash = $dash -replace "const BUILD = '[^']+';", "const BUILD = '$Version';"
[IO.File]::WriteAllText((Join-Path $root 'dashboard.js'), $dash)

# 2. ZIP with a top-level channel-saver folder
$stage = Join-Path $env:TEMP "cs-release\channel-saver"
if (Test-Path (Split-Path $stage)) { Remove-Item (Split-Path $stage) -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
foreach ($f in $files) { Copy-Item $f -Destination $stage -Recurse }
New-Item -ItemType Directory -Force dist | Out-Null
$zip = Join-Path $root 'dist\channel-saver.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $stage -DestinationPath $zip

# 3. code + release
git add -A -- . ':!dist' ':!version.json'
git commit -m "Release $Version" -m $Notes
git push
gh release create "v$Version" $zip --repo $repo --title "Channel Saver $Version" --notes $(if ($Notes) { $Notes } else { "Channel Saver $Version" })

# 4. announce it to installed copies
$info = [ordered]@{ version = $Version; download = $download; notes = $Notes }
[IO.File]::WriteAllText((Join-Path $root 'version.json'), (($info | ConvertTo-Json) + "`n"))
git add version.json
git commit -m "Announce $Version"
git push
Write-Host "Released $Version — $download"
