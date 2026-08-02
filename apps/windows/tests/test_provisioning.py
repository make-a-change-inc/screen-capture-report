from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.config import MemorySecretStore, SettingsStore
from src.provisioning import DeviceProvisioning, apply_device_provisioning


def write_package(path: Path, **overrides) -> None:
    payload = {
        "schema_version": 1,
        "admin_api_url": "https://management.example.test",
        "employee_id": "employee-1",
        "department": "Engineering",
        "device_token": "a" * 43,
        **overrides,
    }
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_provisioning_stores_token_only_in_secret_backend(tmp_path: Path) -> None:
    package = tmp_path / "device.scr-provision.json"
    write_package(package)
    settings_store = SettingsStore(tmp_path / "config.json")
    secrets = MemorySecretStore()

    apply_device_provisioning(
        package,
        settings_store=settings_store,
        secrets=secrets,
        enable_sync=True,
    )

    settings = settings_store.load()
    assert settings.admin_api_url == "https://management.example.test"
    assert settings.server_sync_enabled
    assert settings.has_server_sync_consent
    assert secrets.get("employee_id") == "employee-1"
    assert secrets.get("department") == "Engineering"
    assert secrets.get("admin_upload_token") == "a" * 43
    assert "device_token" not in (tmp_path / "config.json").read_text(encoding="utf-8")


def test_provisioning_does_not_enable_sync_without_explicit_consent(tmp_path: Path) -> None:
    package = tmp_path / "device.scr-provision.json"
    write_package(package)
    store = SettingsStore(tmp_path / "config.json")

    apply_device_provisioning(
        package,
        settings_store=store,
        secrets=MemorySecretStore(),
        enable_sync=False,
    )

    assert not store.load().server_sync_enabled


@pytest.mark.parametrize(
    "overrides",
    [
        {"schema_version": 2},
        {"admin_api_url": "http://management.example.test"},
        {"admin_api_url": "https://user:password@management.example.test"},
        {"device_token": "short"},
        {"employee_id": ""},
        {"department": ""},
    ],
)
def test_provisioning_rejects_unsafe_or_incomplete_packages(
    tmp_path: Path, overrides: dict[str, object]
) -> None:
    package = tmp_path / "device.scr-provision.json"
    write_package(package, **overrides)

    with pytest.raises(ValueError):
        DeviceProvisioning.load(package)
