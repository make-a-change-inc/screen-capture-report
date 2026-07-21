from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlparse

from src.config import SecretBackend, Settings
from src.storage import MANAGEMENT_REPORT_ACCESS, Database

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class UploadResult:
    success: bool
    error_code: str | None = None


class ManagementReportClient:
    def __init__(self, *, timeout_seconds: float = 20.0) -> None:
        self.timeout_seconds = timeout_seconds

    def upload(
        self,
        api_url: str,
        token: str,
        payload: dict[str, Any],
        *,
        sites_bypass_token: str = "",
    ) -> UploadResult:
        endpoint = api_url.rstrip("/") + "/api/v1/device/reports/weekly-management"
        parsed = urlparse(endpoint)
        if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1"}:
            return UploadResult(False, "insecure_admin_api_url")
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "ScreenCaptureReport/0.3",
            "Idempotency-Key": str(payload["report_id"]),
        }
        if sites_bypass_token:
            headers["OAI-Sites-Authorization"] = f"Bearer {sites_bypass_token}"
        request = urllib.request.Request(
            endpoint,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                if 200 <= response.status < 300:
                    return UploadResult(True)
                return UploadResult(False, f"http_{response.status}")
        except urllib.error.HTTPError as exc:
            return UploadResult(False, f"http_{exc.code}")
        except urllib.error.URLError:
            return UploadResult(False, "network_error")
        except Exception as exc:
            logger.error("Management report upload failed: %s", type(exc).__name__)
            return UploadResult(False, type(exc).__name__)


class ManagementReportSync:
    """Uploads finalized management reports only; never screenshots or employee dailies."""

    def __init__(
        self,
        *,
        database: Database,
        settings_provider,
        secrets: SecretBackend,
        client: ManagementReportClient | None = None,
    ) -> None:
        self.database = database
        self.settings_provider = settings_provider
        self.secrets = secrets
        self.client = client or ManagementReportClient()

    def sync_pending(self) -> int:
        settings: Settings = self.settings_provider()
        token = self.secrets.get("admin_upload_token") or ""
        if (
            not settings.server_sync_enabled
            or not settings.has_server_sync_consent
            or not settings.admin_api_url
            or not token
        ):
            return 0

        reports = {
            item["id"]: item
            for item in self.database.list_reports(access=MANAGEMENT_REPORT_ACCESS)
            if item["kind"] == "weekly" and item["audience"] == "management" and item["finalized"]
        }
        for report_id in reports:
            if self.database.report_sync_state(report_id) is None:
                self.database.queue_report_sync(report_id)

        synced = 0
        for report_id in self.database.pending_report_syncs():
            report = reports.get(report_id)
            if report is None:
                continue
            result = self.client.upload(
                settings.admin_api_url,
                token,
                {
                    "schema_version": 1,
                    "report_id": report["id"],
                    "employee_id": self.secrets.get("employee_id") or "",
                    "department": self.secrets.get("department") or "",
                    "kind": "weekly",
                    "audience": "management",
                    "finalized": True,
                    "period_start": report["period_start"],
                    "period_end": report["period_end"],
                    "report_html": report["payload"] or "",
                },
                sites_bypass_token=self.secrets.get("admin_sites_bypass_token") or "",
            )
            state = self.database.report_sync_state(report_id) or {"retry_count": 0}
            if result.error_code == "http_401":
                self.database.mark_report_sync_auth_required(report_id)
                continue
            delay = min(3600, 60 * (2 ** int(state["retry_count"])))
            self.database.mark_report_sync(
                report_id,
                success=result.success,
                error_code=result.error_code,
                retry_at=(
                    None
                    if result.success
                    else datetime.now().astimezone() + timedelta(seconds=delay)
                ),
            )
            synced += int(result.success)
        return synced
