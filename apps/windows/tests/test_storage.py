from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from src.storage import EMPLOYEE_REPORT_ACCESS, ReportAccess


def test_retention_deletes_and_audits(database) -> None:
    old = datetime(2026, 1, 1, tzinfo=UTC)
    log_id = database.add_work_log(
        start_at=old,
        end_at=old + timedelta(minutes=1),
        category="other",
        summary="old synthetic item",
        confidence=0.5,
        estimated_minutes=1,
        capture_ids=[],
    )
    report_id = database.save_report(
        kind="daily",
        period_start=date(2026, 1, 1),
        period_end=date(2026, 1, 1),
        audience="employee",
        payload="old report",
        artifact_path="reports/employee/old.enc",
    )

    counts = database.retention_cleanup(
        now=datetime(2026, 7, 16, tzinfo=UTC),
        log_days=30,
        report_days=90,
    )

    assert counts == {
        "captures": 0,
        "work_logs": 1,
        "reports": 1,
        "control_events": 0,
        "report_jobs": 0,
    }
    assert database.get_report(report_id, access=EMPLOYEE_REPORT_ACCESS) is None
    events = database.retention_events()
    assert {event["item_id"] for event in events} == {log_id, report_id}


def test_forged_report_capability_is_rejected(database) -> None:
    with pytest.raises(PermissionError, match="invalid_report_access"):
        database.list_reports(access=ReportAccess("employee"))
