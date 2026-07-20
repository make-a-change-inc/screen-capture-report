from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from pathlib import PurePosixPath

from src.reporting import ReportService
from src.security import EncryptedFileStore
from src.storage import MANAGEMENT_REPORT_ACCESS, Database


@dataclass(frozen=True, slots=True)
class EmployeeCapture:
    id: str
    captured_at: str
    status: str
    file_path: str


@dataclass(frozen=True, slots=True)
class EmployeeArchiveDay:
    day: date
    report_id: str | None
    report_html: str | None
    captures: tuple[EmployeeCapture, ...]


@dataclass(frozen=True, slots=True)
class ManagementSharePreview:
    report_id: str
    period_start: date
    period_end: date
    report_html: str
    finalized: bool
    sync_status: str


class EmployeeArchive:
    """Narrow, employee-only read model for the local in-process viewer.

    Decrypted bytes are returned only to the caller in memory.  This service
    deliberately exposes neither the management report capability nor a path
    that can read arbitrary encrypted files.
    """

    def __init__(
        self,
        *,
        database: Database,
        files: EncryptedFileStore,
        reports: ReportService,
    ) -> None:
        self._database = database
        self._files = files
        self._reports = reports

    def list_days(self) -> list[EmployeeArchiveDay]:
        reports_by_day = {
            date.fromisoformat(item["period_start"]): item
            for item in self._reports.list_employee_reports()
            if item["kind"] == "daily" and item["audience"] == "employee"
        }
        captures_by_day: dict[date, list[EmployeeCapture]] = {}
        for record in self._database.list_captures():
            if not record.file_path or not self._files.exists(record.file_path):
                continue
            captured_day = datetime.fromisoformat(record.captured_at).astimezone().date()
            captures_by_day.setdefault(captured_day, []).append(
                EmployeeCapture(
                    id=record.id,
                    captured_at=record.captured_at,
                    status=record.status,
                    file_path=record.file_path,
                )
            )

        days = sorted(set(reports_by_day) | set(captures_by_day), reverse=True)
        return [
            EmployeeArchiveDay(
                day=day,
                report_id=(reports_by_day.get(day) or {}).get("id"),
                report_html=(reports_by_day.get(day) or {}).get("payload"),
                captures=tuple(
                    sorted(
                        captures_by_day.get(day, []),
                        key=lambda item: item.captured_at,
                        reverse=True,
                    )
                ),
            )
            for day in days
        ]

    def read_capture(self, capture: EmployeeCapture) -> bytes:
        path = PurePosixPath(capture.file_path.replace("\\", "/"))
        if path.is_absolute() or ".." in path.parts:
            raise PermissionError("invalid_capture_path")
        if len(path.parts) < 3 or path.parts[0] != "captures":
            raise PermissionError("capture_path_outside_employee_archive")
        record = self._database.get_capture(capture.id)
        if record is None or record.file_path != capture.file_path:
            raise FileNotFoundError("capture_record_not_found")
        return self._files.read(capture.file_path)

    def list_management_share_previews(self) -> list[ManagementSharePreview]:
        previews = []
        for report in self._database.list_reports(access=MANAGEMENT_REPORT_ACCESS):
            if report["kind"] != "weekly" or report["audience"] != "management":
                continue
            state = self._database.report_sync_state(report["id"])
            previews.append(
                ManagementSharePreview(
                    report_id=report["id"],
                    period_start=date.fromisoformat(report["period_start"]),
                    period_end=date.fromisoformat(report["period_end"]),
                    report_html=report["payload"] or "",
                    finalized=bool(report["finalized"]),
                    sync_status=str((state or {}).get("status") or "not_queued"),
                )
            )
        return sorted(previews, key=lambda item: item.period_start, reverse=True)
