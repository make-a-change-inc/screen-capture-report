from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

from src.security import EncryptionService


def utcnow() -> datetime:
    return datetime.now(UTC)


def iso(value: datetime | None = None) -> str:
    return (value or utcnow()).astimezone(UTC).isoformat()


@dataclass(slots=True)
class CaptureRecord:
    id: str
    captured_at: str
    status: str
    process_name: str | None
    window_title: str | None
    rule_id: str | None
    file_path: str | None
    error_code: str | None
    retry_count: int
    next_retry_at: str | None
    analyzed_at: str | None


@dataclass(frozen=True, slots=True)
class ReportAccess:
    audience: str


# Capability objects are passed only to trusted application services. The tray
# receives employee-facing methods, never the management capability or a DB handle.
EMPLOYEE_REPORT_ACCESS = ReportAccess("employee")
MANAGEMENT_REPORT_ACCESS = ReportAccess("management")


def _authorized_audience(access: ReportAccess) -> str:
    if access is EMPLOYEE_REPORT_ACCESS:
        return "employee"
    if access is MANAGEMENT_REPORT_ACCESS:
        return "management"
    raise PermissionError("invalid_report_access_capability")


class Database:
    def __init__(self, path: Path, encryption: EncryptionService):
        self.path = path
        self.encryption = encryption
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(self.path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA foreign_keys=ON")
        self._initialize()

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def _initialize(self) -> None:
        with self._lock, self._connection:
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS captures (
                    id TEXT PRIMARY KEY,
                    captured_at TEXT NOT NULL,
                    status TEXT NOT NULL,
                    process_name_enc BLOB,
                    window_title_enc BLOB,
                    rule_id TEXT,
                    file_path TEXT,
                    error_code TEXT,
                    retry_count INTEGER NOT NULL DEFAULT 0,
                    next_retry_at TEXT,
                    analyzed_at TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_captures_pending
                    ON captures(status, next_retry_at, captured_at);

                CREATE TABLE IF NOT EXISTS work_logs (
                    id TEXT PRIMARY KEY,
                    start_at TEXT NOT NULL,
                    end_at TEXT NOT NULL,
                    category TEXT NOT NULL,
                    summary_enc BLOB NOT NULL,
                    confidence REAL NOT NULL,
                    estimated_minutes REAL NOT NULL,
                    capture_ids_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_work_logs_start ON work_logs(start_at);

                CREATE TABLE IF NOT EXISTS reports (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    period_start TEXT NOT NULL,
                    period_end TEXT NOT NULL,
                    audience TEXT NOT NULL,
                    payload_enc BLOB NOT NULL,
                    artifact_path TEXT NOT NULL,
                    finalized INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    UNIQUE(kind, period_start, audience)
                );

                CREATE TABLE IF NOT EXISTS send_log (
                    id TEXT PRIMARY KEY,
                    report_id TEXT NOT NULL,
                    audience TEXT NOT NULL,
                    destination_enc BLOB,
                    status TEXT NOT NULL,
                    error_code TEXT,
                    retry_count INTEGER NOT NULL DEFAULT 0,
                    next_retry_at TEXT,
                    sent_at TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(report_id) REFERENCES reports(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS cost_ledger (
                    id TEXT PRIMARY KEY,
                    occurred_at TEXT NOT NULL,
                    operation TEXT NOT NULL,
                    model TEXT NOT NULL,
                    input_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0,
                    cost_jpy REAL,
                    is_estimate INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS retention_audit (
                    id TEXT PRIMARY KEY,
                    occurred_at TEXT NOT NULL,
                    data_type TEXT NOT NULL,
                    item_id TEXT NOT NULL,
                    reason TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS control_events (
                    id TEXT PRIMARY KEY,
                    occurred_at TEXT NOT NULL,
                    state TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_control_events_time
                    ON control_events(occurred_at);

                CREATE TABLE IF NOT EXISTS report_jobs (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    period_start TEXT NOT NULL,
                    status TEXT NOT NULL,
                    error_code TEXT,
                    retry_count INTEGER NOT NULL DEFAULT 0,
                    next_retry_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(kind, period_start)
                );
                """
            )
            report_columns = {
                row["name"]
                for row in self._connection.execute("PRAGMA table_info(reports)").fetchall()
            }
            if "finalized" not in report_columns:
                self._connection.execute(
                    "ALTER TABLE reports ADD COLUMN finalized INTEGER NOT NULL DEFAULT 0"
                )

    def record_capture(
        self,
        status: str,
        *,
        captured_at: datetime | None = None,
        process_name: str | None = None,
        window_title: str | None = None,
        rule_id: str | None = None,
        file_path: str | None = None,
        error_code: str | None = None,
        capture_id: str | None = None,
    ) -> str:
        capture_id = capture_id or str(uuid.uuid4())
        with self._lock, self._connection:
            self._connection.execute(
                """INSERT INTO captures (
                    id, captured_at, status, process_name_enc, window_title_enc,
                    rule_id, file_path, error_code, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    capture_id,
                    iso(captured_at),
                    status,
                    self.encryption.encrypt_text(process_name),
                    self.encryption.encrypt_text(window_title),
                    rule_id,
                    file_path,
                    error_code,
                    iso(),
                ),
            )
        return capture_id

    def get_capture(self, capture_id: str) -> CaptureRecord | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM captures WHERE id = ?", (capture_id,)
            ).fetchone()
        return self._capture_from_row(row) if row else None

    def list_captures(self, *, status: str | None = None) -> list[CaptureRecord]:
        query = "SELECT * FROM captures"
        params: tuple[Any, ...] = ()
        if status:
            query += " WHERE status = ?"
            params = (status,)
        query += " ORDER BY captured_at"
        with self._lock:
            rows = self._connection.execute(query, params).fetchall()
        return [self._capture_from_row(row) for row in rows]

    def pending_captures(
        self,
        limit: int = 20,
        at: datetime | None = None,
        *,
        ignore_retry_at: bool = False,
    ) -> list[CaptureRecord]:
        threshold = iso(at)
        with self._lock:
            if ignore_retry_at:
                rows = self._connection.execute(
                    """SELECT * FROM captures
                       WHERE status IN ('captured', 'analysis_failed')
                       ORDER BY captured_at LIMIT ?""",
                    (limit,),
                ).fetchall()
            else:
                rows = self._connection.execute(
                    """SELECT * FROM captures
                       WHERE status IN ('captured', 'analysis_failed')
                         AND (next_retry_at IS NULL OR next_retry_at <= ?)
                       ORDER BY captured_at LIMIT ?""",
                    (threshold, limit),
                ).fetchall()
        return [self._capture_from_row(row) for row in rows]

    def mark_analysis_failed(
        self,
        capture_ids: Iterable[str],
        error_code: str,
        *,
        retry_at: datetime,
    ) -> None:
        ids = list(capture_ids)
        if not ids:
            return
        with self._lock, self._connection:
            self._connection.executemany(
                """UPDATE captures
                   SET status='analysis_failed', error_code=?, retry_count=retry_count+1,
                       next_retry_at=? WHERE id=?""",
                [(error_code, iso(retry_at), capture_id) for capture_id in ids],
            )

    def mark_analyzed(self, capture_ids: Iterable[str]) -> None:
        ids = list(capture_ids)
        with self._lock, self._connection:
            self._connection.executemany(
                """UPDATE captures SET status='analyzed', analyzed_at=?,
                   next_retry_at=NULL, error_code=NULL WHERE id=?""",
                [(iso(), capture_id) for capture_id in ids],
            )

    def clear_capture_file(self, capture_id: str) -> None:
        with self._lock, self._connection:
            self._connection.execute("UPDATE captures SET file_path=NULL WHERE id=?", (capture_id,))

    def add_work_log(
        self,
        *,
        start_at: datetime,
        end_at: datetime,
        category: str,
        summary: str,
        confidence: float,
        estimated_minutes: float,
        capture_ids: list[str],
    ) -> str:
        log_id = str(uuid.uuid4())
        with self._lock, self._connection:
            self._connection.execute(
                """INSERT INTO work_logs (
                    id, start_at, end_at, category, summary_enc, confidence,
                    estimated_minutes, capture_ids_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    log_id,
                    iso(start_at),
                    iso(end_at),
                    category,
                    self.encryption.encrypt_text(summary),
                    confidence,
                    estimated_minutes,
                    json.dumps(capture_ids),
                    iso(),
                ),
            )
        return log_id

    def complete_analysis(
        self,
        *,
        capture_ids: list[str],
        logs: list[dict[str, Any]],
        cost: dict[str, Any],
    ) -> None:
        """Commit derived logs, capture state, and metering as one durable unit."""
        if not capture_ids:
            return
        completed_at = iso()
        with self._lock, self._connection:
            for item in logs:
                self._connection.execute(
                    """INSERT INTO work_logs (
                        id, start_at, end_at, category, summary_enc, confidence,
                        estimated_minutes, capture_ids_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        str(uuid.uuid4()),
                        iso(item["start_at"]),
                        iso(item["end_at"]),
                        item["category"],
                        self.encryption.encrypt_text(item["summary"]),
                        item["confidence"],
                        item["estimated_minutes"],
                        json.dumps(item["capture_ids"]),
                        completed_at,
                    ),
                )
            self._connection.executemany(
                """UPDATE captures SET status='analyzed', analyzed_at=?,
                   next_retry_at=NULL, error_code=NULL WHERE id=?""",
                [(completed_at, capture_id) for capture_id in capture_ids],
            )
            self._connection.execute(
                "INSERT INTO cost_ledger VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    str(uuid.uuid4()),
                    completed_at,
                    cost["operation"],
                    cost["model"],
                    cost["input_tokens"],
                    cost["output_tokens"],
                    cost["cost_jpy"],
                    int(cost["is_estimate"]),
                ),
            )

    def list_work_logs(self, start: datetime, end: datetime) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                """SELECT * FROM work_logs WHERE start_at >= ? AND start_at < ?
                   ORDER BY start_at""",
                (iso(start), iso(end)),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "start_at": row["start_at"],
                "end_at": row["end_at"],
                "category": row["category"],
                "summary": self.encryption.decrypt_text(row["summary_enc"]),
                "confidence": row["confidence"],
                "estimated_minutes": row["estimated_minutes"],
                "capture_ids": json.loads(row["capture_ids_json"]),
            }
            for row in rows
        ]

    def has_work_logs(self, start: datetime, end: datetime) -> bool:
        with self._lock:
            row = self._connection.execute(
                "SELECT 1 FROM work_logs WHERE start_at >= ? AND start_at < ? LIMIT 1",
                (iso(start), iso(end)),
            ).fetchone()
        return bool(row)

    def has_pending_captures(self, start: datetime, end: datetime) -> bool:
        with self._lock:
            row = self._connection.execute(
                """SELECT 1 FROM captures
                   WHERE captured_at >= ? AND captured_at < ?
                     AND status IN ('captured', 'analysis_failed') LIMIT 1""",
                (iso(start), iso(end)),
            ).fetchone()
        return bool(row)

    def has_capture_events(self, start: datetime, end: datetime) -> bool:
        with self._lock:
            row = self._connection.execute(
                "SELECT 1 FROM captures WHERE captured_at >= ? AND captured_at < ? LIMIT 1",
                (iso(start), iso(end)),
            ).fetchone()
        return bool(row)

    def record_control_event(self, state: str, *, at: datetime | None = None) -> str:
        if state not in {"active", "paused"}:
            raise ValueError("invalid_control_state")
        event_id = str(uuid.uuid4())
        with self._lock, self._connection:
            self._connection.execute(
                "INSERT INTO control_events VALUES (?, ?, ?)",
                (event_id, iso(at), state),
            )
        return event_id

    def control_events(self, start: datetime, end: datetime) -> list[dict[str, str]]:
        with self._lock:
            prior = self._connection.execute(
                """SELECT occurred_at, state FROM control_events
                   WHERE occurred_at < ? ORDER BY occurred_at DESC LIMIT 1""",
                (iso(start),),
            ).fetchone()
            rows = self._connection.execute(
                """SELECT occurred_at, state FROM control_events
                   WHERE occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at""",
                (iso(start), iso(end)),
            ).fetchall()
        result = [dict(prior)] if prior else []
        result.extend(dict(row) for row in rows)
        return result

    def has_active_control_period(self, start: datetime, end: datetime) -> bool:
        events = self.control_events(start, end)
        if not events:
            return False
        state = "paused"
        cursor = start
        for event in events:
            occurred_at = datetime.fromisoformat(event["occurred_at"])
            if occurred_at < start:
                state = event["state"]
                continue
            if state == "active" and occurred_at > cursor:
                return True
            state = event["state"]
            cursor = occurred_at
        return state == "active" and end > cursor

    def report_job_can_attempt(
        self,
        kind: str,
        period_start: date,
        *,
        at: datetime,
    ) -> bool:
        with self._lock:
            row = self._connection.execute(
                """SELECT status, next_retry_at FROM report_jobs
                   WHERE kind=? AND period_start=?""",
                (kind, period_start.isoformat()),
            ).fetchone()
        if not row:
            return True
        if row["status"] == "succeeded":
            return False
        return row["next_retry_at"] is None or row["next_retry_at"] <= iso(at)

    def report_job_retry_count(self, kind: str, period_start: date) -> int:
        with self._lock:
            row = self._connection.execute(
                "SELECT retry_count FROM report_jobs WHERE kind=? AND period_start=?",
                (kind, period_start.isoformat()),
            ).fetchone()
        return int(row["retry_count"]) if row else 0

    def mark_report_job_failed(
        self,
        kind: str,
        period_start: date,
        *,
        error_code: str,
        retry_at: datetime,
    ) -> None:
        now = iso()
        with self._lock, self._connection:
            self._connection.execute(
                """INSERT INTO report_jobs (
                    id, kind, period_start, status, error_code, retry_count,
                    next_retry_at, created_at, updated_at
                ) VALUES (?, ?, ?, 'failed', ?, 1, ?, ?, ?)
                ON CONFLICT(kind, period_start) DO UPDATE SET
                    status='failed', error_code=excluded.error_code,
                    retry_count=report_jobs.retry_count+1,
                    next_retry_at=excluded.next_retry_at,
                    updated_at=excluded.updated_at""",
                (
                    str(uuid.uuid4()),
                    kind,
                    period_start.isoformat(),
                    error_code,
                    iso(retry_at),
                    now,
                    now,
                ),
            )

    def mark_report_job_succeeded(self, kind: str, period_start: date) -> None:
        now = iso()
        with self._lock, self._connection:
            self._connection.execute(
                """INSERT INTO report_jobs (
                    id, kind, period_start, status, error_code, retry_count,
                    next_retry_at, created_at, updated_at
                ) VALUES (?, ?, ?, 'succeeded', NULL, 0, NULL, ?, ?)
                ON CONFLICT(kind, period_start) DO UPDATE SET
                    status='succeeded', error_code=NULL, next_retry_at=NULL,
                    updated_at=excluded.updated_at""",
                (str(uuid.uuid4()), kind, period_start.isoformat(), now, now),
            )

    def save_report(
        self,
        *,
        kind: str,
        period_start: date,
        period_end: date,
        audience: str,
        payload: str,
        artifact_path: str,
        finalized: bool = False,
    ) -> str:
        report_id = str(uuid.uuid4())
        with self._lock, self._connection:
            existing = self._connection.execute(
                "SELECT id FROM reports WHERE kind=? AND period_start=? AND audience=?",
                (kind, period_start.isoformat(), audience),
            ).fetchone()
            if existing:
                report_id = existing["id"]
                self._connection.execute(
                    """UPDATE reports SET period_end=?, payload_enc=?, artifact_path=?,
                       finalized=CASE WHEN finalized=1 THEN 1 ELSE ? END,
                       created_at=? WHERE id=?""",
                    (
                        period_end.isoformat(),
                        self.encryption.encrypt_text(payload),
                        artifact_path,
                        int(finalized),
                        iso(),
                        report_id,
                    ),
                )
            else:
                self._connection.execute(
                    """INSERT INTO reports (
                        id, kind, period_start, period_end, audience,
                        payload_enc, artifact_path, finalized, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        report_id,
                        kind,
                        period_start.isoformat(),
                        period_end.isoformat(),
                        audience,
                        self.encryption.encrypt_text(payload),
                        artifact_path,
                        int(finalized),
                        iso(),
                    ),
                )
        return report_id

    def get_report(self, report_id: str, *, access: ReportAccess) -> dict[str, Any] | None:
        audience = _authorized_audience(access)
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM reports WHERE id=? AND audience=?",
                (report_id, audience),
            ).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "kind": row["kind"],
            "period_start": row["period_start"],
            "period_end": row["period_end"],
            "audience": row["audience"],
            "payload": self.encryption.decrypt_text(row["payload_enc"]),
            "artifact_path": row["artifact_path"],
            "finalized": bool(row["finalized"]),
        }

    def report_exists(
        self,
        kind: str,
        period_start: date,
        audience: str,
        *,
        finalized_only: bool = False,
    ) -> bool:
        query = "SELECT 1 FROM reports WHERE kind=? AND period_start=? AND audience=?"
        if finalized_only:
            query += " AND finalized=1"
        with self._lock:
            row = self._connection.execute(
                query,
                (kind, period_start.isoformat(), audience),
            ).fetchone()
        return bool(row)

    def list_reports(self, *, access: ReportAccess) -> list[dict[str, Any]]:
        audience = _authorized_audience(access)
        with self._lock:
            rows = self._connection.execute(
                "SELECT id FROM reports WHERE audience=? ORDER BY period_start",
                (audience,),
            ).fetchall()
        reports = []
        for row in rows:
            report = self.get_report(row["id"], access=access)
            if report is not None:
                reports.append(report)
        return reports

    def record_send(
        self,
        report_id: str,
        audience: str,
        destination: str | None,
        status: str,
        *,
        error_code: str | None = None,
        retry_count: int = 0,
        next_retry_at: datetime | None = None,
        sent_at: datetime | None = None,
    ) -> str:
        send_id = str(uuid.uuid4())
        with self._lock, self._connection:
            self._connection.execute(
                """INSERT INTO send_log (
                    id, report_id, audience, destination_enc, status, error_code,
                    retry_count, next_retry_at, sent_at, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    send_id,
                    report_id,
                    audience,
                    self.encryption.encrypt_text(destination),
                    status,
                    error_code,
                    retry_count,
                    iso(next_retry_at) if next_retry_at else None,
                    iso(sent_at) if sent_at else None,
                    iso(),
                ),
            )
        return send_id

    def pending_sends(self, at: datetime | None = None) -> list[dict[str, Any]]:
        threshold = iso(at)
        with self._lock:
            rows = self._connection.execute(
                """SELECT * FROM send_log
                   WHERE status='failed' AND (next_retry_at IS NULL OR next_retry_at <= ?)
                   ORDER BY created_at LIMIT 20""",
                (threshold,),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "report_id": row["report_id"],
                "audience": row["audience"],
                "destination": self.encryption.decrypt_text(row["destination_enc"]),
                "retry_count": row["retry_count"],
            }
            for row in rows
        ]

    def update_send_attempt(
        self,
        send_id: str,
        *,
        success: bool,
        error_code: str | None,
        retry_at: datetime | None,
    ) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                """UPDATE send_log SET status=?, error_code=?, retry_count=retry_count+1,
                   next_retry_at=?, sent_at=? WHERE id=?""",
                (
                    "sent" if success else "failed",
                    error_code,
                    iso(retry_at) if retry_at else None,
                    iso() if success else None,
                    send_id,
                ),
            )

    def expire_capture(self, capture_id: str) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                "UPDATE captures SET status='expired', file_path=NULL WHERE id=?",
                (capture_id,),
            )

    def add_cost(
        self,
        *,
        operation: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        cost_jpy: float | None,
        is_estimate: bool,
    ) -> str:
        cost_id = str(uuid.uuid4())
        with self._lock, self._connection:
            self._connection.execute(
                """INSERT INTO cost_ledger VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    cost_id,
                    iso(),
                    operation,
                    model,
                    input_tokens,
                    output_tokens,
                    cost_jpy,
                    int(is_estimate),
                ),
            )
        return cost_id

    def capture_metrics(self, start: datetime, end: datetime) -> dict[str, Any]:
        with self._lock:
            rows = self._connection.execute(
                """SELECT status, COUNT(*) AS count FROM captures
                   WHERE captured_at >= ? AND captured_at < ? GROUP BY status""",
                (iso(start), iso(end)),
            ).fetchall()
        counts = {row["status"]: int(row["count"]) for row in rows}
        successful_statuses = {"captured", "analyzed", "analysis_failed", "expired"}
        successful = sum(counts.get(status, 0) for status in successful_statuses)
        eligible = successful + counts.get("capture_failed", 0)
        return {
            "counts": counts,
            "successful": successful,
            "eligible": eligible,
            "success_rate": (successful / eligible) if eligible else None,
            "target": 0.95,
            "passed": bool(eligible and successful / eligible >= 0.95),
        }

    def capture_status_events(self, start: datetime, end: datetime) -> list[dict[str, str]]:
        with self._lock:
            rows = self._connection.execute(
                """SELECT captured_at, status FROM captures
                   WHERE captured_at >= ? AND captured_at < ? ORDER BY captured_at""",
                (iso(start), iso(end)),
            ).fetchall()
        return [dict(row) for row in rows]

    def cost_summary(self, start: datetime, end: datetime) -> dict[str, Any]:
        with self._lock:
            row = self._connection.execute(
                """SELECT COUNT(*) AS events, SUM(cost_jpy) AS total_cost,
                   SUM(CASE WHEN cost_jpy IS NULL OR is_estimate=1 THEN 1 ELSE 0 END)
                   AS unmeasured
                   FROM cost_ledger WHERE occurred_at >= ? AND occurred_at < ?""",
                (iso(start), iso(end)),
            ).fetchone()
        events = int(row["events"] or 0)
        unmeasured = int(row["unmeasured"] or 0)
        total = float(row["total_cost"]) if row["total_cost"] is not None else None
        measured = events > 0 and unmeasured == 0 and total is not None
        passed = measured and total is not None and total <= 100.0
        return {
            "events": events,
            "cost_jpy": total,
            "unmeasured_events": unmeasured,
            "target_jpy": 100.0,
            "measured": measured,
            "passed": passed,
        }

    def retention_cleanup(
        self,
        *,
        now: datetime,
        log_days: int,
        report_days: int,
    ) -> dict[str, int]:
        log_cutoff = iso(now - timedelta(days=log_days))
        report_cutoff = (now.date() - timedelta(days=report_days)).isoformat()
        counts = {
            "captures": 0,
            "work_logs": 0,
            "reports": 0,
            "control_events": 0,
            "report_jobs": 0,
        }
        with self._lock, self._connection:
            capture_rows = self._connection.execute(
                "SELECT id FROM captures WHERE captured_at < ? AND file_path IS NULL",
                (log_cutoff,),
            ).fetchall()
            log_rows = self._connection.execute(
                "SELECT id FROM work_logs WHERE start_at < ?", (log_cutoff,)
            ).fetchall()
            report_rows = self._connection.execute(
                "SELECT id FROM reports WHERE period_end < ?", (report_cutoff,)
            ).fetchall()
            control_rows = self._connection.execute(
                """SELECT id FROM control_events WHERE occurred_at < ?
                   AND id NOT IN (
                       SELECT id FROM control_events ORDER BY occurred_at DESC LIMIT 1
                   )""",
                (log_cutoff,),
            ).fetchall()
            report_job_rows = self._connection.execute(
                "SELECT id FROM report_jobs WHERE period_start < ?", (report_cutoff,)
            ).fetchall()
            for row in capture_rows:
                self._audit_locked("capture_metadata", row["id"], "retention_expired")
            for row in log_rows:
                self._audit_locked("work_log", row["id"], "retention_expired")
            for row in report_rows:
                self._audit_locked("report", row["id"], "retention_expired")
            for row in control_rows:
                self._audit_locked("control_event", row["id"], "retention_expired")
            for row in report_job_rows:
                self._audit_locked("report_job", row["id"], "retention_expired")
            if capture_rows:
                self._connection.executemany(
                    "DELETE FROM captures WHERE id=?",
                    [(row["id"],) for row in capture_rows],
                )
            if log_rows:
                self._connection.executemany(
                    "DELETE FROM work_logs WHERE id=?", [(row["id"],) for row in log_rows]
                )
            if report_rows:
                self._connection.executemany(
                    "DELETE FROM reports WHERE id=?", [(row["id"],) for row in report_rows]
                )
            if control_rows:
                self._connection.executemany(
                    "DELETE FROM control_events WHERE id=?",
                    [(row["id"],) for row in control_rows],
                )
            if report_job_rows:
                self._connection.executemany(
                    "DELETE FROM report_jobs WHERE id=?",
                    [(row["id"],) for row in report_job_rows],
                )
            counts["captures"] = len(capture_rows)
            counts["work_logs"] = len(log_rows)
            counts["reports"] = len(report_rows)
            counts["control_events"] = len(control_rows)
            counts["report_jobs"] = len(report_job_rows)
        return counts

    def expired_report_artifacts(self, *, now: datetime, report_days: int) -> list[dict[str, str]]:
        cutoff = (now.date() - timedelta(days=report_days)).isoformat()
        with self._lock:
            rows = self._connection.execute(
                "SELECT id, artifact_path FROM reports WHERE period_end < ?",
                (cutoff,),
            ).fetchall()
        return [dict(row) for row in rows]

    def audit_retention(self, data_type: str, item_id: str, reason: str) -> None:
        with self._lock, self._connection:
            self._audit_locked(data_type, item_id, reason)

    def _audit_locked(self, data_type: str, item_id: str, reason: str) -> None:
        self._connection.execute(
            "INSERT INTO retention_audit VALUES (?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), iso(), data_type, item_id, reason),
        )

    def retention_events(self) -> list[dict[str, str]]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM retention_audit ORDER BY occurred_at"
            ).fetchall()
        return [dict(row) for row in rows]

    def _capture_from_row(self, row: sqlite3.Row) -> CaptureRecord:
        return CaptureRecord(
            id=row["id"],
            captured_at=row["captured_at"],
            status=row["status"],
            process_name=self.encryption.decrypt_text(row["process_name_enc"]),
            window_title=self.encryption.decrypt_text(row["window_title_enc"]),
            rule_id=row["rule_id"],
            file_path=row["file_path"],
            error_code=row["error_code"],
            retry_count=row["retry_count"],
            next_retry_at=row["next_retry_at"],
            analyzed_at=row["analyzed_at"],
        )
