param([switch]$EnableAutostart)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent
$source = Join-Path $repoRoot "dist\ScreenCaptureReport"
if (-not (Test-Path $source)) {
    $source = Join-Path $repoRoot "ScreenCaptureReport"
}
$destination = Join-Path $env:LOCALAPPDATA "Programs\ScreenCaptureReport"

if (-not (Test-Path $source)) {
    throw "Build output not found: $source"
}

New-Item -ItemType Directory -Path $destination -Force | Out-Null
Copy-Item "$source\*" $destination -Recurse -Force

$shell = New-Object -ComObject WScript.Shell
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$shortcut = $shell.CreateShortcut((Join-Path $startMenu "Screen Capture Report.lnk"))
$shortcut.TargetPath = Join-Path $destination "ScreenCaptureReport.exe"
$shortcut.WorkingDirectory = $destination
$shortcut.Save()

if ($EnableAutostart) {
    New-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" `
        -Name "ScreenCaptureReport" -Value ('"' + (Join-Path $destination "ScreenCaptureReport.exe") + '"') `
        -PropertyType String -Force | Out-Null
}

Write-Host "Installed per-user to $destination"
