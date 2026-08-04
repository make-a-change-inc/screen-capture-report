from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from src.config import SecretBackend, SettingsStore


@dataclass(frozen=True, slots=True)
class DeviceProvisioning:
    admin_api_url: str
    employee_id: str
    department: str
    device_token: str

    @classmethod
    def load(cls, path: Path) -> DeviceProvisioning:
        if path.stat().st_size > 16 * 1024:
            raise ValueError("provisioning_file_too_large")
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("schema_version") != 1:
            raise ValueError("unsupported_provisioning_schema")
        value = cls(
            admin_api_url=str(payload.get("admin_api_url") or "").rstrip("/"),
            employee_id=str(payload.get("employee_id") or "").strip(),
            department=str(payload.get("department") or "").strip(),
            device_token=str(payload.get("device_token") or "").strip(),
        )
        value.validate()
        return value

    def validate(self) -> None:
        parsed = urlparse(self.admin_api_url)
        local = parsed.hostname in {"localhost", "127.0.0.1"}
        if parsed.scheme != "https" and not (local and parsed.scheme == "http"):
            raise ValueError("provisioning_api_url_must_use_https")
        if (
            not parsed.netloc
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("invalid_provisioning_api_url")
        if not self.employee_id or len(self.employee_id) > 128:
            raise ValueError("invalid_provisioning_employee_id")
        if not self.department or len(self.department) > 128:
            raise ValueError("invalid_provisioning_department")
        if len(self.device_token) < 32 or len(self.device_token) > 256:
            raise ValueError("invalid_provisioning_device_token")


def apply_device_provisioning(
    path: Path,
    *,
    settings_store: SettingsStore,
    secrets: SecretBackend,
    enable_sync: bool,
) -> None:
    provisioning = DeviceProvisioning.load(path)
    settings = settings_store.load()
    settings.admin_api_url = provisioning.admin_api_url
    if enable_sync:
        settings.grant_server_sync_consent()
        settings.server_sync_enabled = True
    settings_store.save(settings)
    secrets.set("employee_id", provisioning.employee_id)
    secrets.set("department", provisioning.department)
    secrets.set("admin_upload_token", provisioning.device_token)
