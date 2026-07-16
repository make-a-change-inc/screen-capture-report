# POC Access-Control Matrix

The POC uses the Windows account boundary plus audience-specific application interfaces. It does not provide a shared web login or a multi-tenant administrator console.

| Data / action | Employee tray app | Management recipient | Deployment administrator |
|---|---:|---:|---:|
| Capture payload | Encrypted storage and delete control; no image viewer | No access | No product interface |
| Structured work log | Used to render own daily report; no raw-log browser | No access | No product interface |
| Employee daily report | Can list and open own report in the tray | No access | No product interface |
| Management weekly report | No reader/menu/API exposed by the tray | Receives aggregate report at configured destination | No content interface |
| Capture schedule, pause, exclusions | Can control | No access | Installer/autostart deployment only |
| Credential values | Write/delete through Windows Credential Manager; values are not displayed | No access | No product interface |

The database report reader requires a sealed in-process audience capability, rejects forged capability objects, and rejects cross-audience IDs. The tray receives only the employee reader exposed by `ReportService`; it does not receive a generic database handle or management capability. Capture files, sensitive fields, and both report artifacts remain encrypted at rest.

This is application-level least privilege for a per-user POC. A hostile process already executing as the same Windows user is outside the role model and remains a documented residual risk; production multi-user RBAC would require a separately approved server identity boundary.
