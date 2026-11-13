param(
    [string]$ExePath,
    [string]$PackageDir,
    [string]$NodePath,
    [switch]$Launch
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

# Restores only the original app.asar backup. Chat data, chat folders, settings,
# plugin grants and backups are never deleted or rewritten by this script.
try {
    $config = Get-ProjectConfig
    if (-not $ExePath) { $ExePath = $config.ExePath }
    if (-not $PackageDir) { $PackageDir = $config.PackageDir }
    $node = Resolve-NodePath $NodePath
    $status = Get-PatchStatus -ExePath $ExePath -PackageDir $PackageDir -NodePath $node
    if (-not $status.ok) { throw "无法读取补丁状态：$($status.error)" }
} catch {
    Show-PatchMessage -Text "无法开始恢复：$($_.Exception.Message)" -Icon 'Error' | Out-Null
    exit 1
}

if ($status.state -eq 'clean') {
    Show-PatchMessage -Text "当前已经是原版，无需恢复。`n`n聊天记录、聊天子目录和插件文件都没有被删除。" | Out-Null
    exit 0
}

if (Test-TargetPiDeckRunning -ExePath $ExePath) {
    $notice = "PiDeck 正在运行。`n`n点击「确定」后，脚本会等待你完全退出 PiDeck，再恢复原版。`n不会强制关闭、结束进程或改动正在运行的程序。"
    Show-PatchMessage -Text $notice | Out-Null
    Write-Host "等待 PiDeck 退出；退出后会自动继续恢复。"
    Wait-TargetPiDeckExit -ExePath $ExePath
}

$confirm = Show-PatchMessage -Text "即将从本项目 backups 中恢复已验证的原版 app.asar。`n`n聊天记录、聊天子目录、设置和插件文件都会保留。是否继续？" -Buttons 'YesNo' -Icon 'Question'
if ($confirm -ne 'Yes') {
    Write-Host "已取消，未修改任何文件。"
    exit 0
}

$cli = Join-Path $PSScriptRoot 'cli.mjs'
Write-Host "正在恢复原版…"
$output = & $node $cli restore --exe $ExePath --package $PackageDir 2>&1 | ForEach-Object { "$_" }
$exitCode = $LASTEXITCODE
$text = ($output | Out-String).Trim()
Write-PatchLog -Name 'restore.log' -Text "restore exit=$exitCode`n$text"

if ($exitCode -ne 0) {
    Show-PatchMessage -Text "恢复失败。`n`n$text" -Icon 'Error' | Out-Null
    exit 1
}

$after = Get-PatchStatus -ExePath $ExePath -PackageDir $PackageDir -NodePath $node
if (-not $after.ok -or $after.state -ne 'clean') {
    Show-PatchMessage -Text "恢复命令已结束，但复核未得到 clean 状态。`n`n$text" -Icon 'Error' | Out-Null
    exit 1
}

$message = "已恢复为原版 app.asar。`n`n聊天记录、聊天子目录、设置和插件文件均保留。`n新聊天会恢复使用原来的共享工作目录；插件面板会显示宿主不支持，可保留待下次补丁，或在插件管理中卸载。"
Write-PatchLog -Name 'restore.log' -Text $message
Show-PatchMessage -Text $message | Out-Null

$launchNow = $Launch
if (-not $launchNow) {
    $launchNow = (Show-PatchMessage -Text "现在启动 PiDeck 吗？" -Buttons 'YesNo' -Icon 'Question') -eq 'Yes'
}
if ($launchNow) {
    Start-TargetPiDeck -ExePath $ExePath
}
