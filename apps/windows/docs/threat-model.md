# POC Threat Model

## Assets

- Screen pixels before and after resizing
- Foreground process/title metadata
- Structured work logs, durations, confidence, and evidence IDs
- Employee email and management destination
- Gemini API key and SMTP credential
- Daily and weekly reports
- Encryption key and deletion/audit state

## Trust boundaries

1. Windows desktop and the per-user application process
2. Current user's DPAPI and Windows Credential Manager boundary
3. Local encrypted files and row-encrypted SQLite fields
4. TLS connection to Gemini
5. TLS connection to SMTP
6. Employee report audience
7. Management aggregate-report audience

## Material threats and controls

| Threat | Control | Residual risk / evidence |
|---|---|---|
| Capture begins without knowledge or consent | Blocking onboarding consent plus visible tray state and pause/quit | Windows E2E must prove no pre-consent payload |
| Required identity/key is missing after partial onboarding | Required secrets are written first; consent is the final commit marker; startup rechecks all required secrets and forces pause/onboarding when any are absent | Credential Manager and DPAPI failure injection requires Windows E2E |
| Sensitive app captured | Process/title deny rules execute before `mss.grab`; all-monitor mode first enumerates every visible top-level window and fails closed if process inspection fails; exclusion stores rule ID only | Windows compositor/secure-desktop behavior still requires real multi-monitor testing |
| Locked/idle/private time captured | OpenInputDesktop lock check, GetLastInputInfo idle check, work-hour gate, manual pause | EDR/VDI behavior requires target-environment testing |
| Raw image breach | Fernet encryption, DPAPI-protected key, resize before API, immediate post-analysis deletion, 24-hour hard cap | Malware in the same user session may still access decrypted memory |
| Credential disclosure | Credential Manager first; individually DPAPI-protected fallback; no `.env`; purge on uninstall | Keyring backend and uninstaller must be verified on real Windows |
| Behaviour data read from copied DB | Summaries, titles, destinations, and report bodies are encrypted | Status, timestamps, category identifiers, and durations remain queryable metadata in the POC SQLite design |
| Queue loss after crash/offline | SQLite capture/send queues, retry counters, next-attempt timestamps, restart tests | Filesystem corruption is not covered by remote backup because remote backup expands exposure |
| Downtime or explicit stop is miscounted as work | Persisted active/pause control events bound success-rate and unclassified-time calculations; quit persists pause; configured weekdays exclude non-workdays | Abrupt power loss while marked active is conservatively treated as missing collection during configured work time |
| Management surveillance | Separate aggregate report, no image/title input to weekly model, content scanner, audience-constrained report readers, and no management report menu or generic DB handle in the tray | A hostile process executing as the same Windows user is outside this per-user POC role model; production multi-tenant RBAC needs a server identity boundary |
| AI hallucinated recommendations | Evidence IDs restricted to the selected period, assumptions required, no unsupported numeric claims in prompt | Human management must still decide whether to act on a proposal |
| Employee ranking or disciplinary reuse | Purpose limitation in onboarding/reports; ranking content scanner; no comparison feature | Organisational policy and legal enforcement remain external gates |
| Secret or personal data in operational logs | Application records only IDs/counts/status/error class; third-party HTTP log levels forced to warning | Windows E2E includes grep/scanning of redacted logs and package output |
| Stale data survives retention | File deletion plus SQLite deletion and retention audit | Secure erasure on SSD, filesystem snapshots, and enterprise backup require customer policy |

## Security completion boundary

Automated tests prove application contracts with synthetic data. They do not prove Windows Credential Manager behaviour, DPAPI user isolation, Win+L detection, EDR compatibility, Gemini contract terms, or secure erase. Those claims require the real Windows and organisational evidence listed in `docs/windows-e2e-checklist.md` and `docs/privacy-and-poc-gates.md`.
