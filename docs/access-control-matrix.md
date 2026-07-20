# POC Access-Control Matrix

The local app uses the Windows account boundary plus audience-specific application interfaces.
The management extension adds a separately authenticated web console for finalized weekly management reports only.

| Data / action | Employee tray app | Management recipient | Deployment administrator |
|---|---:|---:|---:|
| Capture payload | Encrypted storage, in-memory viewer, and delete control | No access | No product interface |
| Structured work log | Used to render own daily report; no raw-log browser | No access | No product interface |
| Employee daily report | Can list and open own report in the tray | No access | No product interface |
| Management weekly report | Exact pre-share preview and sync state | Web reader for finalized aggregate report | Deployment only |
| Capture schedule, pause, exclusions | Can control | No access | Installer/autostart deployment only |
| Credential values | Write/delete through Windows Credential Manager; values are not displayed | No access | No product interface |

The management server never accepts employee daily reports or capture payloads. A device Bearer token can only call the weekly-management ingestion endpoint. Management APIs additionally require owner authentication and an admin key. Device tokens and admin keys are stored as SHA-256 digests; report content is encrypted with a server-side AES-256-GCM key before D1 persistence.

The database report reader requires a sealed in-process audience capability, rejects forged capability objects, and rejects cross-audience IDs. The tray receives only the employee reader exposed by `ReportService`; it does not receive a generic database handle or management capability. Capture files, sensitive fields, and both report artifacts remain encrypted at rest.

This is application-level least privilege for a per-user POC. A hostile process already executing as the same Windows user is outside the role model and remains a documented residual risk; production multi-user RBAC would require a separately approved server identity boundary.
