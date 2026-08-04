from __future__ import annotations

from datetime import date, datetime, time, timedelta

from src.capturer import ScreenCapturer
from src.config import MemorySecretStore
from src.reporting import ReportService
from src.service import CaptureNotCompleted, RuntimeService, advance_capture_deadline
from src.storage import EMPLOYEE_REPORT_ACCESS

from .conftest import FakeMSS, FakePlatform
from .test_reporting import FakeNotifier, FakeWeeklyGateway


class DummyCapturer:
    def delete_capture_payload(self, *_args):
        return False


class RecordingCapturer(DummyCapturer):
    def __init__(self, capture_id: str):
        self.capture_id = capture_id

    def capture(self, **_kwargs):
        return self.capture_id


class DummyAnalyzer:
    def process_pending(self):
        return 0


class RecordingReports:
    def __init__(
        self,
        weekly_data: set[date] | None = None,
        daily_data: set[date] | None = None,
        fail_weekly: bool = False,
    ):
        self.daily: list[date] = []
        self.weekly: list[date] = []
        self.weekly_data = weekly_data or set()
        self.daily_data = daily_data or set()
        self.fail_weekly = fail_weekly
        self.weekly_attempts = 0

    def employee_destination(self):
        return ""

    def management_destination(self):
        return ""

    def has_pending_analysis(self, _start, _end):
        return False

    def has_weekly_data(self, week_start):
        return week_start in self.weekly_data

    def has_daily_data(self, day):
        return day in self.daily_data

    def generate_daily(self, day, *, send, finalized):
        self.daily.append(day)
        return "daily"

    def generate_weekly(self, week_start, *, send, finalized):
        self.weekly_attempts += 1
        if self.fail_weekly:
            raise TimeoutError("synthetic weekly outage")
        self.weekly.append(week_start)
        return "weekly"

    def retry_failed_sends(self):
        return 0


def test_capture_deadline_uses_monotonic_cadence_without_burst() -> None:
    assert advance_capture_deadline(100.0, 105.0, 60.0) == 160.0
    assert advance_capture_deadline(160.0, 161.0, 60.0) == 220.0
    assert advance_capture_deadline(100.0, 225.0, 60.0) == 280.0


def test_manual_capture_returns_only_a_persisted_payload(database, settings) -> None:
    failed_id = database.record_capture(
        "capture_failed", error_code="foreground_unavailable"
    )
    service = RuntimeService(
        database=database,
        capturer=RecordingCapturer(failed_id),  # type: ignore[arg-type]
        analyzer=DummyAnalyzer(),
        reports=RecordingReports(),  # type: ignore[arg-type]
        settings_provider=lambda: settings,
    )

    try:
        service.capture_now()
    except CaptureNotCompleted as exc:
        assert exc.error_code == "foreground_unavailable"
    else:
        raise AssertionError("failed capture must not be reported as complete")


def test_retention_removes_encrypted_report_artifact(database, files, settings) -> None:
    settings.report_retention_days = 30
    path = "reports/employee/old.html.enc"
    files.write(path, b"old report")
    report_id = database.save_report(
        kind="daily",
        period_start=date(2025, 1, 1),
        period_end=date(2025, 1, 1),
        audience="employee",
        payload="old report",
        artifact_path=path,
    )
    reports = ReportService(
        database=database,
        files=files,
        settings_provider=lambda: settings,
        gateway_provider=lambda: FakeWeeklyGateway(),
        notifier=FakeNotifier(),
        secrets=MemorySecretStore(),
    )
    service = RuntimeService(
        database=database,
        capturer=DummyCapturer(),
        analyzer=DummyAnalyzer(),
        reports=reports,
        settings_provider=lambda: settings,
    )

    service._run_retention_if_due()

    assert not files.exists(path)
    assert database.get_report(report_id, access=EMPLOYEE_REPORT_ACCESS) is None


def test_pause_and_resume_are_persisted(database, files, settings) -> None:
    persisted: list[bool] = []
    reports = ReportService(
        database=database,
        files=files,
        settings_provider=lambda: settings,
        gateway_provider=lambda: FakeWeeklyGateway(),
        notifier=FakeNotifier(),
        secrets=MemorySecretStore(),
    )
    service = RuntimeService(
        database=database,
        capturer=DummyCapturer(),
        analyzer=DummyAnalyzer(),
        reports=reports,
        settings_provider=lambda: settings,
        pause_state_setter=persisted.append,
    )

    service.resume()
    service.pause()

    assert persisted == [False, True]
    assert service.paused


def test_current_daily_report_waits_until_work_end_and_batch_flush(database, settings) -> None:
    settings.work_end = "20:00"
    settings.capture_interval_seconds = 60
    settings.analysis_batch_size = 5
    reports = RecordingReports()
    service = RuntimeService(
        database=database,
        capturer=DummyCapturer(),
        analyzer=DummyAnalyzer(),
        reports=reports,  # type: ignore[arg-type]
        settings_provider=lambda: settings,
    )
    zone = datetime.now().astimezone().tzinfo
    day = date(2026, 7, 16)
    reports.daily_data.add(day)

    service._generate_due_reports(datetime.combine(day, time(20, 5, 29), tzinfo=zone))
    assert day not in reports.daily

    service._generate_due_reports(datetime.combine(day, time(20, 5, 30), tzinfo=zone))
    assert day in reports.daily


