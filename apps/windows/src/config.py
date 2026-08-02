from __future__ import annotations

import base64
import json
import os
import platform
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from src.constants import (
    APP_NAME,
    APP_SERVICE_NAME,
    CONSENT_VERSION,
    DEFAULT_CATEGORIES,
    DEFAULT_EXCLUDED_PROCESSES,
    DEFAULT_EXCLUDED_TITLE_KEYWORDS,
    SERVER_SYNC_CONSENT_VERSION,
)

REQUIRED_ONBOARDING_SECRETS = ("gemini_api_key", "employee_id", "department", "privacy_contact")
STORED_SECRET_KEYS = (
    "gemini_api_key",
    "smtp_password",
    "smtp_user",
    "email_from",
    "employee_email",
    "management_email",
    "employee_id",
    "department",
    "privacy_contact",
    "admin_upload_token",
    "admin_sites_bypass_token",
)


def get_data_dir() -> Path:
    override = os.environ.get("SCREEN_CAPTURE_REPORT_DATA_DIR")
    if override:
        path = Path(override).expanduser().resolve()
    elif platform.system() == "Windows":
        root = os.environ.get("LOCALAPPDATA")
        if not root:
            raise RuntimeError("LOCALAPPDATA is not available")
        path = Path(root) / APP_NAME
    else:
        # Non-Windows is supported for tests and static verification only.
        path = Path.home() / ".screen-capture-report-test"
    path.mkdir(parents=True, exist_ok=True)
    return path


@dataclass(slots=True)
class Settings:
    capture_mode: str = "active_window"
    capture_interval_seconds: int = 60
    analysis_batch_size: int = 5
    work_start: str = "08:00"
    work_end: str = "20:00"
    work_weekdays: list[int] = field(default_factory=lambda: [0, 1, 2, 3, 4])
    idle_threshold_seconds: int = 300
    max_image_edge: int = 1280
    # Retain encrypted captures long enough for the employee to inspect them
    # in the local archive. The retention worker enforces this upper bound.
    capture_retention_hours: int = 24
    log_retention_days: int = 30
    report_retention_days: int = 90
    capture_paused: bool = True
    analysis_model: str = "gemini-2.5-flash"
    report_model: str = "gemini-2.5-flash"
    categories: list[dict[str, str]] = field(
        default_factory=lambda: [dict(item) for item in DEFAULT_CATEGORIES]
    )
    excluded_processes: list[str] = field(default_factory=lambda: list(DEFAULT_EXCLUDED_PROCESSES))
    excluded_title_keywords: list[str] = field(
        default_factory=lambda: list(DEFAULT_EXCLUDED_TITLE_KEYWORDS)
    )
    smtp_server: str = "smtp.gmail.com"
    smtp_port: int = 587
    autostart_enabled: bool = False
    consent_version: str = ""
    consented_at: str = ""
    token_input_jpy_per_million: float = 0.0
    token_output_jpy_per_million: float = 0.0
    admin_api_url: str = ""
    server_sync_enabled: bool = False
    server_sync_consent_version: str = ""
    server_sync_consented_at: str = ""

    @property
    def has_consent(self) -> bool:
        return self.consent_version == CONSENT_VERSION and bool(self.consented_at)

    def grant_consent(self) -> None:
        self.consent_version = CONSENT_VERSION
        self.consented_at = datetime.now(UTC).isoformat()
        self.capture_paused = False

    def revoke_consent(self) -> None:
        self.consent_version = ""
        self.consented_at = ""
        self.capture_paused = True

    @property
    def has_server_sync_consent(self) -> bool:
        return (
            self.server_sync_consent_version == SERVER_SYNC_CONSENT_VERSION
            and bool(self.server_sync_consented_at)
        )

    def grant_server_sync_consent(self) -> None:
        self.server_sync_consent_version = SERVER_SYNC_CONSENT_VERSION
        self.server_sync_consented_at = datetime.now(UTC).isoformat()

    def revoke_server_sync_consent(self) -> None:
        self.server_sync_consent_version = ""
        self.server_sync_consented_at = ""
        self.server_sync_enabled = False

    def validate(self) -> None:
        if self.capture_mode not in {"active_window", "all_screens"}:
            raise ValueError("capture_mode must be active_window or all_screens")
        if self.capture_interval_seconds < 10:
            raise ValueError("capture_interval_seconds must be at least 10")
        if self.analysis_batch_size < 1:
            raise ValueError("analysis_batch_size must be positive")
        if self.idle_threshold_seconds < 60:
            raise ValueError("idle_threshold_seconds must be at least 60")
        if self.max_image_edge < 320:
            raise ValueError("max_image_edge must be at least 320")
        if self.server_sync_enabled:
            if not self.has_server_sync_consent:
                raise ValueError("server sync requires explicit consent")
            if not self.admin_api_url:
                raise ValueError("server sync requires admin_api_url")
            if not (
                self.admin_api_url.startswith("https://")
                or self.admin_api_url.startswith("http://localhost")
                or self.admin_api_url.startswith("http://127.0.0.1")
            ):
                raise ValueError("admin_api_url must use HTTPS")
        if not 0 <= self.capture_retention_hours <= 24:
            raise ValueError("capture_retention_hours must be between 0 and 24")
        if self.log_retention_days < 1 or self.report_retention_days < 1:
            raise ValueError("retention days must be positive")
        start_time = datetime.strptime(self.work_start, "%H:%M").time()
        end_time = datetime.strptime(self.work_end, "%H:%M").time()
        if start_time >= end_time:
            raise ValueError(
                "overnight work hours are not supported; work_start must precede work_end"
            )
        if (
            not self.work_weekdays
            or len(set(self.work_weekdays)) != len(self.work_weekdays)
            or any(day < 0 or day > 6 for day in self.work_weekdays)
        ):
            raise ValueError("work_weekdays must contain unique weekday numbers from 0 to 6")
        category_ids = [item.get("id") for item in self.categories]
        if not category_ids or len(set(category_ids)) != len(category_ids):
            raise ValueError("category ids must be present and unique")


