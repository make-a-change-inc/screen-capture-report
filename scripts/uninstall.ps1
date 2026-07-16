param([switch]$DeleteUserData)

$ErrorActionPreference = "Stop"
$destination = Join-Path $env:LOCALAPPDATA "Programs\ScreenCaptureReport"
$data = Join-Path $env:LOCALAPPDATA "ScreenCaptureReport"
$shortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Screen Capture Report.lnk"

Get-Process ScreenCaptureReport -ErrorAction SilentlyContinue | Stop-Process -Force
if (Test-Path (Join-Path $destination "ScreenCaptureReport.exe")) {
    & (Join-Path $destination "ScreenCaptureReport.exe") --prepare-uninstall
}
Remove-Item $destination -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $shortcut -Force -ErrorAction SilentlyContinue
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" `
    -Name "ScreenCaptureReport" -ErrorAction SilentlyContinue

if ($DeleteUserData) {
    Remove-Item $data -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Uninstalled. User data deleted: $DeleteUserData"
