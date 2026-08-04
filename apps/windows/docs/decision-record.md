# Windows POC Decision Record

Decisions were produced by the Fable 5 read-only Grill-me review and reconciled with the repository on 2026-07-16. Codex owns implementation and verification.

| Topic | Decision | Rejected alternatives and reason |
|---|---|---|
| Purpose | Workflow improvement only; no appraisal, discipline, ranking, or continuous-surveillance capability. | A configurable HR mode creates unacceptable misuse risk and contradicts the agreed scope. |
| Architecture | Per-user local desktop application and local SQLite store. | A new server/RBAC platform expands the POC, attack surface, and credentials without being necessary. |
| Audience separation | Employee raw data stays local; management receives category aggregates and recommendations only. | Sharing screenshots or raw titles violates data minimization. |
| Consent | First capture is gated on explicit onboarding consent; current Mac auto-start behavior is removed. | Capture before consent is incompatible with the privacy-first requirement. |
| Capture modes | Active window by default; optional stitched all-monitor mode. | Periodic forced full-screen capture can collect unrelated sensitive screens. |
| Ineligible states | Do not capture when paused, outside work hours, locked, idle, or excluded. Persist the state instead. | Black/locked screenshots have no analytic value; outside-hours auto-capture is unsafe. |
| Work calendar | Default to Monday–Friday configurable weekdays and require same-day start/end times for the POC. | Overnight shifts need shift-date semantics across capture, aggregation, and delivery; silently mixing calendar-day and shift-day boundaries is unsafe. |
| Exclusion | Apply process/title deny rules before pixel capture and store only rule IDs for matches. | Post-capture masking may leak pixels before the mask and is too failure-prone for the POC. |
| Capture retention | Encrypt locally; delete after successful analysis by default, with an explicit debug maximum of 24 hours. | Long raw-image retention creates the largest avoidable breach impact. |
| Derived retention | Logs/summaries 30 days; reports 90 days; every deletion is audited. | Indefinite retention has no POC justification. |
| Secrets | Windows Credential Manager through keyring, with DPAPI as the Windows protection boundary. | Plain `.env` files expose long-lived credentials. |
| Sensitive storage | Fernet encryption for image/report payloads and sensitive SQLite text; Fernet key protected by DPAPI. | Plain SQLite and PNG files do not satisfy NFR-008; SQLCipher adds avoidable build complexity. |
| Categories | Editable JSON list with ten safe defaults; Gemini returns structured JSON. | Free-form text cannot produce reliable duration totals or traceability. |
| Reports | Daily employee HTML plus email when configured; weekly management HTML/Markdown file always generated, email optional. | Requiring an unknown management recipient would invent external state. |
| Recovery | Persist capture/analysis/send state in SQLite and retry with bounded exponential backoff after restart. | Memory-only queues lose evidence and work on crash. |
| Cost | Record all model usage and calculate JPY/employee-day from configured prices. | Image-only estimates omit daily and weekly model calls. |
| Windows UI | `pystray` tray with Pillow icons and `tkinter` onboarding/settings. Use PySide6 only after three evidenced pystray packaging failures. | Shipping PySide6 initially increases bundle and maintenance cost without evidence it is needed. |
| Packaging | PyInstaller onedir and per-user Inno Setup installer; zip + PowerShell installer is the fallback. Startup is opt-in. | MSIX/signing and auto-update require certificates/infrastructure outside the POC. |
| Mac assets | Remove Mac binaries, AppleScript, py2app configuration, and Mac-only documentation from the Windows branch. | A legacy folder would retain misleading distributable binaries; Git history already provides recovery. |
| FR-009/010/011 | Minimal proposal metadata inside FR-005; no character perspectives or HR comparisons. | They do not improve the required end-to-end path and lack accepted evidence rules. |

## Unverified external boundaries

- Gemini provider training/retention and contractual safeguards.
- Live category agreement and live JPY cost without an approved labelled sample and safe API credential.
- SMTP delivery without a safe configured destination.
- Code signing and production distribution.
- Actual Windows E2E until a Windows 10/11 interactive environment is located.

These boundaries must not be silently represented as passed. They do not permit weakening automated contract tests or replacing real Windows E2E evidence with macOS-only mocks.
