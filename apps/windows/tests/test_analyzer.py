from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

from src.analyzer import (
    AnalysisCoordinator,
    AnalysisItem,
    AnalysisResponse,
    GeminiGateway,
    Usage,
    analysis_batch_ready,
)
from src.capturer import ScreenCapturer
from src.security import EncryptedFileStore, EncryptionService
from src.storage import Database

from .conftest import FakeMSS, FakePlatform


class SuccessfulGateway:
    def analyze(self, *, images, capture_ids, categories, interval_minutes):
        assert images
        return AnalysisResponse(
            items=[
                AnalysisItem(
                    category="development",
                    summary="Synthetic implementation work",
                    confidence=0.9,
                    estimated_minutes=interval_minutes * len(capture_ids),
                    capture_ids=capture_ids,
                )
            ],
            usage=Usage(input_tokens=100, output_tokens=20),
        )


class FailingGateway:
    def analyze(self, **_kwargs):
        raise TimeoutError("network unavailable")


class BlockingGateway(SuccessfulGateway):
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()
        self.calls = 0

    def analyze(self, **kwargs):
        self.calls += 1
        self.started.set()
        assert self.release.wait(timeout=5)
        return super().analyze(**kwargs)


def build(database, files, settings, gateway):
    capturer = ScreenCapturer(
        database=database,
        files=files,
        settings_provider=lambda: settings,
        platform_state=FakePlatform(),
        mss_factory=FakeMSS,
    )
    coordinator = AnalysisCoordinator(
        database=database,
        capturer=capturer,
        settings_provider=lambda: settings,
        gateway_provider=lambda: gateway,
    )
    return capturer, coordinator


def test_analysis_persists_structured_log_and_deletes_capture(database, files, settings) -> None:
    settings.analysis_batch_size = 1
    settings.capture_retention_hours = 0
    capturer, coordinator = build(database, files, settings, SuccessfulGateway())
    capture_id = capturer.capture(now=datetime(2026, 7, 16, 10, 0, tzinfo=UTC))

    assert coordinator.process_pending(force=True) == 1

    record = database.get_capture(capture_id)
    assert record.status == "analyzed"
    assert record.file_path is None
    logs = database.list_work_logs(
        datetime(2026, 7, 16, tzinfo=UTC),
        datetime(2026, 7, 17, tzinfo=UTC),
    )
    assert logs[0]["category"] == "development"
    assert logs[0]["capture_ids"] == [capture_id]
    assert b"Synthetic implementation work" not in database.path.read_bytes()


def test_analysis_failure_stays_retryable(database, files, settings) -> None:
    settings.analysis_batch_size = 1
    capturer, coordinator = build(database, files, settings, FailingGateway())
    capture_id = capturer.capture(now=datetime(2026, 7, 16, 10, 0, tzinfo=UTC))

    assert coordinator.process_pending(force=True) == 0

    record = database.get_capture(capture_id)
    assert record.status == "analysis_failed"
    assert record.retry_count == 1
    assert record.next_retry_at
    assert record.file_path and files.exists(record.file_path)

    retry = AnalysisCoordinator(
        database=database,
        capturer=capturer,
        settings_provider=lambda: settings,
        gateway_provider=lambda: SuccessfulGateway(),
    )
    assert retry.process_pending(force=True) == 1
    assert database.get_capture(capture_id).status == "analyzed"


def test_analysis_queue_survives_database_restart(tmp_path, settings) -> None:
    settings.analysis_batch_size = 1
    encryption = EncryptionService.for_tests()
    files = EncryptedFileStore(tmp_path / "data", encryption)
    first_database = Database(tmp_path / "app.sqlite3", encryption)
    capturer, coordinator = build(first_database, files, settings, FailingGateway())
    capture_id = capturer.capture(now=datetime(2026, 7, 16, 10, 0, tzinfo=UTC))
    assert coordinator.process_pending(force=True) == 0
    first_database.close()

    reopened = Database(tmp_path / "app.sqlite3", encryption)
    try:
        capturer = ScreenCapturer(
            database=reopened,
            files=files,
            settings_provider=lambda: settings,
            platform_state=FakePlatform(),
            mss_factory=FakeMSS,
        )
        retry = AnalysisCoordinator(
            database=reopened,
            capturer=capturer,
            settings_provider=lambda: settings,
            gateway_provider=lambda: SuccessfulGateway(),
        )
        assert retry.process_pending(force=True) == 1
        assert reopened.get_capture(capture_id).status == "analyzed"
    finally:
        reopened.close()


