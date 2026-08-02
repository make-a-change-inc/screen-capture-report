from __future__ import annotations

import logging
import os
import platform
import sys
import traceback
from pathlib import Path

from src.analyzer import AnalysisCoordinator, build_gateway
from src.autostart import AutostartManager
from src.capturer import ScreenCapturer
from src.config import (
    STORED_SECRET_KEYS,
    SecretBackend,
    SettingsStore,
    WindowsSecretStore,
    get_data_dir,
    has_required_onboarding_secrets,
)
from src.notifier import EmailNotifier
from src.platform_win import WindowsPlatform, WindowsSingleInstance
from src.reporting import ReportService
from src.security import EncryptedFileStore, EncryptionService
from src.service import RuntimeService
from src.storage import Database
from src.sync import ManagementReportSync
from src.ui import WindowsTrayUI
from src.utils import configure_logging
from src.viewer import EmployeeArchive

logger = logging.getLogger(__name__)


def startup_failure_diagnostic(exc: Exception) -> str:
    """Return stack locations without exception messages, locals, or user data."""
    frames = traceback.extract_tb(exc.__traceback__)
    lines = [f"exception_type={type(exc).__name__}"]
    lines.extend(
        f"frame={Path(frame.filename).name}:{frame.lineno}:{frame.name}" for frame in frames
    )
    return "\n".join(lines) + "\n"


def record_startup_failure(exc: Exception) -> None:
    logger.critical("Fatal startup failure exception_type=%s", type(exc).__name__)
    if os.environ.get("SCREEN_CAPTURE_REPORT_STARTUP_DIAGNOSTICS") != "1":
        return
    try:
        data_dir = get_data_dir()
        (data_dir / "startup-failure.txt").write_text(
            startup_failure_diagnostic(exc),
            encoding="utf-8",
        )
    except Exception:
        # Diagnostics must never obscure or replace the original startup error.
        return


def prepare_uninstall_state(
    data_dir: Path,
    secrets: SecretBackend,
    *,
    encryption: EncryptionService | None = None,
) -> None:
    database_path = data_dir / "screen-capture-report.sqlite3"
    key_path = data_dir / "data-key.dpapi"
    if database_path.exists() and (encryption is not None or key_path.exists()):
        database: Database | None = None
        try:
            encryption = encryption or EncryptionService.from_key_file(key_path)
            database = Database(database_path, encryption)
            database.record_control_event("paused")
        except Exception:
            # A damaged database must not preserve credentials during uninstall.
            logger.exception("Unable to record the uninstall pause state")
        finally:
            if database is not None:
                try:
                    database.close()
                except Exception:
                    logger.exception("Unable to close the database during uninstall")

    deletion_failures: list[str] = []
    for key in STORED_SECRET_KEYS:
        try:
            secrets.delete(key)
        except Exception:
            deletion_failures.append(key)
            logger.exception("Unable to delete a stored credential during uninstall")
    if deletion_failures:
        raise RuntimeError(
            f"Failed to delete {len(deletion_failures)} stored credential(s) during uninstall"
        )


def main() -> int:
    if platform.system() != "Windows":
        raise SystemExit("ScreenCaptureReport Windows build requires Windows 10/11")

    data_dir = get_data_dir()
    configure_logging(data_dir)
    settings_store = SettingsStore(data_dir / "config.json")
    secrets = WindowsSecretStore(data_dir)
    if "--purge-secrets" in sys.argv or "--prepare-uninstall" in sys.argv:
        prepare_uninstall_state(data_dir, secrets)
        return 0
    instance = WindowsSingleInstance()
    if not instance.acquired:
        return 0
    try:
        return _run_application(data_dir, settings_store, secrets)
    finally:
        instance.close()


def _run_application(
    data_dir,
    settings_store: SettingsStore,
    secrets: WindowsSecretStore,
) -> int:
    # Keep the location visible and predictable even before the first
    # successful capture. Payloads beneath it remain encrypted at rest.
    (data_dir / "captures").mkdir(parents=True, exist_ok=True)
    encryption = EncryptionService.from_key_file(data_dir / "data-key.dpapi")
    files = EncryptedFileStore(data_dir, encryption)
    database = Database(data_dir / "screen-capture-report.sqlite3", encryption)
    platform_api = WindowsPlatform()

    def settings_provider():
        return settings_store.load()

    def pause_state_setter(paused: bool) -> None:
        settings = settings_store.load()
        settings.capture_paused = paused
        settings_store.save(settings)

    def gateway_provider():
        return build_gateway(settings_provider(), secrets)

    capturer = ScreenCapturer(
        database=database,
        files=files,
        settings_provider=settings_provider,
        platform_state=platform_api,
    )
    analyzer = AnalysisCoordinator(
        database=database,
        capturer=capturer,
        settings_provider=settings_provider,
        gateway_provider=gateway_provider,
    )
    notifier = EmailNotifier(
        settings_provider=settings_provider,
        secrets=secrets,
    )
    reports = ReportService(
        database=database,
        files=files,
        settings_provider=settings_provider,
        gateway_provider=gateway_provider,
        notifier=notifier,
        secrets=secrets,
    )
    report_sync = ManagementReportSync(
        database=database,
        settings_provider=settings_provider,
        secrets=secrets,
    )
    service = RuntimeService(
        database=database,
        capturer=capturer,
        analyzer=analyzer,
        reports=reports,
        settings_provider=settings_provider,
        pause_state_setter=pause_state_setter,
        report_sync=report_sync,
    )
    employee_archive = EmployeeArchive(database=database, files=files, reports=reports)
    ui = WindowsTrayUI(
        service=service,
        reports=reports,
        settings_store=settings_store,
        secrets=secrets,
        platform_api=platform_api,
        autostart=AutostartManager(),
        employee_archive=employee_archive,
    )

    try:
        if "--capture-now-smoke" in sys.argv:
            service.capture_now()
            return 0
        if "--viewer-smoke" in sys.argv:
            ui._show_employee_archive_window()
            return 0
        settings = settings_provider()
        required_secrets_present = has_required_onboarding_secrets(secrets)
        if not settings.has_consent or not required_secrets_present:
            settings.capture_paused = True
            settings_store.save(settings)
        if (
            (not settings.has_consent or not required_secrets_present)
            and not ui.run_onboarding()
        ):
            return 0
        if not has_required_onboarding_secrets(secrets):
            return 0
        ui.run()
        return 0
    finally:
        service.stop()
        database.close()


if __name__ == "__main__":
    try:
        exit_code = main()
    except Exception as exc:
        record_startup_failure(exc)
        if os.environ.get("SCREEN_CAPTURE_REPORT_STARTUP_DIAGNOSTICS") == "1":
            raise SystemExit(1) from None
        raise
    raise SystemExit(exit_code)
