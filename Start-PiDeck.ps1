param(
    [string]$ExePath,
    [string]$PackageDir,
    [string]$NodePath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

# Fail-open by design: after an official update this launcher must not lock the
# user out of PiDeck. It warns that the local feature is inactive, then offers to
# start the currently installed program. It never modifies, installs, or kills.
try {
    $config = Get-ProjectConfig
    if (-not $ExePath) { $ExePath = $config.ExePath }
    if (-not $PackageDir) { $PackageDir = $config.PackageDir }
    $node = Resolve-NodePath $NodePath
    $status = Get-PatchStatus -ExePath $ExePath -PackageDir $PackageDir -NodePath $node
} catch {
    $message = "启动前检查失败：$($_.Exception.Message)`n`n你可以直接使用 PiDeck 官方图标启动；本次没有修改任何文件。"
    Write-PatchLog -Name 'launcher.log' -Text $message
    Show-PatchMessage -Text $message -Icon 'Warning' | Out-Null
    exit 1
}

if (-not $status.ok) {
    $message = "无法读取补丁状态：`n$($status.error)`n`n本次没有修改任何文件。是否仍以当前安装的 PiDeck 启动？"
    Write-PatchLog -Name 'launcher.log' -Text $message
    $answer = Show-PatchMessage -Text $message -Buttons 'YesNo' -Icon 'Warning'
    if ($answer -eq 'Yes') { Start-TargetPiDeck -ExePath $ExePath }
    exit 0
}

if ($status.launchAllowed) {
    Write-PatchLog -Name 'launcher.log' -Text "启动 PiDeck（$($status.state)）：$ExePath"
    Start-TargetPiDeck -ExePath $ExePath
    exit 0
}

# Known states that need a clear warning, not a silent launch.
$reason = switch ($status.state) {
    'clean' {
        "当前 PiDeck 是原版：本地补丁未安装，或已经恢复为原版。`n`n新聊天不会自动按日期和意图分类。"
    }
    'unknown-version' {
        "检测到 PiDeck 版本 $($status.version)，不是已验证的 0.12.0。`n`n为安全起见没有修改任何文件。此版本尚未适配，新聊天自动分类不会生效。"
    }
    'unknown-hash' {
        "当前安装文件的哈希与已知原版、已知补丁都不一致。`n`n为安全起见没有修改任何文件，也无法确认自动分类是否生效。"
    }
    default {
        "补丁状态为 $($status.state)。`n`n本次没有修改任何文件，无法确认自动分类是否生效。"
    }
}

$message = "$reason`n`n是否仍以当前安装的 PiDeck 启动？"
Write-PatchLog -Name 'launcher.log' -Text $message
$answer = Show-PatchMessage -Text $message -Buttons 'YesNo' -Icon 'Warning'
if ($answer -eq 'Yes') {
    Start-TargetPiDeck -ExePath $ExePath
}
exit 0
