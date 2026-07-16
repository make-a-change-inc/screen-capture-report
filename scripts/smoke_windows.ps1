param(
    [int]$StartupTimeoutSeconds = 45,
    [string]$EvidenceDirectory = "dist\smoke-evidence"
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

if ($env:OS -ne "Windows_NT") {
    throw "This smoke test must run on Windows."
}

$exe = Resolve-Path "dist\ScreenCaptureReport\ScreenCaptureReport.exe"
$dataDir = Join-Path $env:TEMP ("ScreenCaptureReport-smoke-" + [guid]::NewGuid())
$env:SCREEN_CAPTURE_REPORT_DATA_DIR = $dataDir
$env:SCREEN_CAPTURE_REPORT_STARTUP_DIAGNOSTICS = "1"
$process = $null
$secondProcess = $null

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

    $config = Get-Content $configPath -Raw | ConvertFrom-Json
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

    New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
    [PSCustomObject]@{
        Executable = $exe.Path
        DataDirectory = $dataDir
        FirstProcessRunning = -not $process.HasExited
        SecondProcessExitCode = $secondProcess.ExitCode
        CapturePausedBeforeConsent = $config.capture_paused
        ConsentVersionBeforeOnboarding = $config.consent_version
        CaptureRowsBeforeConsent = [int]$captureCount
        CaptureFilesBeforeConsent = $captureFiles.Count
        Timestamp = (Get-Date).ToUniversalTime().ToString("o")
    } | ConvertTo-Json | Set-Content (Join-Path $EvidenceDirectory "startup-smoke.json")
} finally {
    if ($secondProcess -and -not $secondProcess.HasExited) {
        Stop-Process -Id $secondProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "Startup, pre-consent fail-closed, and single-instance smoke passed."
Write-Host "Interactive tray, capture, DPAPI, Win+L, and report E2E remain required."
