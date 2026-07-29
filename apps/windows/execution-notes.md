# Execution Notes

Updated: 2026-07-16

## Current state

- Branch: `blushup-windows`, created from fetched `origin/main` at `c6ce059bcbd513fc88c10810fc62f43c9d61f543`.
- Fable 5 Grill-me review: pass; decisions captured in `docs/decision-record.md`.
- Current phase: Windows runtime, CI, and packaged tray setup verification complete; the user has an interactive UTM Windows environment and must confirm the corrected 0.2.1 icon visually.

## Open items

- [x] Replace Mac runtime with Windows tray/onboarding/settings.
- [x] Implement Windows capture eligibility, exclusions, encrypted capture storage, and status records.
- [x] Implement structured AI analysis, persistent retry queue, and cost ledger.
- [x] Implement daily employee and weekly management reports with audience checks.
- [x] Implement secret storage, retention, audit, packaging, install/uninstall, and startup opt-in.
- [x] Add unit, integration, contract, and restart-recovery tests.
- [x] Add a no-secret Windows Actions build/smoke workflow and automated pre-consent/single-instance evidence collection for use after push is authorized.
- [ ] Build and execute the Windows E2E checklist in a real Windows environment.
- [x] Run an independent read-only adversarial review and resolve code-level P0/P1 findings.

## Evidence

- `git fetch --prune origin` completed; `origin/main` resolved to `c6ce059bcbd513fc88c10810fc62f43c9d61f543`.
- Repository inspection confirmed the original runtime depends on rumps, Quartz/Cocoa, AppleScript, and py2app; no pytest/CI suite existed.
- Independent read-only adversarial review ran multiple rounds and finished with no code-level P0/P1 findings. Findings drove fail-closed all-monitor exclusion, verified SMTP TLS, atomic/concurrency-safe analysis, persisted fail-safe active/pause periods, a Windows mutex, complete report recovery, report-generation backoff, cadence-gap metrics, unclassified time, 24-hour pending-image enforcement, audience capabilities, a self-contained zip fallback, failed-AI-attempt cost audit, and best-effort uninstall cleanup that still purges secrets when the database is corrupt and reports Credential Manager deletion failures.
- `pytest --cov=src`: 57 passed; aggregate macOS-side contract coverage 63%, with Windows UI/API paths reserved for E2E.
- `ruff check src tests`: pass.
- `mypy src`: pass with no issues in 17 source files.
- `compileall`, spec `py_compile`, dependency compatibility, and `git diff --check`: pass.
- `pip-audit`: no known vulnerabilities in the pinned lock. `cryptography` is fixed at 48.0.1 after resolving GHSA-537c-gmf6-5ccf.
- Reproducible universal dependency lock with hashes created with `google-genai==1.75.0`, `pywin32==312` on Windows, and PyInstaller 6.21.0. A Windows-target dry resolution succeeds with 56 packages.
- Local Windows-environment discovery: no Parallels, VMware, UTM, VirtualBox, tart, QEMU, Wine, or Windows VM image found. Docker is installed but its daemon is unavailable and cannot provide a Windows desktop kernel on macOS. Tailscale CLI could not reach its local daemon, so no existing Windows peer was verified.
- A second environment audit found only stopped ARM Linux Colima instances. The GitHub repository initially had no workflow or registered Windows runner; the AWS SSO and GCP sessions were expired. `.github/workflows/windows-ci.yml` is actionlint-clean and targets GitHub-hosted `windows-2022`, but it cannot replace target Windows 10/11 interaction evidence. All PowerShell files parse with official PowerShell 7.6.3, native quality/build commands fail closed on non-zero exit codes, and the hashed lock passes pip's `--require-hashes` dry run on the current platform.
- Push was authorized and Windows Actions run `29503406568` started successfully. Dependency installation completed, then Windows PowerShell 5.1 converted native stderr into a terminating `NativeCommandError` before the wrapper could inspect the process exit code. The wrapper now temporarily treats native stderr as non-terminating while preserving it in logs, then fails exclusively from the captured native exit code; a replacement Windows run is required.
- Replacement run `29503552444` confirmed dependency installation, ruff, and native exit-code handling on Windows, then mypy correctly rejected a platform-dependent unused `type: ignore` on `os.startfile`. The call now uses runtime attribute lookup so the same strict mypy configuration is valid on both macOS and Windows; another replacement run is required.
- Run `29503685373` passed Windows dependency installation, ruff, mypy, all 57 tests, PyInstaller, and zip packaging. Its packaged startup smoke timed out before the pre-consent config appeared. The next smoke run allows 45 seconds and emits process/window state, both the requested and default data-directory trees, and redacted application logs so the actual startup boundary can be diagnosed without weakening the assertion.
- Run `29504066913` reproduced a pre-config packaged exception: the process remained responsive in an `Unhandled exception in script` window and the requested data directory contained only an empty `app.log`. CI startup diagnostics now record only the exception class and traceback frame basenames/lines/functions—never the exception message, locals, or full paths—and exit without leaving a modal dialog so the exact failing startup frame can be recovered safely.
- Run `29504378172` localized the packaged exception to `WindowsDPAPIProtector.protect` writing the initial encrypted key. The implementation incorrectly indexed `CryptProtectData` as though it returned the same tuple as `CryptUnprotectData`; pywin32 returns protected `bytes` directly while unprotect returns `(description, bytes)`. The wrapper and a contract regression test now match those asymmetric return types.
- Run `29504601201` passed on GitHub-hosted Windows: dependency installation, ruff, mypy, all 59 tests, PyInstaller, Inno Setup installer creation, packaged pre-consent fail-closed checks, DPAPI initial-key creation, named-mutex single-instance rejection, evidence collection, and artifact upload. The uploaded artifact ID is `8377952597` and its archive SHA-256 is `a2843f6c4376d85506f8d80b8cfb903068956905d40e27177885f12167521402`. The workflow now also prints compact executable/installer hashes and startup-smoke JSON directly into the run log for independently readable evidence on the next run.
- Interactive UTM execution of 0.2.0 exposed a tray regression: the packaged process remained alive after onboarding but no notification icon was registered. The custom pystray setup callback replaced pystray's default `visible = True` callback and did not perform that required assignment. Commit `d04728c` now makes the icon visible before starting the capture service, fails closed if visibility setup raises, records opt-in non-sensitive tray smoke evidence, and relies on pystray's existing `TaskbarCreated` handler for Explorer restarts.
- Run `29594165022` passed on GitHub-hosted Windows: PowerShell parsing, ruff, mypy, all 62 tests, PyInstaller, Inno Setup 0.2.1 creation, pre-consent fail-closed behavior, DPAPI seed, single-instance rejection, and packaged tray setup. Its smoke evidence recorded `TrayVisibleRequested=true`, `TrayServiceStarted=true`, and `TrayProcessRunning=true`. The installer is `ScreenCaptureReport-Setup-0.2.1-x64.exe`, size `28572504`, SHA-256 `784A5B44FA1613274276A577A1B9C6851F5C19E522EF108ABA56FE3FCD43CAB2`; artifact ID `8412349863`.