def test_partial_batch_becomes_ready_after_bounded_wait(database, settings) -> None:
    capture_id = database.record_capture(
        "captured",
        captured_at=datetime(2026, 7, 16, 10, 0, tzinfo=UTC),
    )
    record = database.get_capture(capture_id)
    assert record is not None
    records = [record]
    assert not analysis_batch_ready(
        records,
        batch_size=5,
        interval_seconds=60,
        now=datetime(2026, 7, 16, 10, 4, 59, tzinfo=UTC),
    )
    assert analysis_batch_ready(
        records,
        batch_size=5,
        interval_seconds=60,
        now=datetime(2026, 7, 16, 10, 5, tzinfo=UTC),
    )


def test_concurrent_analysis_attempts_do_not_duplicate_work_logs(
    database, files, settings
) -> None:
    settings.analysis_batch_size = 1
    gateway = BlockingGateway()
    capturer, coordinator = build(database, files, settings, gateway)
    capture_id = capturer.capture(now=datetime(2026, 7, 16, 10, 0, tzinfo=UTC))

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(coordinator.process_pending, force=True)
        assert gateway.started.wait(timeout=5)
        second = pool.submit(coordinator.process_pending, force=True)
        gateway.release.set()
        assert sorted([first.result(timeout=5), second.result(timeout=5)]) == [0, 1]

    assert gateway.calls == 1
    logs = database.list_work_logs(
        datetime(2026, 7, 16, tzinfo=UTC),
        datetime(2026, 7, 17, tzinfo=UTC),
    )
    assert len(logs) == 1
    assert logs[0]["capture_ids"] == [capture_id]


def test_corrupt_capture_does_not_block_valid_capture(database, files, settings) -> None:
    settings.analysis_batch_size = 2
    bad_id = database.record_capture(
        "captured",
        captured_at=datetime(2026, 7, 16, 9, 59, tzinfo=UTC),
        file_path="captures/bad.png.enc",
    )
    files.write("captures/bad.png.enc", b"not an image")
    capturer, coordinator = build(database, files, settings, SuccessfulGateway())
    good_id = capturer.capture(now=datetime(2026, 7, 16, 10, 0, tzinfo=UTC))

    assert coordinator.process_pending(force=True) == 1

    assert database.get_capture(bad_id).status == "analysis_failed"
    assert database.get_capture(good_id).status == "analyzed"


def test_missing_usage_metadata_is_unmeasured(settings) -> None:
    settings.token_input_jpy_per_million = 100.0
    settings.token_output_jpy_per_million = 100.0
    usage = GeminiGateway._usage(object())

    cost = AnalysisCoordinator._cost_entry(
        operation="capture_analysis",
        model=settings.analysis_model,
        usage=usage,
        settings=settings,
    )

    assert not usage.measured
    assert cost["cost_jpy"] is None
    assert cost["is_estimate"]


def test_failed_model_attempt_is_written_as_unmeasured_cost(
    database, files, settings
) -> None:
    settings.analysis_batch_size = 1
    settings.token_input_jpy_per_million = 100.0
    capturer, coordinator = build(database, files, settings, FailingGateway())
    # Keep this analyzer test independent of the wall-clock work schedule.
    capturer.capture(now=datetime.now(UTC), manual=True)

    assert coordinator.process_pending(force=True) == 0

    now = datetime.now(UTC)
    summary = database.cost_summary(now - timedelta(hours=1), now + timedelta(hours=1))
    assert summary["events"] == 1
    assert summary["unmeasured_events"] == 1
    assert not summary["measured"]
    assert not summary["passed"]
