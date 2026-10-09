# dsh-pomodoro installer.
#
# Copies the plugin into the active DSH profile's node_modules and registers it
# in that profile's bundle list, so a restart of DSH picks it up.
#
# Usage:
#   pwsh -File scripts/install.ps1              # auto-detect the profile
#   pwsh -File scripts/install.ps1 -Profile web # force a profile name
#   pwsh -File scripts/install.ps1 -Uninstall   # remove instead

[CmdletBinding()]
param(
  [string]$Profile,
  [switch]$Uninstall,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$pluginName = 'dsh-pomodoro'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profilesRoot = Join-Path $dshHome 'profiles'

if (-not (Test-Path $profilesRoot)) {
  throw "找不到 profiles 目录：$profilesRoot（DSH 是否已运行过？）"
}

# Pick the profile. Precedence matters: the RUNNING profile wins, because
# installing into a profile DSH is not currently using silently does nothing.
# `$env:DSH_PROFILE` is set inside a DSH session (and DSH_PROFILE_DIR names its
# directory outright); a newest-mtime guess is only the last resort.
if (-not $Profile) {
  if ($env:DSH_PROFILE) {
    $Profile = $env:DSH_PROFILE
    Write-Host "profile 来自 `$env:DSH_PROFILE：$Profile" -ForegroundColor Cyan
  } elseif ($env:DSH_PROFILE_DIR -and (Test-Path $env:DSH_PROFILE_DIR)) {
    $Profile = Split-Path -Leaf $env:DSH_PROFILE_DIR
    Write-Host "profile 来自 `$env:DSH_PROFILE_DIR：$Profile" -ForegroundColor Cyan
  } else {
    $candidates = Get-ChildItem $profilesRoot -Directory |
      Where-Object { Test-Path (Join-Path $_.FullName 'package.json') }
    if ($candidates.Count -eq 0) { throw "在 $profilesRoot 下没有找到任何 profile。" }
    # Prefer the desktop profile when it exists: that is the surface the user
    # actually sees. Otherwise fall back to the most recently written one.
    $preferred = $candidates | Where-Object { $_.Name -eq 'desktop' } | Select-Object -First 1
    if (-not $preferred) { $preferred = $candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1 }
    $Profile = $preferred.Name
    Write-Host "自动选择 profile：$Profile（若不对请用 -Profile 指定）" -ForegroundColor Yellow
  }
}

$profileDir = Join-Path $profilesRoot $Profile
$profileJson = Join-Path $profileDir 'package.json'
if (-not (Test-Path $profileJson)) {
  $available = (Get-ChildItem $profilesRoot -Directory | Select-Object -ExpandProperty Name) -join ', '
  throw "profile '$Profile' 不存在或缺少 package.json。$profilesRoot 下可用：$available"
}

$targetDir = Join-Path $profileDir "node_modules\$pluginName"

if ($Uninstall) {
  if (Test-Path $targetDir) {
    Remove-Item $targetDir -Recurse -Force
    Write-Host "已删除 $targetDir" -ForegroundColor Yellow
  }
  $manifest = Get-Content $profileJson -Raw | ConvertFrom-Json
  if ($manifest.dsh.profile.bundles -contains $pluginName) {
    $manifest.dsh.profile.bundles = @($manifest.dsh.profile.bundles | Where-Object { $_ -ne $pluginName })
    $manifest | ConvertTo-Json -Depth 20 | Set-Content $profileJson -Encoding UTF8
    Write-Host "已从 bundles 中移除 $pluginName" -ForegroundColor Yellow
  }
  if ($manifest.dependencies -and $manifest.dependencies.PSObject.Properties.Name -contains $pluginName) {
    $clean = [PSCustomObject]@{}
    foreach ($p in $manifest.dependencies.PSObject.Properties) {
      if ($p.Name -ne $pluginName) { $clean | Add-Member -MemberType NoteProperty -Name $p.Name -Value $p.Value }
    }
    $manifest.dependencies = $clean
    $manifest | ConvertTo-Json -Depth 20 | Set-Content $profileJson -Encoding UTF8
    Write-Host "已从 dependencies 中移除 $pluginName（市场『已安装』列表同步更新）。" -ForegroundColor Yellow
  }
  Write-Host '请重启 DSH 使改动生效。' -ForegroundColor Cyan
  return
}

# --- copy the package -------------------------------------------------------
$files = @('package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'lib')
if (Test-Path $targetDir) {
  if (-not $Force) {
    Write-Host "目标已存在，正在覆盖（保留其他文件）：$targetDir" -ForegroundColor Yellow
  }
  foreach ($file in $files) {
    $target = Join-Path $targetDir $file
    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
  }
} else {
  New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
}

foreach ($file in $files) {
  $source = Join-Path $pluginRoot $file
  if (-not (Test-Path $source)) { throw "插件缺少文件：$source" }
  Copy-Item $source (Join-Path $targetDir $file) -Recurse -Force
}
Write-Host "已安装到 $targetDir" -ForegroundColor Green

# --- register the bundle AND the dependency --------------------------------
# Two registrations, two different consumers:
#   * `dsh.profile.bundles`  -> DSH loads the plugin (sidebar icon, panel).
#   * `dependencies`          -> the marketplace "已安装" tab lists it. That tab
#                                is built from the profile's dependency table
#                                (the host `/installed` route reads
#                                `manifest.dependencies`, excluding @deepseek-ai/
#                                official packages), NOT from `bundles`. Without
#                                a `dependencies` entry the plugin runs fine but
#                                never shows up as installed in the UI.
$manifest = Get-Content $profileJson -Raw | ConvertFrom-Json
if ($null -eq $manifest.dsh) { throw "profile 的 package.json 缺少 dsh 字段：$profileJson" }
if ($null -eq $manifest.dsh.profile) { throw "profile 的 package.json 缺少 dsh.profile 字段：$profileJson" }
if ($null -eq $manifest.dependencies -or $manifest.dependencies -isnot [PSCustomObject]) {
  $manifest.dependencies = [PSCustomObject]@{}
}

$bundles = @($manifest.dsh.profile.bundles)
if ($bundles -contains $pluginName) {
  Write-Host "bundles 已包含 $pluginName，无需修改。" -ForegroundColor Cyan
} else {
  $manifest.dsh.profile.bundles = @($bundles + $pluginName)
  # Depth must cover the nested dsh.profile.bundles array.
  $manifest | ConvertTo-Json -Depth 20 | Set-Content $profileJson -Encoding UTF8
  Write-Host "已把 $pluginName 加入 bundles。" -ForegroundColor Green
}

# Register as a dependency so the marketplace "已安装" list shows it. Pin the
# version to the one declared in the plugin's own package.json.
$depVersion = 'file:' + $pluginRoot
if ($manifest.dependencies.PSObject.Properties.Name -contains $pluginName) {
  Write-Host "dependencies 已包含 $pluginName，无需修改。" -ForegroundColor Cyan
} else {
  $manifest.dependencies | Add-Member -MemberType NoteProperty -Name $pluginName -Value $depVersion
  $manifest | ConvertTo-Json -Depth 20 | Set-Content $profileJson -Encoding UTF8
  Write-Host "已把 $pluginName 加入 dependencies（版本指向本地：$depVersion）。" -ForegroundColor Green
}

Write-Host ''
Write-Host '安装完成。下一步：' -ForegroundColor Cyan
Write-Host '  1. 重启 DSH（例如重新运行 dsh web，或重启桌面端）。'
Write-Host '  2. 左侧边栏会出现番茄钟图标，点击进入独立面板。'
Write-Host '  3. 数据保存在：' (Join-Path $dshHome 'storages\pomodoro\state.json')
