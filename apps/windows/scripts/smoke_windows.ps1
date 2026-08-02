param(
    [int]$StartupTimeoutSeconds = 45,
    [string]$EvidenceDirectory = "dist\smoke-evidence",
    [string]$ExecutablePath = "dist\ScreenCaptureReport\ScreenCaptureReport.exe"
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

if ($env:OS -ne "Windows_NT") {
    throw "This smoke test must run on Windows."
}

$exe = Resolve-Path $ExecutablePath
$dataDir = Join-Path $env:TEMP ("ScreenCaptureReport-smoke-" + [guid]::NewGuid())
$env:SCREEN_CAPTURE_REPORT_DATA_DIR = $dataDir
$env:SCREEN_CAPTURE_REPORT_STARTUP_DIAGNOSTICS = "1"
$process = $null
$secondProcess = $null
$viewerProcess = $null
$trayProcess = $null

try {
    $process = Start-Process $exe -PassThru
    $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    $configPath = Join-Path $dataDir "config.json"
    while ((Get-Date) -lt $deadline -and -not (Test-Path $configPath)) {
        if ($process.HasExited) {
            break
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not (Test-Path $configPath)) {
        $process.Refresh()
        Write-Host "Startup diagnostics:"
        [PSCustomObject]@{
            ProcessId = $process.Id
            HasExited = $process.HasExited
            MainWindowTitle = $process.MainWindowTitle
            Responding = $process.Responding
            RequestedDataDirectory = $dataDir
            DefaultDataDirectory = (Join-Path $env:LOCALAPPDATA "ScreenCaptureReport")
        } | Format-List | Out-String | Write-Host
        foreach ($candidate in @($dataDir, (Join-Path $env:LOCALAPPDATA "ScreenCaptureReport"))) {
            Write-Host "Contents of $candidate"
            Get-ChildItem $candidate -Recurse -Force -ErrorAction SilentlyContinue |
                Select-Object FullName, Length, LastWriteTime |
                Format-Table -AutoSize |
                Out-String |
                Write-Host
            $logPath = Join-Path $candidate "app.log"
            if (Test-Path $logPath) {
                Write-Host "Application log from $logPath"
                Get-Content $logPath -Tail 100 | Write-Host
            }
            $failurePath = Join-Path $candidate "startup-failure.txt"
            if (Test-Path $failurePath) {
                Write-Host "Redacted startup failure from $failurePath"
                Get-Content $failurePath | Write-Host
            }
        }
        if ($process.HasExited) {
            throw "ScreenCaptureReport exited during startup with code $($process.ExitCode)"
        }
        throw "Pre-consent configuration was not created within $StartupTimeoutSeconds seconds"
    }

    $config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($config.capture_paused -ne $true) {
        throw "Capture was not paused before consent"
    }
    if ($config.consent_version -or $config.consented_at) {
        throw "Consent was recorded before onboarding acceptance"
    }

    $databasePath = Join-Path $dataDir "screen-capture-report.sqlite3"
    if (-not (Test-Path $databasePath)) {
        throw "Database was not created: $databasePath"
    }
    $captureCount = & .\.venv\Scripts\python.exe -c `
        "import os, sqlite3; p=os.path.join(os.environ['SCREEN_CAPTURE_REPORT_DATA_DIR'], 'screen-capture-report.sqlite3'); c=sqlite3.connect('file:' + p + '?mode=ro', uri=True); print(c.execute('select count(*) from captures').fetchone()[0]); c.close()"
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to inspect the pre-consent capture table"
    }
    if ([int]$captureCount -ne 0) {
        throw "A capture row existed before consent"
    }
    $captureFiles = @(
        Get-ChildItem (Join-Path $dataDir "captures") -File -Recurse -ErrorAction SilentlyContinue
    )
    if ($captureFiles.Count -ne 0) {
        throw "A capture payload existed before consent"
    }

    $secondProcess = Start-Process $exe -PassThru
    if (-not $secondProcess.WaitForExit(10000)) {
        throw "A second process did not exit after the named mutex rejection"
    }
    if ($secondProcess.ExitCode -ne 0) {
        throw "The rejected second process exited with code $($secondProcess.ExitCode)"
    }

    $firstProcessRunning = -not $process.HasExited
    if ($firstProcessRunning) {
        Stop-Process -Id $process.Id -Force
        Wait-Process -Id $process.Id -ErrorAction SilentlyContinue
    }

    $seedCode = @'
import os
from pathlib import Path

from src.config import DPAPIFileSecretStore, SettingsStore

data_dir = Path(os.environ["SCREEN_CAPTURE_REPORT_DATA_DIR"])
settings_store = SettingsStore(data_dir / "config.json")
settings = settings_store.load()
settings.grant_consent()
settings_store.save(settings)

secrets = DPAPIFileSecretStore(data_dir / "secrets.dpapi.json")
for key, value in {
    "gemini_api_key": "synthetic-ci-key",
    "employee_id": "synthetic-ci-user",
    "department": "synthetic-ci-department",
    "privacy_contact": "synthetic-ci-contact",
}.items():
    secrets.set(key, value)
'@
    $seedCode | & .\.venv\Scripts\python.exe -
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to seed synthetic tray smoke configuration"
    }

    $env:SCREEN_CAPTURE_REPORT_VIEWER_SMOKE = "1"
    $viewerProcess = Start-Process $exe -ArgumentList "--viewer-smoke" -PassThru
    if (-not $viewerProcess.WaitForExit(15000)) {
        throw "Packaged employee archive viewer did not close after its smoke check"
    }
    if ($viewerProcess.ExitCode -ne 0) {
        throw "Packaged employee archive viewer exited with code $($viewerProcess.ExitCode)"
    }
    Remove-Item Env:SCREEN_CAPTURE_REPORT_VIEWER_SMOKE -ErrorAction SilentlyContinue

    $trayEvidencePath = Join-Path $dataDir "tray-evidence.json"
    Remove-Item $trayEvidencePath -Force -ErrorAction SilentlyContinue
    $env:SCREEN_CAPTURE_REPORT_TRAY_EVIDENCE = "1"
    $trayProcess = Start-Process $exe -PassThru
    $trayDeadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    while ((Get-Date) -lt $trayDeadline -and -not (Test-Path $trayEvidencePath)) {
        if ($trayProcess.HasExited) {
            break
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not (Test-Path $trayEvidencePath)) {
        $trayProcess.Refresh()
        if ($trayProcess.HasExited) {
            throw "Tray smoke process exited with code $($trayProcess.ExitCode)"
        }
        throw "Packaged tray setup evidence was not created within $StartupTimeoutSeconds seconds"
    }
    $trayEvidence = Get-Content $trayEvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($trayEvidence.visible -ne $true) {
        throw "Packaged tray setup did not request a visible notification icon"
    }
    if ($trayEvidence.service_started -ne $true) {
        throw "Capture service started without successful tray setup"
    }
    if ($trayProcess.HasExited) {
        throw "Packaged tray process exited after successful tray setup"
    }

    New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
    Copy-Item $trayEvidencePath (Join-Path $EvidenceDirectory "tray-evidence.json") -Force
    [PSCustomObject]@{
        Executable = $exe.Path
        DataDirectory = $dataDir
        FirstProcessRunning = $firstProcessRunning
        SecondProcessExitCode = $secondProcess.ExitCode
        CapturePausedBeforeConsent = $config.capture_paused
        ConsentVersionBeforeOnboarding = $config.consent_version
        CaptureRowsBeforeConsent = [int]$captureCount
        CaptureFilesBeforeConsent = $captureFiles.Count
        EmployeeArchiveViewerStarted = $viewerProcess.ExitCode -eq 0
        TrayVisibleRequested = $trayEvidence.visible
        TrayServiceStarted = $trayEvidence.service_started
        TrayProcessRunning = -not $trayProcess.HasExited
        Timestamp = (Get-Date).ToUniversalTime().ToString("o")
    } | ConvertTo-Json | Set-Content (Join-Path $EvidenceDirectory "startup-smoke.json")
} finally {
    Remove-Item Env:SCREEN_CAPTURE_REPORT_VIEWER_SMOKE -ErrorAction SilentlyContinue
    Remove-Item Env:SCREEN_CAPTURE_REPORT_TRAY_EVIDENCE -ErrorAction SilentlyContinue
    if ($secondProcess -and -not $secondProcess.HasExited) {
        Stop-Process -Id $secondProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    if ($viewerProcess -and -not $viewerProcess.HasExited) {
        Stop-Process -Id $viewerProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($trayProcess -and -not $trayProcess.HasExited) {
        Stop-Process -Id $trayProcess.Id -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "Startup, employee archive viewer, pre-consent fail-closed, single-instance, and packaged tray setup smoke passed."
Write-Host "Interactive tray visibility, capture, Win+L, and report E2E remain required."
