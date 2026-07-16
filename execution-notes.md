# Execution Notes

Updated: 2026-07-16

## Current state

- Branch: `blushup-windows`, created from fetched `origin/main` at `c6ce059bcbd513fc88c10810fc62f43c9d61f543`.
- Fable 5 Grill-me review: pass; decisions captured in `docs/decision-record.md`.
- Current phase: Windows runtime and local verification complete; real Windows execution evidence remains unavailable.

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
- A second environment audit found only stopped ARM Linux Colima instances. The GitHub repository has no existing workflow or registered Windows runner; the AWS SSO and GCP sessions are expired. `.github/workflows/windows-ci.yml` is actionlint-clean and ready to build/smoke on `windows-2022` after push is explicitly authorized, but it has not been run and cannot replace target Windows 10/11 interaction evidence. All PowerShell files parse with official PowerShell 7.6.3, native quality/build commands now fail closed on non-zero exit codes, and the hashed lock passes pip's `--require-hashes` dry run on the current platform.

## Blocked or unverified

- Real Windows installation/E2E remains unverified because no interactive Windows 10/11 environment was found. The third consecutive goal-turn audit found the same state: no local Windows VM/image, no existing GitHub Windows runner/workflow, expired AWS/GCP sessions, and no reachable Tailscale peer. Code-level mocks and the unexecuted Windows Server workflow are not substituted for this evidence, so the persistent goal is blocked rather than declared Done.
- Safe Gemini/SMTP credentials and a labelled accuracy sample were not found or accessed; live accuracy, live cost, and live delivery remain unmeasured rather than passed.

## Exact unblock and rerun procedure

1. Make a clean interactive Windows 10 22H2 or Windows 11 x64 test account available, locally or through an already-approved remote environment. It must permit tray interaction, Win+L, restart, multiple-monitor testing, and per-user install/uninstall. A Windows Server CI runner alone is insufficient.
2. Place this branch on that machine without exposing credentials. If branch push is explicitly authorized, first run the `Windows verification` workflow and retain its artifact as supporting evidence; push remains unperformed in the current state.
3. Use dedicated non-production Gemini and SMTP credentials plus synthetic screen content and a labelled sample. Never use production employee data for the POC verification.
4. Run `scripts/build_windows.ps1`, then `scripts/smoke_windows.ps1`, then every item in `docs/windows-e2e-checklist.md`. Save redacted logs, screenshots, reports, installer hashes, and command output under `e2e-evidence/<date>/` without committing credentials or personal data.
5. Run `src.cli metrics`, `export-labels`, and `accuracy`; require measured capture success of at least 95%, labelled category agreement of at least 80%, and measured total cost of at most 100 JPY/person-day. Missing measurements remain failures.
6. Re-run pytest, ruff, mypy, dependency audit, secret scan, actionlint, and the independent read-only adversarial review. Only then reconsider Done.
