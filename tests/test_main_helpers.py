from datetime import datetime, time, timedelta

from src.config import STORED_SECRET_KEYS, MemorySecretStore
from src.main import prepare_uninstall_state
from src.security import EncryptionService
from src.storage import Database


def test_prepare_uninstall_closes_active_period_and_purges_secrets(tmp_path) -> None:
    encryption = EncryptionService.for_tests()
    database_path = tmp_path / "screen-capture-report.sqlite3"
    database = Database(database_path, encryption)
    database.record_control_event("active")
    database.close()
    secrets = MemorySecretStore({key: "synthetic" for key in STORED_SECRET_KEYS})

    prepare_uninstall_state(tmp_path, secrets, encryption=encryption)

    reopened = Database(database_path, encryption)
    try:
        tomorrow = datetime.now().astimezone().date() + timedelta(days=1)
        zone = datetime.now().astimezone().tzinfo
        start = datetime.combine(tomorrow, time.min, tzinfo=zone)
        assert not reopened.has_active_control_period(start, start + timedelta(days=1))
    finally:
        reopened.close()
    assert all(secrets.get(key) is None for key in STORED_SECRET_KEYS)


def test_prepare_uninstall_purges_secrets_when_database_is_corrupt(tmp_path) -> None:
    (tmp_path / "screen-capture-report.sqlite3").write_bytes(b"not-a-sqlite-database")
    secrets = MemorySecretStore({key: "synthetic" for key in STORED_SECRET_KEYS})

    prepare_uninstall_state(tmp_path, secrets, encryption=EncryptionService.for_tests())

    assert all(secrets.get(key) is None for key in STORED_SECRET_KEYS)
