from __future__ import annotations

from pathlib import Path

import pytest

from src.config import (
    DPAPIFileSecretStore,
    MemorySecretStore,
    Settings,
    SettingsStore,
    WindowsSecretStore,
    has_required_onboarding_secrets,
)
from src.security import EncryptedFileStore, EncryptionService, PassthroughKeyProtector


def test_settings_round_trip_and_consent(tmp_path: Path) -> None:
    path = tmp_path / "config.json"
    store = SettingsStore(path)
    settings = Settings()
    assert not settings.has_consent
    settings.grant_consent()
    store.save(settings)

    loaded = store.load()
    assert loaded.has_consent
    assert not loaded.capture_paused


def test_secret_store_does_not_join_public_settings() -> None:
    secrets = MemorySecretStore()
    secrets.set("gemini_api_key", "super-secret")
    settings = Settings()

    assert secrets.get("gemini_api_key") == "super-secret"
    assert "super-secret" not in repr(settings)


def test_encrypted_file_is_not_plaintext(tmp_path: Path) -> None:
    encryption = EncryptionService.for_tests()
    files = EncryptedFileStore(tmp_path, encryption)
    payload = b"sensitive screenshot bytes"

    path = files.write("captures/item.enc", payload)

    assert payload not in path.read_bytes()
    assert files.read("captures/item.enc") == payload


def test_dpapi_fallback_file_does_not_contain_plaintext(tmp_path: Path) -> None:
    path = tmp_path / "secrets.json"
    store = DPAPIFileSecretStore(path, protector=PassthroughKeyProtector())

    store.set("gemini_api_key", "secret-value")

    # The passthrough protector still proves the fallback uses encoded blobs rather
    # than writing the credential directly; Windows production additionally uses DPAPI.
    assert "secret-value" not in path.read_text(encoding="utf-8")
    assert store.get("gemini_api_key") == "secret-value"


def test_overnight_work_window_is_rejected() -> None:
    settings = Settings(work_start="20:00", work_end="08:00")

    with pytest.raises(ValueError, match="overnight"):
        settings.validate()


def test_revoke_consent_also_forces_pause() -> None:
    settings = Settings()
    settings.grant_consent()

    settings.revoke_consent()

    assert not settings.has_consent
    assert settings.capture_paused


def test_required_onboarding_secret_gate_fails_closed() -> None:
    secrets = MemorySecretStore(
        {
            "gemini_api_key": "synthetic",
            "employee_id": "employee-1",
            "department": "QA",
        }
    )
    assert not has_required_onboarding_secrets(secrets)

    secrets.set("privacy_contact", "privacy@example.test")
    assert has_required_onboarding_secrets(secrets)


def test_windows_secret_delete_reports_primary_failure_after_trying_fallback() -> None:
    class FailingPrimary:
        def delete(self, key: str) -> None:
            raise OSError("credential manager unavailable")

    class RecordingFallback:
        def __init__(self) -> None:
            self.deleted: list[str] = []

        def delete(self, key: str) -> None:
            self.deleted.append(key)

    store = WindowsSecretStore.__new__(WindowsSecretStore)
    store.primary = FailingPrimary()
    fallback = RecordingFallback()
    store.fallback = fallback

    with pytest.raises(RuntimeError, match="Failed to delete"):
        store.delete("gemini_api_key")

    assert fallback.deleted == ["gemini_api_key"]