class SettingsStore:
    def __init__(self, path: Path | None = None):
        self.path = path or (get_data_dir() / "config.json")

    def load(self) -> Settings:
        if not self.path.exists():
            return Settings()
        payload = json.loads(self.path.read_text(encoding="utf-8"))
        allowed = set(Settings.__dataclass_fields__)
        settings = Settings(**{k: v for k, v in payload.items() if k in allowed})
        settings.validate()
        return settings

    def save(self, settings: Settings) -> None:
        settings.validate()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(asdict(settings), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(temporary, self.path)


class SecretBackend(Protocol):
    def get(self, key: str) -> str | None: ...

    def set(self, key: str, value: str) -> None: ...

    def delete(self, key: str) -> None: ...


def has_required_onboarding_secrets(secrets: SecretBackend) -> bool:
    return all(bool(secrets.get(key)) for key in REQUIRED_ONBOARDING_SECRETS)


class KeyringSecretStore:
    """Stores secrets in Windows Credential Manager through keyring."""

    def __init__(self, service_name: str = APP_SERVICE_NAME):
        self.service_name = service_name

    @staticmethod
    def _keyring():
        try:
            import keyring
        except ImportError as exc:  # pragma: no cover - packaging failure path
            raise RuntimeError("keyring is required for credential storage") from exc
        return keyring

    def get(self, key: str) -> str | None:
        return self._keyring().get_password(self.service_name, key)

    def set(self, key: str, value: str) -> None:
        self._keyring().set_password(self.service_name, key, value)

    def delete(self, key: str) -> None:
        keyring = self._keyring()
        try:
            keyring.delete_password(self.service_name, key)
        except keyring.errors.PasswordDeleteError:
            return


class DPAPIFileSecretStore:
    """Fallback store whose values are individually protected by Windows DPAPI."""

    def __init__(self, path: Path, protector: Any | None = None):
        if protector is None:
            from src.security import WindowsDPAPIProtector

            protector = WindowsDPAPIProtector()
        self.path = path
        self.protector = protector

    def _load(self) -> dict[str, str]:
        if not self.path.exists():
            return {}
        return json.loads(self.path.read_text(encoding="utf-8"))

    def _save(self, payload: dict[str, str]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        os.replace(temporary, self.path)

    def get(self, key: str) -> str | None:
        encoded = self._load().get(key)
        if not encoded:
            return None
        protected = base64.b64decode(encoded.encode("ascii"))
        return self.protector.unprotect(protected).decode("utf-8")

    def set(self, key: str, value: str) -> None:
        payload = self._load()
        protected = self.protector.protect(value.encode("utf-8"))
        payload[key] = base64.b64encode(protected).decode("ascii")
        self._save(payload)

    def delete(self, key: str) -> None:
        payload = self._load()
        if key in payload:
            del payload[key]
            self._save(payload)


class WindowsSecretStore:
    """Credential Manager first, DPAPI-protected local fallback second."""

    def __init__(self, data_dir: Path):
        self.primary = KeyringSecretStore()
        self.fallback = DPAPIFileSecretStore(data_dir / "secrets.dpapi.json")

    def get(self, key: str) -> str | None:
        try:
            value = self.primary.get(key)
            if value is not None:
                return value
        except Exception:
            pass
        return self.fallback.get(key)

    def set(self, key: str, value: str) -> None:
        try:
            self.primary.set(key, value)
            self.fallback.delete(key)
        except Exception:
            self.fallback.set(key, value)

    def delete(self, key: str) -> None:
        failures: list[Exception] = []
        try:
            self.primary.delete(key)
        except Exception as exc:
            failures.append(exc)
        try:
            self.fallback.delete(key)
        except Exception as exc:
            failures.append(exc)
        if failures:
            raise RuntimeError("Failed to delete a credential from every configured store") from (
                failures[0]
            )


class MemorySecretStore:
    """Explicit test backend; never selected by the production bootstrap."""

    def __init__(self, values: dict[str, str] | None = None):
        self.values = dict(values or {})

    def get(self, key: str) -> str | None:
        return self.values.get(key)

    def set(self, key: str, value: str) -> None:
        self.values[key] = value

    def delete(self, key: str) -> None:
        self.values.pop(key, None)


def settings_to_public_dict(settings: Settings) -> dict[str, Any]:
    payload = asdict(settings)
    payload["consented_at"] = bool(settings.consented_at)
    return payload
