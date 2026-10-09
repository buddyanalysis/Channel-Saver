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
# The update banner downloads a file named after the version (channel-saver-1.9.2.zip);
# channel-saver.zip stays on every release too, so ".../releases/latest/download/channel-saver.zip" always works.
$download = "https://github.com/$repo/releases/download/v$Version/channel-saver-$Version.zip"
# Everything the extension loads: top-level .js/.css/.html/.json (except version.json), INSTALL.txt, lib, icons.
$files = @(Get-ChildItem -File | Where-Object { $_.Extension -in '.js', '.css', '.html', '.json' -and $_.Name -ne 'version.json' } | ForEach-Object Name) + 'INSTALL.txt', 'lib', 'icons'

# 1. manifest version (keeps the file's formatting otherwise)
$manifest = [IO.File]::ReadAllText((Join-Path $root 'manifest.json'), [Text.Encoding]::UTF8)
$manifest = $manifest -replace '"version":\s*"[^"]+"', "`"version`": `"$Version`""
[IO.File]::WriteAllText((Join-Path $root 'manifest.json'), $manifest)
# The dashboard compares its own build number with the running manifest to
# spot an extension that wasn't reloaded after an update - keep them equal.
$dash = [IO.File]::ReadAllText((Join-Path $root 'dashboard.js'), [Text.Encoding]::UTF8)
$dash = $dash -replace "const BUILD = '[^']+';", "const BUILD = '$Version';"
[IO.File]::WriteAllText((Join-Path $root 'dashboard.js'), $dash)

# Stop if a file got double-encoded (UTF-8 read as ANSI: a middle dot becomes C3/C2 junk, emoji start with F0 178).
$bad = Get-ChildItem -File -Include *.js,*.html,*.css -Recurse -Path . | Where-Object { $_.FullName -notmatch '\\(dist|node_modules|\.git)\\' -and ([IO.File]::ReadAllText($_.FullName, [Text.Encoding]::UTF8) -match '\u00C3[\u0080-\u00BF]|\u00C2\u00B7|\u00F0\u0178') }
if ($bad) { throw "Broken text encoding in: $($bad.Name -join ', ')" }

# 2. ZIP with a top-level channel-saver folder
$stage = Join-Path $env:TEMP "cs-release\channel-saver"
if (Test-Path (Split-Path $stage)) { Remove-Item (Split-Path $stage) -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
foreach ($f in $files) { Copy-Item $f -Destination $stage -Recurse }
New-Item -ItemType Directory -Force dist | Out-Null
$zip = Join-Path $root 'dist\channel-saver.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $stage -DestinationPath $zip
$zipVersioned = Join-Path $root "dist\channel-saver-$Version.zip"
Copy-Item $zip $zipVersioned -Force

# 3. code + release
git add -A -- . ':!dist' ':!version.json'
git commit -m "Release $Version" -m $(if ($Notes) { $Notes } else { "Channel Saver $Version" }) -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
gh release create "v$Version" $zipVersioned $zip --repo $repo --title "Channel Saver $Version" --notes $(if ($Notes) { $Notes } else { "Channel Saver $Version" })

# 4. announce it to installed copies
$info = [ordered]@{ version = $Version; download = $download; notes = $Notes }
[IO.File]::WriteAllText((Join-Path $root 'version.json'), (($info | ConvertTo-Json) + "`n"))
git add version.json
git commit -m "Announce $Version" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
Write-Host "Released $Version - $download"
