from __future__ import annotations

from datetime import UTC, date, datetime

import pytest

from src.viewer import EmployeeArchive


class EmployeeReports:
    def __init__(self, reports: list[dict]) -> None:
        self._reports = reports

    def list_employee_reports(self) -> list[dict]:
        return self._reports


def test_employee_archive_decrypts_own_report_and_capture_in_memory(database, files) -> None:
    captured_at = datetime(2026, 7, 20, 8, 15, tzinfo=UTC)
    capture_path = "captures/2026-07-20/synthetic.png.enc"
    files.write(capture_path, b"synthetic-png-bytes")
    capture_id = database.record_capture(
        "captured",
        captured_at=captured_at,
        file_path=capture_path,
    )
    archive = EmployeeArchive(
        database=database,
        files=files,
        reports=EmployeeReports(
            [
                {
                    "id": "report-1",
                    "kind": "daily",
                    "period_start": "2026-07-20",
                    "audience": "employee",
                    "payload": "<h1>本人日報</h1>",
                }
            ]
        ),  # type: ignore[arg-type]
    )

    days = archive.list_days()

    assert len(days) == 1
    assert days[0].day == date(2026, 7, 20)
    assert days[0].report_html == "<h1>本人日報</h1>"
    assert days[0].captures[0].id == capture_id
    assert archive.read_capture(days[0].captures[0]) == b"synthetic-png-bytes"


def test_employee_archive_rejects_path_outside_capture_namespace(database, files) -> None:
    archive = EmployeeArchive(
        database=database,
        files=files,
        reports=EmployeeReports([]),  # type: ignore[arg-type]
    )
    from src.viewer import EmployeeCapture

    with pytest.raises(PermissionError, match="outside_employee_archive"):
        archive.read_capture(
            EmployeeCapture(
                id="missing",
                captured_at=datetime.now(UTC).isoformat(),
                status="captured",
                file_path="reports/management/secret.html.enc",
            )
        )


def test_employee_can_preview_exact_management_report_before_sync(database, files) -> None:
    report_id = database.save_report(
        kind="weekly",
        period_start=date(2026, 7, 6),
        period_end=date(2026, 7, 12),
        audience="management",
        payload="<h1>管理者に共有される集計</h1>",
        artifact_path="reports/management/2026-07-06.html.enc",
        finalized=True,
    )
    database.queue_report_sync(report_id)
    archive = EmployeeArchive(
        database=database,
        files=files,
        reports=EmployeeReports([]),  # type: ignore[arg-type]
    )

    previews = archive.list_management_share_previews()

    assert len(previews) == 1
    assert previews[0].report_html == "<h1>管理者に共有される集計</h1>"
    assert previews[0].sync_status == "pending"
