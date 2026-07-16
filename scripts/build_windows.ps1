$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

if ($env:OS -ne "Windows_NT") {
    throw "This build must run on Windows 10/11. PyInstaller cannot cross-build Windows binaries."
}

py -3.12 -m venv .venv
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install -r requirements-lock.txt
& .\.venv\Scripts\python.exe -m ruff check src tests
& .\.venv\Scripts\python.exe -m mypy src
& .\.venv\Scripts\python.exe -m pytest
& .\.venv\Scripts\python.exe -m PyInstaller --clean --noconfirm ScreenCaptureReport.spec

$iscc = Get-Command iscc.exe -ErrorAction SilentlyContinue
if ($iscc) {
    & $iscc.Source installer\ScreenCaptureReport.iss
    Write-Host "Installer created under dist\installer"
} else {
    $package = "dist\zip-package"
    Remove-Item $package -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path "$package\scripts" -Force | Out-Null
    Copy-Item "dist\ScreenCaptureReport" "$package\ScreenCaptureReport" -Recurse -Force
    Copy-Item "scripts\install.ps1", "scripts\uninstall.ps1" "$package\scripts" -Force
    Copy-Item "README.md" "$package\README.md" -Force
    Compress-Archive -Path "$package\*" -DestinationPath dist\ScreenCaptureReport-windows-x64.zip -Force
    Write-Host "Inno Setup not found; created zip fallback. Use scripts\install.ps1."
}
