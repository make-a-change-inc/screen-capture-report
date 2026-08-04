from __future__ import annotations

import json
import logging
import platform
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlparse

from src.config import SecretBackend, Settings
from src.metrics import daily_operational_metrics
from src.storage import MANAGEMENT_REPORT_ACCESS, Database

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class UploadResult:
    success: bool
    error_code: str | None = None


@dataclass(frozen=True, slots=True)
class RegistrationResult:
    success: bool
    device_token: str = ""
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

    def heartbeat(
        self, api_url: str, token: str, payload: dict[str, Any], *, sites_bypass_token: str = "",
    ) -> UploadResult:
        endpoint = api_url.rstrip("/") + "/api/v1/device/heartbeat"
        parsed = urlparse(endpoint)
        if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1"}:
            return UploadResult(False, "insecure_admin_api_url")
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=utf-8",
                   "User-Agent": "ScreenCaptureReport/0.4"}
        if sites_bypass_token:
            headers["OAI-Sites-Authorization"] = f"Bearer {sites_bypass_token}"
        request = urllib.request.Request(endpoint,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                return UploadResult(200 <= response.status < 300,
                                    None if 200 <= response.status < 300 else f"http_{response.status}")
        except urllib.error.HTTPError as exc:
            return UploadResult(False, f"http_{exc.code}")
        except urllib.error.URLError:
            return UploadResult(False, "network_error")
        except Exception as exc:
            logger.error("Device heartbeat failed: %s", type(exc).__name__)
            return UploadResult(False, type(exc).__name__)

    def register(
        self, api_url: str, company_code: str, employee_id: str, department: str,
        device_name: str, *, sites_bypass_token: str = "",
    ) -> RegistrationResult:
        endpoint = api_url.rstrip("/") + "/api/v1/device/register"
        parsed = urlparse(endpoint)
        if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1"}:
            return RegistrationResult(False, error_code="insecure_admin_api_url")
        headers = {
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "ScreenCaptureReport/0.4",
        }
        if sites_bypass_token:
            headers["OAI-Sites-Authorization"] = f"Bearer {sites_bypass_token}"
        request = urllib.request.Request(endpoint, data=json.dumps({
            "companyCode": company_code, "employeeId": employee_id,
            "department": department, "deviceName": device_name,
        }, ensure_ascii=False).encode("utf-8"), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
                token = str(payload.get("deviceToken") or "")
                return RegistrationResult(bool(token), token, None if token else "invalid_response")
        except urllib.error.HTTPError as exc:
            return RegistrationResult(False, error_code=f"http_{exc.code}")
        except urllib.error.URLError:
            return RegistrationResult(False, error_code="network_error")
        except Exception as exc:
            logger.error("Device registration failed: %s", type(exc).__name__)
            return RegistrationResult(False, error_code=type(exc).__name__)


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
        self._registration_retry_count = 0
        self._registration_next_at: datetime | None = None

    def _device_token(self, settings: Settings) -> str:
        token = self.secrets.get("admin_upload_token") or ""
        if token:
            return token
        now = datetime.now().astimezone()
        if self._registration_next_at and now < self._registration_next_at:
            return ""
        company_code = self.secrets.get("company_code") or ""
        employee_id = self.secrets.get("employee_id") or ""
        department = self.secrets.get("department") or ""
        if not all((company_code, employee_id, department)):
            return ""
        result = self.client.register(
            settings.admin_api_url, company_code, employee_id, department,
            platform.node() or "Windows PC",
            sites_bypass_token=self.secrets.get("admin_sites_bypass_token") or "",
        )
        if result.success:
            self.secrets.set("admin_upload_token", result.device_token)
            self._registration_retry_count = 0
            self._registration_next_at = None
            return result.device_token
        delay = min(3600, 60 * (2 ** self._registration_retry_count))
        self._registration_retry_count += 1
        self._registration_next_at = now + timedelta(seconds=delay)
        return ""

    def sync_pending(self) -> int:
        settings: Settings = self.settings_provider()
        if (
            not settings.server_sync_enabled
            or not settings.has_server_sync_consent
            or not settings.admin_api_url
        ):
            return 0
        token = self._device_token(settings)
        if not token:
            return 0

        metrics = daily_operational_metrics(self.database, datetime.now().astimezone().date(), settings)
        capture = metrics["capture"]
        counts = capture.get("counts", {})
        heartbeat_payload = {
            "metric_date": metrics["day"],
            "app_version": "0.4",
            "collection_state": "paused" if settings.capture_paused else "active",
            "scheduled_count": capture["scheduled_intervals"],
            "eligible_count": capture["eligible"],
            "captured_count": capture["successful"],
            "failed_count": capture["failed"],
            "missing_count": capture["missing_intervals"],
            "analyzed_count": int(counts.get("analyzed", 0)),
            "analysis_failed_count": int(counts.get("analysis_failed", 0)),
            "pause_reasons": {key: int(value) for key, value in counts.items()
                              if key in {"paused", "locked", "idle", "excluded", "consent_required"}},
        }
        heartbeat = getattr(self.client, "heartbeat", None)
        if heartbeat is not None:
            result = heartbeat(settings.admin_api_url, token, heartbeat_payload,
                sites_bypass_token=self.secrets.get("admin_sites_bypass_token") or "")
            if result.error_code == "http_401":
                self.secrets.delete("admin_upload_token")
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
            zone = datetime.now().astimezone().tzinfo
            period_start = datetime.fromisoformat(report["period_start"]).replace(tzinfo=zone)
            period_end = datetime.fromisoformat(report["period_end"]).replace(
                tzinfo=zone
            ) + timedelta(days=1)
            logs = self.database.list_work_logs(period_start, period_end)
            category_minutes: dict[str, float] = {}
            for item in logs:
                category = str(item["category"])
                category_minutes[category] = category_minutes.get(category, 0.0) + float(
                    item["estimated_minutes"]
                )
            categories = [
                {"category": category, "minutes": round(minutes, 2)}
                for category, minutes in sorted(category_minutes.items())
            ]
            capture = self.database.capture_metrics(period_start, period_end)
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
                    "metrics": {
                        "activeMinutes": round(sum(category_minutes.values())),
                        "categories": categories,
                        "captureCount": capture["successful"],
                        "workLogCount": len(logs),
                    },
                },
                sites_bypass_token=self.secrets.get("admin_sites_bypass_token") or "",
            )
            state = self.database.report_sync_state(report_id) or {"retry_count": 0}
            if result.error_code == "http_401":
                self.secrets.delete("admin_upload_token")
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