def test_weekly_report_is_recovered_on_tuesday_restart(database, settings) -> None:
    zone = datetime.now().astimezone().tzinfo
    previous_week = date(2026, 7, 13)
    reports = RecordingReports({previous_week})
    service = RuntimeService(
        database=database,
        capturer=DummyCapturer(),
        analyzer=DummyAnalyzer(),
        reports=reports,  # type: ignore[arg-type]
        settings_provider=lambda: settings,
    )

    service._generate_due_reports(
        datetime.combine(date(2026, 7, 21), time(10), tzinfo=zone)
    )

    assert previous_week in reports.weekly


def test_daily_reports_with_activity_are_recovered_after_multiday_shutdown(
    database, settings
) -> None:
    zone = datetime.now().astimezone().tzinfo
    missed_day = date(2026, 7, 18)
    reports = RecordingReports(daily_data={missed_day})
    service = RuntimeService(
        database=database,
        capturer=DummyCapturer(),
        analyzer=DummyAnalyzer(),
        reports=reports,  # type: ignore[arg-type]
        settings_provider=lambda: settings,
    )

    service._generate_due_reports(
        datetime.combine(date(2026, 7, 21), time(10), tzinfo=zone)
    )

    assert missed_day in reports.daily


def test_pause_fails_safe_when_persistence_fails(database, files, settings) -> None:
    reports = ReportService(
        database=database,
        files=files,
        settings_provider=lambda: settings,
        gateway_provider=lambda: FakeWeeklyGateway(),
        notifier=FakeNotifier(),
        secrets=MemorySecretStore(),
    )

    def fail_to_persist(paused: bool) -> None:
        if paused:
            raise OSError("synthetic disk failure")

    service = RuntimeService(
        database=database,
        capturer=DummyCapturer(),
        analyzer=DummyAnalyzer(),
        reports=reports,
        settings_provider=lambda: settings,
        pause_state_setter=fail_to_persist,
    )
    service.resume()

    service.pause()

    assert service.paused


def test_pending_capture_is_deleted_at_24_hour_hard_cap(database, files, settings) -> None:
    settings.capture_retention_hours = 0
    now = datetime.now().astimezone().replace(microsecond=0)
    path = "captures/pending.png.enc"
    files.write(path, b"synthetic pending capture")
    capture_id = database.record_capture(
        "analysis_failed",
        captured_at=now - timedelta(hours=24),
        file_path=path,
    )
    capturer = ScreenCapturer(
        database=database,
        files=files,
        settings_provider=lambda: settings,
        platform_state=FakePlatform(),
        mss_factory=FakeMSS,
    )
    reports = ReportService(
        database=database,
        files=files,
        settings_provider=lambda: settings,
        gateway_provider=lambda: FakeWeeklyGateway(),
        notifier=FakeNotifier(),
        secrets=MemorySecretStore(),
    )
    service = RuntimeService(
        database=database,
        capturer=capturer,
        analyzer=DummyAnalyzer(),
        reports=reports,
        settings_provider=lambda: settings,
    )

    service._run_retention_if_due(now=now)

    assert database.get_capture(capture_id).status == "expired"
    assert not files.exists(path)


def test_stop_closes_active_control_period(database, files, settings) -> None:
    reports = ReportService(
        database=database,
        files=files,
        settings_provider=lambda: settings,
        gateway_provider=lambda: FakeWeeklyGateway(),
        notifier=FakeNotifier(),
        secrets=MemorySecretStore(),
    )
    service = RuntimeService(
        database=database,
        capturer=DummyCapturer(),
        analyzer=DummyAnalyzer(),
        reports=reports,
        settings_provider=lambda: settings,
    )
    service.resume()

    service.stop()

    tomorrow = datetime.now().astimezone().date() + timedelta(days=1)
    zone = datetime.now().astimezone().tzinfo
    start = datetime.combine(tomorrow, time.min, tzinfo=zone)
    assert not database.has_active_control_period(start, start + timedelta(days=1))


def test_weekly_generation_uses_persistent_exponential_backoff(database, settings) -> None:
    zone = datetime.now().astimezone().tzinfo
    now = datetime.combine(date(2026, 7, 21), time(10), tzinfo=zone)
    reports = RecordingReports(fail_weekly=True)

    def build_runtime() -> RuntimeService:
        return RuntimeService(
            database=database,
            capturer=DummyCapturer(),
            analyzer=DummyAnalyzer(),
            reports=reports,  # type: ignore[arg-type]
            settings_provider=lambda: settings,
        )

    build_runtime()._generate_due_reports(now)
    assert reports.weekly_attempts == 1

    # A new runtime simulates restart; the DB-backed next_retry_at still gates it.
    build_runtime()._generate_due_reports(now + timedelta(seconds=15))
    assert reports.weekly_attempts == 1

    build_runtime()._generate_due_reports(now + timedelta(seconds=61))
    assert reports.weekly_attempts == 2