## Blocked or unverified

- An interactive Windows environment is now available through UTM. The original 0.2.0 icon absence is reproduced and fixed in 0.2.1, but user-visible notification-area registration, pause/resume color, Explorer restart recovery, and exit removal still require confirmation in that UTM session. Code-level tests and Windows Server CI are not substituted for this visual evidence.
- Safe Gemini/SMTP credentials and a labelled accuracy sample were not found or accessed; live accuracy, live cost, and live delivery remain unmeasured rather than passed.

## Exact unblock and rerun procedure

1. Make a clean interactive Windows 10 22H2 or Windows 11 x64 test account available, locally or through an already-approved remote environment. It must permit tray interaction, Win+L, restart, multiple-monitor testing, and per-user install/uninstall. A Windows Server CI runner alone is insufficient.
2. Place this branch on that machine without exposing credentials. If branch push is explicitly authorized, first run the `Windows verification` workflow and retain its artifact as supporting evidence; push remains unperformed in the current state.
3. Use dedicated non-production Gemini and SMTP credentials plus synthetic screen content and a labelled sample. Never use production employee data for the POC verification.
4. Run `scripts/build_windows.ps1`, then `scripts/smoke_windows.ps1`, then every item in `docs/windows-e2e-checklist.md`. Save redacted logs, screenshots, reports, installer hashes, and command output under `e2e-evidence/<date>/` without committing credentials or personal data.
5. Run `src.cli metrics`, `export-labels`, and `accuracy`; require measured capture success of at least 95%, labelled category agreement of at least 80%, and measured total cost of at most 100 JPY/person-day. Missing measurements remain failures.
6. Re-run pytest, ruff, mypy, dependency audit, secret scan, actionlint, and the independent read-only adversarial review. Only then reconsider Done.
