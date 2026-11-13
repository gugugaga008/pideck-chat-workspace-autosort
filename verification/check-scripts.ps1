$ErrorActionPreference = 'Stop'
$files = @('lib.ps1','Start-PiDeck.ps1','Install-After-Exit.ps1','Restore-After-Exit.ps1')
foreach ($file in $files) {
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Split-Path -Parent $PSScriptRoot) $file), [ref]$null, [ref]$errors)
    if ($errors.Count -gt 0) {
        Write-Host ($file + ' FAILED')
        $errors | ForEach-Object { Write-Host ($_.Message) }
        exit 1
    }
    Write-Host ($file + ' OK')
}
