# InkOS V2 desktop build (replaces V1 prepare-resources.py + build.ps1).
# Assembles a portable-dir Electron app from the MONOREPO build output:
#   1. pnpm -r build                      (core + studio + cli)
#   2. pnpm deploy studio -> resources    (prod node_modules, workspace deps packed)
#   3. electron-builder --win --dir       (portable folder, no installer)
# Output: apps\desktop\release\win-unpacked\
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "[1/4] monorepo build"
pnpm -r build
if ($LASTEXITCODE -ne 0) { throw "monorepo build failed" }

Write-Host "[2/4] deploy studio with production deps"
$resources = Join-Path $root "apps\desktop\resources\inkos\studio"
if (Test-Path $resources) { Remove-Item -Recurse -Force $resources }
pnpm --filter @actalk/inkos-studio --prod deploy --legacy $resources
if ($LASTEXITCODE -ne 0) { throw "pnpm deploy failed" }
if (-not (Test-Path (Join-Path $resources "dist\api\index.js"))) { throw "deploy output missing dist/api/index.js" }

Write-Host "[3/4] desktop dependencies"
Set-Location $root
pnpm install
if ($LASTEXITCODE -ne 0) { throw "desktop install failed" }

Write-Host "[4/4] electron-builder portable dir"
pnpm --filter inkos-v2-desktop exec electron-builder --win --dir
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed" }

$out = Join-Path $root "apps\desktop\release\win-unpacked"
Write-Host ""
Write-Host "DONE  $out"
