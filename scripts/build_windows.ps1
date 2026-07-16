$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @()
    )
    # Windows PowerShell 5.1 converts native stderr into ErrorRecord objects.
    # Keep those records visible without letting ErrorActionPreference stop the
    # script before the authoritative native exit code can be inspected.
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $FilePath @ArgumentList
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -ne 0) {
        throw "$FilePath exited with code $exitCode"
    }
}

if ($env:OS -ne "Windows_NT") {
    throw "This build must run on Windows 10/11. PyInstaller cannot cross-build Windows binaries."
}

$pyLauncher = Get-Command py.exe -ErrorAction SilentlyContinue
if ($pyLauncher) {
    Invoke-NativeCommand -FilePath $pyLauncher.Source -ArgumentList @("-3.12", "-m", "venv", ".venv")
} else {
    $bootstrapPython = (Get-Command python.exe -ErrorAction Stop).Source
    $version = & $bootstrapPython -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
    if ($LASTEXITCODE -ne 0 -or $version -ne "3.12") {
        throw "Python 3.12 is required"
    }
    Invoke-NativeCommand -FilePath $bootstrapPython -ArgumentList @("-m", "venv", ".venv")
}

$python = (Resolve-Path ".\.venv\Scripts\python.exe").Path
Invoke-NativeCommand -FilePath $python -ArgumentList @(
    "-m", "pip", "install", "--require-hashes", "-r", "requirements-lock.txt"
)
Invoke-NativeCommand -FilePath $python -ArgumentList @("-m", "ruff", "check", "src", "tests")
Invoke-NativeCommand -FilePath $python -ArgumentList @("-m", "mypy", "src")
Invoke-NativeCommand -FilePath $python -ArgumentList @("-m", "pytest")
Invoke-NativeCommand -FilePath $python -ArgumentList @(
    "-m", "PyInstaller", "--clean", "--noconfirm", "ScreenCaptureReport.spec"
)

if (-not (Test-Path "dist\ScreenCaptureReport\ScreenCaptureReport.exe")) {
    throw "PyInstaller did not produce the expected executable"
}

$iscc = Get-Command iscc.exe -ErrorAction SilentlyContinue
if ($iscc) {
    Invoke-NativeCommand -FilePath $iscc.Source -ArgumentList @("installer\ScreenCaptureReport.iss")
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
