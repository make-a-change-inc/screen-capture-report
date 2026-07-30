from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from datetime import date, datetime, timedelta
from datetime import time as clock_time
from functools import partial

from src.analyzer import AnalysisCoordinator
from src.capturer import ScreenCapturer
from src.config import Settings
from src.reporting import ReportService
from src.storage import Database

logger = logging.getLogger(__name__)


def advance_capture_deadline(previous: float, now: float, interval: float) -> float:
    candidate = previous + interval
    if candidate <= now:
        missed_intervals = int((now - candidate) // interval) + 1
        candidate += missed_intervals * interval
    return candidate


class RuntimeService:
    def __init__(
        self,
        *,
        database: Database,
        capturer: ScreenCapturer,
        analyzer: AnalysisCoordinator,
        reports: ReportService,
        settings_provider: Callable[[], Settings],
        pause_state_setter: Callable[[bool], None] | None = None,
        report_sync=None,
    ):
        self.database = database
        self.capturer = capturer
        self.analyzer = analyzer
        self.reports = reports
        self.settings_provider = settings_provider
        self.pause_state_setter = pause_state_setter or (lambda _paused: None)
        self.report_sync = report_sync
        self._stop = threading.Event()
        self._state_lock = threading.RLock()
        self._paused = True
        self._threads: list[threading.Thread] = []

    @property
    def paused(self) -> bool:
        with self._state_lock:
            return self._paused

    def start(self) -> None:
        if self._threads:
            return
        settings = self.settings_provider()
        with self._state_lock:
            self._paused = settings.capture_paused or not settings.has_consent
        try:
            self.database.record_control_event("paused" if self.paused else "active")
        except Exception as exc:
            logger.error("Control-state persistence failed: %s", type(exc).__name__)
            with self._state_lock:
                self._paused = True
            return
        self._stop.clear()
        self._threads = [
            threading.Thread(target=self._capture_loop, name="capture-loop", daemon=True),
            threading.Thread(target=self._maintenance_loop, name="maintenance-loop", daemon=True),
        ]
        for thread in self._threads:
            thread.start()

    def stop(self) -> None:
        if not self.paused:
            self.pause()
        self._stop.set()
        for thread in self._threads:
            thread.join(timeout=5)
        self._threads = []

    def resume(self) -> None:
        if not self.settings_provider().has_consent:
            raise RuntimeError("Consent is required before capture")
        self.pause_state_setter(False)
        self.database.record_control_event("active")
        with self._state_lock:
            self._paused = False

    def pause(self) -> None:
        with self._state_lock:
            self._paused = True
        try:
            self.pause_state_setter(True)
        except Exception as exc:
            # Fail safe: persistence trouble must never keep collection active.
            logger.error("Pause persistence failed: %s", type(exc).__name__)
        try:
            self.database.record_control_event("paused")
        except Exception as exc:
            logger.error("Pause audit failed: %s", type(exc).__name__)

    def capture_now(self) -> str:
        return self.capturer.capture(manual=True, paused=False)

    def analyze_now(self) -> int:
        return self.analyzer.process_pending(force=True)

    def daily_report_now(self) -> str:
        return self.reports.generate_daily(
            datetime.now().astimezone().date(),
            send=False,
            finalized=False,
        )

    def weekly_report_now(self) -> str:
        today = datetime.now().astimezone().date()
        week_start = today - timedelta(days=today.weekday())
        return self.reports.generate_weekly(
            week_start,
            send=False,
            finalized=False,
        )

    def sync_reports_now(self) -> int:
        if self.report_sync is None:
            return 0
        return self.report_sync.sync_pending()

    def delete_today_captures(self) -> int:
        today = datetime.now().astimezone().date()
        deleted = 0
        for record in self.database.list_captures():
            captured_day = datetime.fromisoformat(record.captured_at).astimezone().date()
            if captured_day == today and record.file_path:
                deleted += int(
                    self.capturer.delete_capture_payload(record.id, "employee_delete_today")
                )
        return deleted

    def _capture_loop(self) -> None:
        deadline = time.monotonic()
        while not self._stop.is_set():
            settings = self.settings_provider()
            interval = max(10, settings.capture_interval_seconds)
            try:
                self.capturer.capture(paused=self.paused)
            except Exception as exc:
                logger.error("Capture loop error: %s", type(exc).__name__)
            current = time.monotonic()
            deadline = advance_capture_deadline(deadline, current, interval)
            remaining = deadline - current
            self._stop.wait(remaining)

    def _maintenance_loop(self) -> None:
        while not self._stop.wait(15):
            for operation in (
                self.analyzer.process_pending,
                self._generate_due_reports,
                self.reports.retry_failed_sends,
                self.sync_reports_now,
                self._run_retention_if_due,
            ):
                try:
                    operation()
                except Exception as exc:
                    logger.error(
                        "Maintenance operation failed: %s:%s",
                        getattr(operation, "__name__", "operation"),
                        type(exc).__name__,
                    )

    def _generate_due_reports(self, now: datetime | None = None) -> None:
        now = (now or datetime.now()).astimezone()
        settings = self.settings_provider()
        daily_days = []
        for days_ago in range(1, settings.log_retention_days + 1):
            day = now.date() - timedelta(days=days_ago)
            if self.reports.has_daily_data(day):
                daily_days.append(day)
        work_end = clock_time.fromisoformat(settings.work_end)
        due_at = datetime.combine(now.date(), work_end, tzinfo=now.tzinfo) + timedelta(
            seconds=settings.capture_interval_seconds * settings.analysis_batch_size + 30
        )
        if (
            now >= due_at
            and now.weekday() in settings.work_weekdays
            and self.reports.has_daily_data(now.date())
        ):
            daily_days.append(now.date())
        for day in daily_days:
            if self.reports.has_pending_analysis(day, day + timedelta(days=1)):
                continue
            if self.database.report_exists("daily", day, "employee", finalized_only=True):
                self.database.mark_report_job_succeeded("daily", day)
                continue
            self._attempt_report_generation(
                "daily",
                day,
                now,
                partial(
                    self.reports.generate_daily,
                    day,
                    send=bool(self.reports.employee_destination()),
                    finalized=True,
                ),
            )

        current_week = now.date() - timedelta(days=now.weekday())
        recovery_weeks = min(5, max(1, settings.log_retention_days // 7 + 1))
        for weeks_ago in range(1, recovery_weeks + 1):
            week_start = current_week - timedelta(days=7 * weeks_ago)
            has_data = self.reports.has_weekly_data(week_start)
            if not (weeks_ago == 1 or has_data):
                continue
            if self.reports.has_pending_analysis(week_start, week_start + timedelta(days=7)):
                continue
            if self.database.report_exists(
                "weekly", week_start, "management", finalized_only=True
            ):
                self.database.mark_report_job_succeeded("weekly", week_start)
                continue
            self._attempt_report_generation(
                "weekly",
                week_start,
                now,
                partial(
                    self.reports.generate_weekly,
                    week_start,
                    send=bool(self.reports.management_destination()),
                    finalized=True,
                ),
            )

    def _attempt_report_generation(
        self,
        kind: str,
        period_start: date,
        now: datetime,
        operation: Callable[[], object],
    ) -> None:
        if not self.database.report_job_can_attempt(kind, period_start, at=now):
            return
        try:
            operation()
        except Exception as exc:
            retry_count = self.database.report_job_retry_count(kind, period_start)
            delay = min(3600, 60 * (2**retry_count))
            self.database.mark_report_job_failed(
                kind,
                period_start,
                error_code=type(exc).__name__,
                retry_at=now + timedelta(seconds=delay),
            )
            logger.error("Report generation failed: %s:%s", kind, type(exc).__name__)
            return
        self.database.mark_report_job_succeeded(kind, period_start)

    def _run_retention_if_due(self, now: datetime | None = None) -> None:
        now = (now or datetime.now()).astimezone()
        settings = self.settings_provider()
        cutoff = now - timedelta(hours=settings.capture_retention_hours)
        for record in self.database.list_captures():
            if not record.file_path:
                continue
            captured_at = datetime.fromisoformat(record.captured_at).astimezone()
            if settings.capture_retention_hours == 0 and record.status != "analyzed":
                # Pending captures are retained until analysis; a hard 24-hour safety cap applies.
                cutoff_for_record = now - timedelta(hours=24)
            else:
                cutoff_for_record = cutoff
            if captured_at <= cutoff_for_record:
                if (
                    self.capturer.delete_capture_payload(record.id, "capture_retention_expired")
                    and record.status != "analyzed"
                ):
                    self.database.expire_capture(record.id)
        for report in self.database.expired_report_artifacts(
            now=now, report_days=settings.report_retention_days
        ):
            self.reports.files.delete(report["artifact_path"])
        self.database.retention_cleanup(
            now=now,
            log_days=settings.log_retention_days,
            report_days=settings.report_retention_days,
        )
