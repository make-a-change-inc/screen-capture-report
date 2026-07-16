from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta

import pytest

from src.analyzer import Usage, WeeklyResponse
from src.config import MemorySecretStore
from src.notifier import DeliveryResult
from src.reporting import ReportService
from src.storage import EMPLOYEE_REPORT_ACCESS, MANAGEMENT_REPORT_ACCESS


class FakeWeeklyGateway:
    forbidden = False

    def weekly_insights(self, *, aggregates, evidence_log_ids):
        item = {
            "title": "定型入力の削減",
            "proposal_type": "workflow",
            "description": "ランキング" if self.forbidden else "入力手順を標準化する",
            "expected_effect": "再入力時間を減らせる可能性",
            "assumptions": ["対象手順の確認が必要"],
            "evidence_log_ids": evidence_log_ids,
        }
        return WeeklyResponse([item], [item], [item], Usage(50, 30))


class FakeNotifier:
    def __init__(self):
        self.sent = []

    def send_html(self, **kwargs):
        self.sent.append(kwargs)
        return DeliveryResult(True)


class FailingWeeklyGateway:
    def weekly_insights(self, **_kwargs):
        raise TimeoutError("synthetic Gemini outage")


class InitiallyFailingNotifier(FakeNotifier):
    def __init__(self):
        super().__init__()
        self.should_fail = True

    def send_html(self, **kwargs):
        self.sent.append(kwargs)
        if self.should_fail:
            return DeliveryResult(False, "SyntheticSMTPError")
        return DeliveryResult(True)


def build_service(database, files, settings, gateway=None, secrets=None):
    notifier = FakeNotifier()
    secrets = secrets or MemorySecretStore()
    service = ReportService(
        database=database,
        files=files,
        settings_provider=lambda: settings,
        gateway_provider=lambda: gateway or FakeWeeklyGateway(),
        notifier=notifier,
        secrets=secrets,
    )
    return service, notifier


def add_log(database):
    return database.add_work_log(
        start_at=datetime(2026, 7, 13, 1, 0, tzinfo=UTC),
        end_at=datetime(2026, 7, 13, 1, 1, tzinfo=UTC),
        category="administration",
        summary="Confidential synthetic window title",
        confidence=0.8,
        estimated_minutes=1,
        capture_ids=["capture-1"],
    )


def test_daily_and_weekly_reports_are_encrypted_and_separated(database, files, settings) -> None:
    secrets = MemorySecretStore(
        {
            "employee_email": "employee@example.test",
            "management_email": "manager@example.test",
            "employee_id": "employee-007",
            "department": "Synthetic QA",
        }
    )
    log_id = add_log(database)
    service, notifier = build_service(database, files, settings, secrets=secrets)

    daily_id = service.generate_daily(date(2026, 7, 13))
    weekly_id = service.generate_weekly(date(2026, 7, 13))

    daily = database.get_report(daily_id, access=EMPLOYEE_REPORT_ACCESS)
    weekly = database.get_report(weekly_id, access=MANAGEMENT_REPORT_ACCESS)
    assert daily["audience"] == "employee"
    assert "Confidential synthetic window title" in daily["payload"]
    assert weekly["audience"] == "management"
    assert "employee-007" in daily["payload"]
    assert "Synthetic QA" in weekly["payload"]
    assert "Confidential synthetic window title" not in weekly["payload"]
    assert log_id in weekly["payload"]
    assert not (files.root / daily["artifact_path"]).read_bytes().startswith(b"<!doctype")
    assert len(notifier.sent) == 2
    assert database.get_report(daily_id, access=MANAGEMENT_REPORT_ACCESS) is None
    assert database.get_report(weekly_id, access=EMPLOYEE_REPORT_ACCESS) is None


def test_management_boundary_rejects_ranking(database, files, settings) -> None:
    add_log(database)
    gateway = FakeWeeklyGateway()
    gateway.forbidden = True
    service, _ = build_service(database, files, settings, gateway)

    with pytest.raises(ValueError, match="forbidden"):
        service.generate_weekly(date(2026, 7, 13), send=False)


