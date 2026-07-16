$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$exe = Resolve-Path "dist\ScreenCaptureReport\ScreenCaptureReport.exe"
$process = Start-Process $exe -PassThru
Start-Sleep -Seconds 8
if ($process.HasExited) {
    throw "ScreenCaptureReport exited during startup with code $($process.ExitCode)"
}

$dataDir = Join-Path $env:LOCALAPPDATA "ScreenCaptureReport"
if (-not (Test-Path $dataDir)) {
    throw "Data directory was not created: $dataDir"
}

Stop-Process -Id $process.Id -Force
Write-Host "Startup smoke passed. Interactive onboarding and tray E2E remain required."
