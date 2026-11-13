# Shared helpers for the local PiDeck patch launchers. No polling, no auto-install,
# no process termination: every helper only reads state, waits, or starts an app.

$script:ProjectRoot = $PSScriptRoot

function Get-ProjectConfig {
    $configPath = Join-Path $script:ProjectRoot 'target.json'
    if (-not (Test-Path -LiteralPath $configPath)) {
        throw "缺少 target.json；请按 README 填写 PiDeck.exe 和补丁包路径。"
    }
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $config.exePath -or -not $config.packageDir) {
        throw "target.json 缺少 exePath 或 packageDir。"
    }
    return [pscustomobject]@{
        ExePath    = [IO.Path]::GetFullPath([string]$config.exePath)
        PackageDir = [IO.Path]::GetFullPath([string]$config.packageDir)
    }
}

function Resolve-NodePath([string]$NodePath) {
    if ($NodePath) {
        $found = Get-Command $NodePath -ErrorAction SilentlyContinue
        if ($found) { return $found.Source }
        throw "找不到指定的 Node.js：$NodePath"
    }
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw "找不到 Node.js。请安装 Node.js 22+，或用 -NodePath 指定 node.exe。" }
    return $node.Source
}

function Get-PatchStatus {
    param([string]$ExePath, [string]$PackageDir, [string]$NodePath)
    $cli = Join-Path $script:ProjectRoot 'cli.mjs'
    $raw = & $NodePath $cli status --exe $ExePath --package $PackageDir 2>&1
    $exitCode = $LASTEXITCODE
    $text = ($raw | Out-String).Trim()
    if ($exitCode -ne 0) {
        return [pscustomobject]@{ ok = $false; error = $text }
    }
    try {
        $status = $text | ConvertFrom-Json
    } catch {
        return [pscustomobject]@{ ok = $false; error = "无法解析 status 输出：$text" }
    }
    $status | Add-Member -NotePropertyName ok -NotePropertyValue $true -Force
    return $status
}

function Show-PatchMessage {
    param(
        [string]$Text,
        [string]$Title = 'PiDeck 本地补丁',
        [string]$Buttons = 'OK',
        [string]$Icon = 'Information'
    )
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        return [System.Windows.Forms.MessageBox]::Show($Text, $Title, $Buttons, $Icon)
    } catch {
        Write-Host $Text
        if ($Buttons -eq 'YesNo') { return 'Yes' }
        return 'OK'
    }
}

function Write-PatchLog {
    param([string]$Name, [string]$Text)
    try {
        $logDir = Join-Path $script:ProjectRoot 'logs'
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text
        Add-Content -LiteralPath (Join-Path $logDir $Name) -Value $line -Encoding UTF8
    } catch {
        # Logging must never block launching or installing.
    }
}

function Test-TargetPiDeckRunning([string]$ExePath) {
    $target = [IO.Path]::GetFullPath($ExePath)
    $hits = @(
        Get-CimInstance Win32_Process -Filter "Name='PiDeck.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.ExecutablePath -and
                ([IO.Path]::GetFullPath([string]$_.ExecutablePath) -ieq $target)
            }
    )
    return $hits.Count -gt 0
}

function Start-TargetPiDeck([string]$ExePath) {
    Start-Process -FilePath $ExePath -WorkingDirectory (Split-Path -Parent $ExePath)
}

function Wait-TargetPiDeckExit {
    param([string]$ExePath, [int]$ReportEverySeconds = 15)
    $started = Get-Date
    $lastReport = 0
    while (Test-TargetPiDeckRunning -ExePath $ExePath) {
        Start-Sleep -Seconds 2
        $elapsed = [int]((Get-Date) - $started).TotalSeconds
        if ($elapsed - $lastReport -ge $ReportEverySeconds) {
            $lastReport = $elapsed
            Write-Host ("仍在等待 PiDeck 退出（已等待 {0} 秒）。不会强制结束进程。" -f $elapsed)
        }
    }
}
