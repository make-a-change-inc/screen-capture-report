from __future__ import annotations

from datetime import date

from src.config import MemorySecretStore
from src.sync import ManagementReportSync, RegistrationResult, UploadResult


class RecordingClient:
    def __init__(self, result: UploadResult | None = None) -> None:
        self.result = result or UploadResult(True)
        self.payloads: list[dict] = []
        self.registrations: list[dict] = []
        self.heartbeats: list[dict] = []

    def register(
        self, api_url: str, company_code: str, employee_id: str,
        department: str, device_name: str, *, sites_bypass_token: str = "",
    ) -> RegistrationResult:
        self.registrations.append({"company_code": company_code, "employee_id": employee_id,
                                   "department": department, "device_name": device_name})
        return RegistrationResult(True, "device-token")

    def upload(
        self,
        api_url: str,
        token: str,
        payload: dict,
        *,
        sites_bypass_token: str = "",
    ) -> UploadResult:
        assert api_url == "https://management.example.test"
        assert token == "device-token"
        assert sites_bypass_token == ""
        self.payloads.append(payload)
        return self.result

    def heartbeat(self, api_url: str, token: str, payload: dict, *, sites_bypass_token: str = "") -> UploadResult:
        assert api_url == "https://management.example.test"
        assert token == "device-token"
        self.heartbeats.append(payload)
        return UploadResult(True)


def build_sync(database, settings, client: RecordingClient) -> ManagementReportSync:
    settings.admin_api_url = "https://management.example.test"
    settings.grant_server_sync_consent()
    settings.server_sync_enabled = True
    return ManagementReportSync(
        database=database,
        settings_provider=lambda: settings,
        secrets=MemorySecretStore(
            {
                "employee_id": "employee-1",
                "department": "Engineering",
                "admin_upload_token": "device-token",
            }
        ),
        client=client,  # type: ignore[arg-type]
    )


def test_sync_uploads_only_finalized_management_weekly_report(database, settings) -> None:
    database.save_report(
        kind="daily",
        period_start=date(2026, 7, 20),
        period_end=date(2026, 7, 20),
        audience="employee",
        payload="private employee detail",
        artifact_path="reports/employee/2026-07-20.html.enc",
        finalized=True,
    )
    database.save_report(
        kind="weekly",
        period_start=date(2026, 7, 13),
        period_end=date(2026, 7, 19),
        audience="management",
        payload="unfinished management report",
        artifact_path="reports/management/2026-07-13.html.enc",
        finalized=False,
    )
    final_id = database.save_report(
        kind="weekly",
        period_start=date(2026, 7, 6),
        period_end=date(2026, 7, 12),
        audience="management",
        payload="<h1>safe aggregate</h1>",
        artifact_path="reports/management/2026-07-06.html.enc",
        finalized=True,
    )
    client = RecordingClient()
    sync = build_sync(database, settings, client)

    assert sync.sync_pending() == 1
    assert len(client.payloads) == 1
    assert client.payloads[0]["report_id"] == final_id
    assert client.payloads[0]["audience"] == "management"
    assert client.payloads[0]["finalized"] is True
    assert "private employee detail" not in str(client.payloads)
    assert database.report_sync_state(final_id)["status"] == "synced"
    assert len(client.heartbeats) == 1
    assert client.heartbeats[0]["metric_date"]
    assert "pause_reasons" in client.heartbeats[0]


def test_sync_is_disabled_without_new_consent(database, settings) -> None:
    settings.admin_api_url = "https://management.example.test"
    settings.server_sync_enabled = False
    client = RecordingClient()
    sync = ManagementReportSync(
        database=database,
        settings_provider=lambda: settings,
        secrets=MemorySecretStore({"admin_upload_token": "device-token"}),
        client=client,  # type: ignore[arg-type]
    )

    assert sync.sync_pending() == 0
    assert client.payloads == []


def test_sync_self_registers_from_company_code(database, settings) -> None:
    settings.admin_api_url = "https://management.example.test"
    settings.grant_server_sync_consent()
    settings.server_sync_enabled = True
    client = RecordingClient()
    secrets = MemorySecretStore({"company_code": "company-code-001", "employee_id": "employee-1",
                                 "department": "Engineering"})
    sync = ManagementReportSync(database=database, settings_provider=lambda: settings,
                                secrets=secrets, client=client)  # type: ignore[arg-type]
    assert sync.sync_pending() == 0
    assert secrets.get("admin_upload_token") == "device-token"
    assert client.registrations[0]["company_code"] == "company-code-001"


def test_sync_re_registers_after_device_token_is_rejected(database, settings) -> None:
    report_id = database.save_report(
        kind="weekly",
        period_start=date(2026, 7, 6),
        period_end=date(2026, 7, 12),
        audience="management",
        payload="safe aggregate",
        artifact_path="reports/management/2026-07-06.html.enc",
        finalized=True,
    )
    sync = build_sync(database, settings, RecordingClient(UploadResult(False, "http_401")))

    assert sync.sync_pending() == 0
    assert database.report_sync_state(report_id)["status"] == "failed"
