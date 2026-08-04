# Windows 10/11 E2E Evidence Checklist

Run on a clean Windows 10 22H2 or Windows 11 x64 user account. Save command output, screenshots, the generated installer/hash, redacted application logs, and redacted report artifacts under `e2e-evidence/<date>/`. Never commit credentials, screenshots containing real personal data, or decrypted reports.

1. Run `scripts/build_windows.ps1`; record Python version, test output, artifact names, sizes, and SHA-256 hashes. If the branch has been explicitly authorized for push, retain the `Windows verification` Actions artifact too; its Windows Server smoke is supporting evidence, not target-desktop E2E.
2. Install per-user without elevation. Confirm Start Menu entry and that startup remains opt-in.
3. Launch. Before consent, confirm no capture file or `captured` row appears.
4. Complete onboarding with a dedicated test Gemini credential and synthetic test account. Confirm the key is in Windows Credential Manager and absent from config, DB, logs, and package files.
5. Confirm the icon appears in the Windows notification area (including the `^` overflow) before capture starts, the tooltip says `Screen Capture Report - 取得中`, pause/resume changes the state, and the paused icon is grey. Restart Windows Explorer and confirm the visible icon is re-registered; exit the app and confirm the icon disappears.
6. With a synthetic test window active, collect at least five automatic captures. Confirm eligible timestamp deltas are 55–65 seconds. Confirm a weekend/non-workday and an invalid overnight schedule cannot create an automatic eligible period.
7. Exercise active-window and all-monitor modes with synthetic content. Put an allowed window in front and an excluded password-manager window on monitor 2; confirm the entire all-monitor interval fails closed before pixels are read. Confirm allowed captures are encrypted at rest and cannot be opened as PNG files.
8. Open an excluded process/title and an access-denied synthetic process. Confirm status `excluded`, no capture payload, and only an opaque rule ID—never the process/title value—in DB/logs.
9. Exercise five-minute idle and Win+L lock. Confirm `idle`/`locked`, no payload, and exclusion from the success-rate denominator.
10. Disconnect network, capture, force analysis, restart the app, reconnect, and confirm the persisted queue is retried successfully.
11. Confirm analyzed capture payloads remain encrypted and viewable in the employee archive for up to 24 hours, then are deleted with a retention audit event.
12. Generate the daily employee report after configured work end and send it to the dedicated test mailbox. Confirm late-day logs are included, TLS rejects an invalid/self-signed server certificate, and send audit/recovery works after one induced SMTP failure.
13. Generate a previous-week management report. Confirm all three sections and evidence IDs; scan for images, raw titles, ranking, and minute-level individual activity. Induce a Gemini outage, restart, and confirm `report_jobs.next_retry_at` prevents 15-second retry hammering and increases the bounded backoff.
14. Pause and restart Windows; confirm capture stays paused. Resume, launch a second executable instance, and confirm the named mutex prevents duplicate schedules. If autostart was selected, confirm tray recovery.
15. Uninstall with and without `-DeleteUserData`; verify the selected data behavior and Credential Manager cleanup procedure.
16. Attempt cross-audience report reads through the application interface. Confirm the employee tray cannot list management reports and management output cannot access images, raw logs, or daily reports.
17. Run labelled-sample accuracy and cost reports. Introduce a known process-downtime gap and a duplicate attempt; confirm metrics count missing expected intervals and flag duplicates. Record measured values; never mark missing measurements as passed.
18. Build without Inno Setup, extract only the produced zip on a clean account, and run `scripts\install.ps1`; confirm the fallback package is self-contained.
