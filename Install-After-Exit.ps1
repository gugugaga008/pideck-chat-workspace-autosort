param(
    [string]$ExePath,
    [string]$PackageDir,
    [string]$NodePath,
    [switch]$Launch
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

# Installs only after the target PiDeck has exited. This script never calls
# Stop-Process/taskkill and never replaces a live app.asar.
try {
    $config = Get-ProjectConfig
    if (-not $ExePath) { $ExePath = $config.ExePath }
    if (-not $PackageDir) { $PackageDir = $config.PackageDir }
    $node = Resolve-NodePath $NodePath
    $status = Get-PatchStatus -ExePath $ExePath -PackageDir $PackageDir -NodePath $node
    if (-not $status.ok) { throw "无法读取补丁状态：$($status.error)" }
} catch {
    Show-PatchMessage -Text "无法开始安装：$($_.Exception.Message)" -Icon 'Error' | Out-Null
    exit 1
}

if ($status.state -eq 'patched') {
    Show-PatchMessage -Text "补丁已经安装，无需重复操作。`n`n如果要使用功能，还需要在 PiDeck 设置 → PiDeck 插件中从文件夹安装 plugin 目录，并打开自动分类开关。" | Out-Null
    if ($Launch) { Start-TargetPiDeck -ExePath $ExePath }
    exit 0
}

if (Test-TargetPiDeckRunning -ExePath $ExePath) {
    $notice = "PiDeck 正在运行。`n`n点击「确定」后，脚本会等待你完全退出 PiDeck，再安装补丁。`n不会强制关闭、结束进程或改动正在运行的程序。"
    Show-PatchMessage -Text $notice | Out-Null
    Write-Host "等待 PiDeck 退出；退出后会自动继续安装。"
    Wait-TargetPiDeckExit -ExePath $ExePath
}

$confirm = Show-PatchMessage -Text "即将把本地补丁写入：`n$ExePath`n`n原始文件会先备份到本项目 backups 目录，可随时恢复。是否继续？" -Buttons 'YesNo' -Icon 'Question'
if ($confirm -ne 'Yes') {
    Write-Host "已取消，未修改任何文件。"
    exit 0
}

$cli = Join-Path $PSScriptRoot 'cli.mjs'
Write-Host "正在安装补丁…"
$output = & $node $cli install --exe $ExePath --package $PackageDir 2>&1 | ForEach-Object { "$_" }
$exitCode = $LASTEXITCODE
$text = ($output | Out-String).Trim()
Write-PatchLog -Name 'install.log' -Text "install exit=$exitCode`n$text"

if ($exitCode -ne 0) {
    Show-PatchMessage -Text "安装失败，原程序保持不变。`n`n$text" -Icon 'Error' | Out-Null
    exit 1
}

$after = Get-PatchStatus -ExePath $ExePath -PackageDir $PackageDir -NodePath $node
if (-not $after.ok -or $after.state -ne 'patched') {
    Show-PatchMessage -Text "安装命令已结束，但复核未得到 patched 状态。`n`n$text" -Icon 'Error' | Out-Null
    exit 1
}

$success = "补丁安装成功，并已复核为 patched。`n`n如果之前已经安装并授权插件，升级补丁不会清除它，可以跳过下一步；否则：打开 PiDeck → 设置 → PiDeck 插件 → 从文件夹安装，选择：`n$((Join-Path $PSScriptRoot 'plugin'))`n`n安装后授权 chatWorkspace.manage、启用插件，并在面板中打开「自动分类新聊天目录」。"
Write-PatchLog -Name 'install.log' -Text $success
Show-PatchMessage -Text $success | Out-Null

$launchNow = $Launch
if (-not $launchNow) {
    $launchNow = (Show-PatchMessage -Text "现在启动 PiDeck 吗？" -Buttons 'YesNo' -Icon 'Question') -eq 'Yes'
}
if ($launchNow) {
    Start-TargetPiDeck -ExePath $ExePath
}
