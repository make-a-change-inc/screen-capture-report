# Screen Capture Report for Windows — POC Requirements

Status: Fable 5 Grill-me decisions applied on 2026-07-16.

## Product boundary

The product is a per-user Windows 10 22H2 / Windows 11 x64 desktop application for workflow improvement. It is not an employee-ranking, disciplinary, or continuous-surveillance product. The purpose limitation must be visible during onboarding and in generated reports.

The POC supports one local employee profile per Windows account. Raw captures, raw work logs, and employee reports remain on that account. Management output contains category-level aggregates and recommendations only; it never contains screenshots, raw window titles, or minute-by-minute individual activity.

## Functional requirements and acceptance

| ID | Requirement | Acceptance evidence |
|---|---|---|
| FR-001 | Per-user Windows installation and startup | A clean Windows 10 22H2 or Windows 11 x64 account can install, onboard, launch the tray app, restart it, and uninstall it without administrator rights. |
| FR-002 | Capture once per minute while eligible | Successful capture timestamps are normally 60 seconds apart on configured work weekdays/hours. Paused, outside-hours, locked, idle, excluded, and failed intervals are stored as distinct statuses. |
| FR-003 | AI analysis into structured work logs | Each analyzed capture is traceable by capture ID to a category, summary, confidence, and estimated duration. Failures remain retryable after restart. |
| FR-004 | Daily category totals | The app produces per-day category durations, including unclassified time, from persisted work logs. |
| FR-005 | Weekly improvement analysis | The weekly result contains improvement methods, AI candidates, expected productivity impact, assumptions, and evidence log IDs for the selected week. |
| FR-006 | Management report | A separate encrypted HTML/Markdown management artifact identifies the week and contains aggregates/recommendations without captures, raw titles, or individual ranking. |
| FR-007 | Employee daily report | A local encrypted daily report contains the employee's categories, durations, and activity summaries. |
| FR-008 | Employee report email | When an employee SMTP destination is configured, the daily report can be sent and the destination, date, status, and retry state are auditable. |
| FR-012 | Collection control | The tray visibly distinguishes running and paused states and provides start, pause, stop/quit, manual capture, schedule, and settings controls. Capture cannot start before explicit onboarding consent. |
| FR-013 | Sensitive-window exclusion | Configurable process/title rules prevent capture before pixels are read. Exclusion records contain only the rule ID, never the matching title. |
| FR-014 | Role/audience access separation | The employee tray exposes only the employee daily-report reader; management receives only the weekly aggregate output; deployment administration exposes no content reader. Database readers reject cross-audience report IDs, and tests reject screenshots, raw titles, and individual rankings in management output. |
| FR-015 | Retention and deletion | Captures are deleted immediately after successful analysis by default (debug maximum 24 hours); derived logs/summaries default to 30 days and reports to 90 days. Deletion is recorded without retaining deleted content. |

FR-009 is satisfied only to the extent that weekly recommendations carry a proposal type, expected effect, and assumptions. FR-010 and FR-011 are out of scope. The app must not expose switches that enable ranking, appraisal, discipline, or raw management surveillance.

## Windows and privacy behavior

- Default capture mode: active window. All-monitor capture is supported as an explicit setting.
- Locked sessions are not captured. No-input periods longer than five minutes are recorded as idle and not captured; the threshold is configurable.
- Automatic capture runs only within configured work hours. Outside-hours capture requires an explicit manual action.
- Work weekdays are configurable and default to Monday–Friday. Overnight work windows are rejected in this POC so capture, daily aggregation, and finalization share one unambiguous calendar-day boundary.
- Offline capture may continue locally, but analysis, weekly AI generation, and email are queued in SQLite with bounded exponential backoff and survive restart.
- The default deny list covers password managers and title keywords related to passwords, payroll, HR, and medical data. Users can add rules.
- Captures are resized to a maximum 1280-pixel long edge before AI transmission.
- API keys and SMTP credentials are stored in Windows Credential Manager. Sensitive local payloads are encrypted with Fernet; the Fernet key is protected with Windows DPAPI.
- Sensitive text is never written to operational logs. Logs may contain IDs, statuses, counts, sizes, and redacted error classes.
- AI provider retention, training, subprocessors, and international transfer are contractual facts the application cannot guarantee. They remain a POC approval gate; data minimization is the implemented mitigation.

## Data and reporting

The authoritative local store is SQLite under `%LOCALAPPDATA%\ScreenCaptureReport`. It contains capture state, active/pause control events, encrypted work logs, daily summaries, weekly reports, send attempts, cost events, and retention audit events. Encrypted capture files and encrypted report artifacts live under the same application directory.

The default category list is editable and starts with: email, chat/meeting, document creation, development/technical work, research/browsing, data entry/administration, customer support, management/planning, break/idle, and other.

Daily employee reports are generated after the configured work end plus the bounded analysis-batch wait; pending analysis defers generation so the report is not silently partial. Missed daily reports are recovered at next launch. Completed Monday–Sunday weekly reports are recovered on any later weekday while source logs remain available. Email delivery occurs only for configured destinations; weekly file generation is mandatory even without a management email address.

## Quality and measurement

- Capture success rate: at least 95% of intervals inside persisted active control periods and configured work weekdays/hours. Paused, locked, idle, excluded, and outside-hours intervals are not eligible; missing slots while active are failures rather than silently absent rows.
- Category agreement: at least 80% against a human-labelled sample. The app must export a labelling CSV and calculate agreement; no sample means unmeasured, not passed.
- Cost: at most JPY 100 per employee-day across analysis, daily, weekly, and optional diagram API calls. Usage and configured unit prices are recorded; missing live usage means estimated/unmeasured, not passed.
- Every success, failure, timeout, retry, restart recovery, exclusion, and retention path has automated evidence.
- Completion requires a real Windows environment installation and end-to-end run. macOS mocks and a PyInstaller spec alone are supporting evidence only.

## POC gates outside application code

The target company, department, participant count, POC dates, legal basis, employee notice/consultation, Gemini contractual settings, signing certificate, and production distribution remain outside this branch. The unrelated October statement is not a schedule requirement. Missing business decisions do not block local application implementation, but legal/contractual approval blocks real employee-data use.