def test_failed_weekly_model_attempt_is_unmeasured_cost(database, files, settings) -> None:
    add_log(database)
    settings.token_input_jpy_per_million = 100.0
    service, _ = build_service(database, files, settings, FailingWeeklyGateway())

    with pytest.raises(TimeoutError, match="Gemini"):
        service.generate_weekly(date(2026, 7, 13), send=False)

    now = datetime.now(UTC)
    summary = database.cost_summary(now - timedelta(hours=1), now + timedelta(hours=1))
    assert summary["events"] == 1
    assert summary["unmeasured_events"] == 1
    assert not summary["passed"]


def test_empty_week_generates_honest_no_data_report(database, files, settings) -> None:
    service = ReportService(
        database=database,
        files=files,
        settings_provider=lambda: settings,
        gateway_provider=lambda: (_ for _ in ()).throw(
            AssertionError("AI should not be called without evidence")
        ),
        notifier=FakeNotifier(),
        secrets=MemorySecretStore(),
    )

    report_id = service.generate_weekly(date(2026, 7, 13), send=False)

    report = database.get_report(report_id, access=MANAGEMENT_REPORT_ACCESS)
    assert "データなし" in report["payload"]
    assert "提案なし" in report["payload"]


def test_failed_email_is_retried_from_persistent_send_log(database, files, settings) -> None:
    secrets = MemorySecretStore({"employee_email": "employee@example.test"})
    notifier = InitiallyFailingNotifier()
    service = ReportService(
        database=database,
        files=files,
        settings_provider=lambda: settings,
        gateway_provider=lambda: FakeWeeklyGateway(),
        notifier=notifier,
        secrets=secrets,
    )
    report_id = service.generate_daily(date(2026, 7, 13), send=False)
    database.record_send(
        report_id,
        "employee",
        "employee@example.test",
        "failed",
        error_code="SyntheticSMTPError",
        next_retry_at=datetime.now(UTC) - timedelta(seconds=1),
    )

    notifier.should_fail = False
    assert service.retry_failed_sends() == 1
    assert database.pending_sends() == []


def test_preview_report_is_upgraded_to_final_report(database, files, settings) -> None:
    service, _ = build_service(database, files, settings)
    day = date(2026, 7, 13)

    report_id = service.generate_daily(day, send=False, finalized=False)
    preview = database.get_report(report_id, access=EMPLOYEE_REPORT_ACCESS)
    assert not preview["finalized"]

    same_id = service.generate_daily(day, send=False, finalized=True)
    final = database.get_report(same_id, access=EMPLOYEE_REPORT_ACCESS)
    assert same_id == report_id
    assert final["finalized"]


def test_daily_report_includes_unclassified_time(database, files, settings) -> None:
    zone = datetime.now().astimezone().tzinfo
    day = date(2026, 7, 13)
    settings.work_start = "10:00"
    settings.work_end = "10:03"
    settings.capture_interval_seconds = 60
    start = datetime.combine(day, time(10), tzinfo=zone)
    database.add_work_log(
        start_at=start,
        end_at=start + timedelta(minutes=1),
        category="development",
        summary="Synthetic classified minute",
        confidence=1.0,
        estimated_minutes=1,
        capture_ids=["capture-1"],
    )
    database.record_capture("paused", captured_at=start + timedelta(minutes=1))
    service, _ = build_service(database, files, settings)

    report_id = service.generate_daily(day, send=False)
    report = database.get_report(report_id, access=EMPLOYEE_REPORT_ACCESS)

    assert "<td>unclassified</td><td>1.00</td>" in report["payload"]


def test_day_without_collection_evidence_is_not_counted_as_unclassified(
    database, files, settings
) -> None:
    service, _ = build_service(database, files, settings)

    report_id = service.generate_daily(date(2026, 7, 13), send=False)
    report = database.get_report(report_id, access=EMPLOYEE_REPORT_ACCESS)

    assert "<td>unclassified</td><td>0.00</td>" in report["payload"]


def test_non_workday_outside_hours_events_do_not_trigger_daily_report(
    database, files, settings
) -> None:
    zone = datetime.now().astimezone().tzinfo
    saturday = date(2026, 7, 18)
    at = datetime.combine(saturday, time(10), tzinfo=zone)
    database.record_control_event("active", at=at - timedelta(days=1))
    database.record_capture("outside_hours", captured_at=at)
    service, _ = build_service(database, files, settings)

    assert not service.has_daily_data(saturday)
