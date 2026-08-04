from __future__ import annotations

import html
from collections import defaultdict
from collections.abc import Callable
from datetime import date, datetime, time, timedelta
from typing import Any

from src.analyzer import AnalysisGateway, ModelResponseError, Usage, WeeklyResponse
from src.config import SecretBackend, Settings
from src.constants import PURPOSE_LIMITATION
from src.notifier import EmailNotifier
from src.security import EncryptedFileStore
from src.storage import EMPLOYEE_REPORT_ACCESS, MANAGEMENT_REPORT_ACCESS, Database


def _local_range(start_day: date, end_day_exclusive: date) -> tuple[datetime, datetime]:
    zone = datetime.now().astimezone().tzinfo
    return (
        datetime.combine(start_day, time.min, tzinfo=zone),
        datetime.combine(end_day_exclusive, time.min, tzinfo=zone),
    )


def aggregate_logs(logs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    minutes: dict[str, float] = defaultdict(float)
    evidence: dict[str, list[str]] = defaultdict(list)
    for item in logs:
        minutes[item["category"]] += float(item["estimated_minutes"])
        evidence[item["category"]].append(item["id"])
    return [
        {
            "category": category,
            "minutes": round(value, 2),
            "evidence_log_ids": evidence[category],
        }
        for category, value in sorted(minutes.items())
    ]


def calculate_unclassified_minutes(
    database: Database,
    day: date,
    settings: Settings,
    logs: list[dict[str, Any]],
    *,
    now: datetime | None = None,
) -> float:
    if day.weekday() not in settings.work_weekdays:
        return 0.0
    zone = datetime.now().astimezone().tzinfo
    start = datetime.combine(day, time.fromisoformat(settings.work_start), tzinfo=zone)
    end = datetime.combine(day, time.fromisoformat(settings.work_end), tzinfo=zone)
    if end <= start:
        end += timedelta(days=1)
    current = (now or datetime.now().astimezone()).astimezone(zone)
    effective_end = min(end, max(start, current))
    control_events = database.control_events(start, effective_end)
    active_intervals: list[tuple[datetime, datetime]] = []
    if control_events:
        state = "paused"
        cursor = start
        for event in control_events:
            occurred_at = datetime.fromisoformat(event["occurred_at"]).astimezone(zone)
            if occurred_at < start:
                state = event["state"]
                continue
            if state == "active" and occurred_at > cursor:
                active_intervals.append((cursor, occurred_at))
            state = event["state"]
            cursor = occurred_at
        if state == "active" and effective_end > cursor:
            active_intervals.append((cursor, effective_end))
    elif database.has_capture_events(start, effective_end):
        # Backward-compatible evidence for databases created before control events.
        active_intervals.append((start, effective_end))

    interval_seconds = settings.capture_interval_seconds
    ineligible_statuses = {"locked", "idle", "excluded", "consent_required"}
    if not control_events:
        ineligible_statuses.add("paused")
    ineligible_slots: set[int] = set()
    for event in database.capture_status_events(start, effective_end):
        if event["status"] not in ineligible_statuses:
            continue
        captured_at = datetime.fromisoformat(event["captured_at"]).astimezone(zone)
        if not any(begin <= captured_at < finish for begin, finish in active_intervals):
            continue
        ineligible_slots.add(int((captured_at - start).total_seconds() // interval_seconds))
    available_minutes = max(
        0.0,
        sum((finish - begin).total_seconds() for begin, finish in active_intervals) / 60
        - len(ineligible_slots) * interval_seconds / 60,
    )
    classified_minutes = sum(float(item["estimated_minutes"]) for item in logs)
    return round(max(0.0, available_minutes - classified_minutes), 2)


class ReportService:
    def __init__(
        self,
        *,
        database: Database,
        files: EncryptedFileStore,
        settings_provider: Callable[[], Settings],
        gateway_provider: Callable[[], AnalysisGateway],
        notifier: EmailNotifier,
        secrets: SecretBackend,
    ):
        self.database = database
        self.files = files
        self.settings_provider = settings_provider
        self.gateway_provider = gateway_provider
        self.notifier = notifier
        self.secrets = secrets

    def employee_destination(self) -> str:
        return self.secrets.get("employee_email") or ""

    def management_destination(self) -> str:
        return self.secrets.get("management_email") or ""

    def identity_context(self) -> dict[str, str]:
        return {
            "employee_id": self.secrets.get("employee_id") or "未設定",
            "department": self.secrets.get("department") or "未設定",
        }

    def list_employee_reports(self) -> list[dict[str, Any]]:
        """Employee-facing reader; management artifacts are never exposed to the tray UI."""
        return self.database.list_reports(access=EMPLOYEE_REPORT_ACCESS)

    def has_daily_data(self, day: date) -> bool:
        start, end = _local_range(day, day + timedelta(days=1))
        events = self.database.capture_status_events(start, end)
        explicit_capture = any(
            event["status"] not in {"outside_hours", "paused", "consent_required"}
            for event in events
        )
        explicit_data = self.database.has_work_logs(start, end) or explicit_capture
        if explicit_data:
            return True
        if day.weekday() not in self.settings_provider().work_weekdays:
            return False
        return self.database.has_active_control_period(start, end)

    def has_weekly_data(self, week_start: date) -> bool:
        start, end = _local_range(week_start, week_start + timedelta(days=7))
        return self.database.has_work_logs(start, end)

    def has_pending_analysis(self, start_day: date, end_day_exclusive: date) -> bool:
        start, end = _local_range(start_day, end_day_exclusive)
        return self.database.has_pending_captures(start, end)

    def generate_daily(
        self, day: date, *, send: bool = True, finalized: bool = False
    ) -> str:
        start, end = _local_range(day, day + timedelta(days=1))
        logs = self.database.list_work_logs(start, end)
        aggregates = aggregate_logs(logs)
        aggregates.append(
            {
                "category": "unclassified",
                "minutes": calculate_unclassified_minutes(
                    self.database,
                    day,
                    self.settings_provider(),
                    logs,
                ),
                "evidence_log_ids": [],
            }
        )
        body = self._daily_html(day, aggregates, logs, self.identity_context())
        path = f"reports/employee/{day.isoformat()}.html.enc"
        self.files.write(path, body.encode("utf-8"))
        report_id = self.database.save_report(
            kind="daily",
            period_start=day,
            period_end=day,
            audience="employee",
            payload=body,
            artifact_path=path,
            finalized=finalized,
        )
        destination = self.employee_destination()
        if send:
            result = self.notifier.send_html(
                destination=destination,
                subject=f"業務日報 {day.isoformat()}",
                html_body=body,
            )
            self.database.record_send(
                report_id,
                "employee",
                destination or None,
                "sent" if result.success else "failed",
                error_code=result.error_code,
                next_retry_at=(
                    None if result.success else datetime.now().astimezone() + timedelta(minutes=1)
                ),
                sent_at=datetime.now().astimezone() if result.success else None,
            )
        return report_id

    def generate_weekly(
        self, week_start: date, *, send: bool = True, finalized: bool = False
    ) -> str:
        week_end = week_start + timedelta(days=6)
        start, end = _local_range(week_start, week_end + timedelta(days=1))
        logs = self.database.list_work_logs(start, end)
        aggregates = aggregate_logs(logs)
        log_ids = [item["id"] for item in logs]
        settings = self.settings_provider()
        if logs:
            attempt_usage = Usage(measured=False)
            try:
                response = self.gateway_provider().weekly_insights(
                    aggregates=aggregates,
                    evidence_log_ids=log_ids,
                )
                attempt_usage = response.usage
                self._validate_evidence(response, set(log_ids))
                body = self._weekly_html(
                    week_start,
                    week_end,
                    aggregates,
                    response,
                    self.identity_context(),
                )
                self._assert_management_boundary(body)
            except Exception as exc:
                if isinstance(exc, ModelResponseError):
                    attempt_usage = exc.usage
                self._record_weekly_cost(attempt_usage, settings)
                raise
        else:
            response = WeeklyResponse([], [], [], Usage())
            body = self._weekly_html(
                week_start,
                week_end,
                aggregates,
                response,
                self.identity_context(),
            )
            self._assert_management_boundary(body)
        self._record_weekly_cost(response.usage, settings)
        path = f"reports/management/{week_start.isoformat()}.html.enc"
        self.files.write(path, body.encode("utf-8"))
        report_id = self.database.save_report(
            kind="weekly",
            period_start=week_start,
            period_end=week_end,
            audience="management",
            payload=body,
            artifact_path=path,
            finalized=finalized,
        )
        destination = self.management_destination()
        if send and destination:
            result = self.notifier.send_html(
                destination=destination,
                subject=f"週次業務改善レポート {week_start}〜{week_end}",
                html_body=body,
            )
            self.database.record_send(
                report_id,
                "management",
                destination,
                "sent" if result.success else "failed",
                error_code=result.error_code,
                next_retry_at=(
                    None if result.success else datetime.now().astimezone() + timedelta(minutes=1)
                ),
                sent_at=datetime.now().astimezone() if result.success else None,
            )
        return report_id

    def retry_failed_sends(self) -> int:
        completed = 0
        for pending in self.database.pending_sends():
            access = (
                EMPLOYEE_REPORT_ACCESS
                if pending["audience"] == "employee"
                else MANAGEMENT_REPORT_ACCESS
            )
            report = self.database.get_report(pending["report_id"], access=access)
            destination = pending["destination"]
            if not report or not destination:
                self.database.update_send_attempt(
                    pending["id"],
                    success=False,
                    error_code="report_or_destination_missing",
                    retry_at=datetime.now().astimezone() + timedelta(hours=1),
                )
                continue
            subject = (
                f"業務日報 {report['period_start']}"
                if pending["audience"] == "employee"
                else f"週次業務改善レポート {report['period_start']}〜{report['period_end']}"
            )
            result = self.notifier.send_html(
                destination=destination,
                subject=subject,
                html_body=report["payload"] or "",
            )
            retry_count = int(pending["retry_count"])
            delay = min(3600, 60 * (2**retry_count))
            self.database.update_send_attempt(
                pending["id"],
                success=result.success,
                error_code=result.error_code,
                retry_at=(
                    None
                    if result.success
                    else datetime.now().astimezone() + timedelta(seconds=delay)
                ),
            )
            completed += int(result.success)
        return completed

    @staticmethod
    def _daily_html(
        day: date,
        aggregates: list[dict[str, Any]],
        logs: list[dict[str, Any]],
        identity: dict[str, str],
    ) -> str:
        aggregate_rows = (
            "".join(
                f"<tr><td>{html.escape(item['category'])}</td><td>{item['minutes']:.2f}</td></tr>"
                for item in aggregates
            )
            or "<tr><td>データなし</td><td>0</td></tr>"
        )
        activity_rows = (
            "".join(
                "<li>"
                f"{html.escape(item['category'])}: {html.escape(item['summary'] or '')} "
                f"({float(item['estimated_minutes']):.2f}分)"
                "</li>"
                for item in logs
            )
            or "<li>データなし</li>"
        )
        return (
            "<!doctype html><html lang='ja'><meta charset='utf-8'>"
            f"<title>業務日報 {day}</title><body><h1>業務日報 {day}</h1>"
            f"<p>対象: {html.escape(identity['employee_id'])} / "
            f"{html.escape(identity['department'])}</p>"
            f"<p>{html.escape(PURPOSE_LIMITATION)}</p>"
            f"<table><thead><tr><th>カテゴリ</th><th>分</th></tr></thead><tbody>{aggregate_rows}</tbody></table>"
            f"<h2>活動</h2><ul>{activity_rows}</ul></body></html>"
        )

    @staticmethod
    def _weekly_html(
        week_start: date,
        week_end: date,
        aggregates: list[dict[str, Any]],
        response: WeeklyResponse,
        identity: dict[str, str],
    ) -> str:
        aggregate_rows = (
            "".join(
                f"<tr><td>{html.escape(item['category'])}</td><td>{item['minutes']:.2f}</td></tr>"
                for item in aggregates
            )
            or "<tr><td>データなし</td><td>0</td></tr>"
        )

        def section(title: str, items: list[dict[str, Any]]) -> str:
            rendered = []
            for item in items:
                rendered.append(
                    "<article>"
                    f"<h3>{html.escape(str(item['title']))}</h3>"
                    f"<p>種別: {html.escape(str(item['proposal_type']))}</p>"
                    f"<p>{html.escape(str(item['description']))}</p>"
                    f"<p>期待効果: {html.escape(str(item['expected_effect']))}</p>"
                    f"<p>前提: {html.escape(', '.join(map(str, item['assumptions'])))}</p>"
                    "<p>根拠ログID: "
                    f"{html.escape(', '.join(map(str, item['evidence_log_ids'])))}"
                    "</p>"
                    "</article>"
                )
            return f"<h2>{title}</h2>{''.join(rendered) or '<p>提案なし</p>'}"

        return (
            "<!doctype html><html lang='ja'><meta charset='utf-8'>"
            f"<title>週次業務改善レポート {week_start}〜{week_end}</title><body>"
            f"<h1>週次業務改善レポート {week_start}〜{week_end}</h1>"
            f"<p>対象: {html.escape(identity['employee_id'])} / "
            f"{html.escape(identity['department'])}</p>"
            f"<p>{html.escape(PURPOSE_LIMITATION)}</p>"
            f"<table><thead><tr><th>カテゴリ</th><th>分</th></tr></thead><tbody>{aggregate_rows}</tbody></table>"
            f"{section('改善方法', response.improvement_methods)}"
            f"{section('AI化候補', response.ai_candidates)}"
            f"{section('期待生産性向上', response.productivity_impacts)}"
            "</body></html>"
        )

    @staticmethod
    def _validate_evidence(response: WeeklyResponse, valid_ids: set[str]) -> None:
        for collection in (
            response.improvement_methods,
            response.ai_candidates,
            response.productivity_impacts,
        ):
            for item in collection:
                if not set(item["evidence_log_ids"]).issubset(valid_ids):
                    raise ValueError("weekly_report_unknown_evidence")

    @staticmethod
    def _assert_management_boundary(body: str) -> None:
        # The footer itself says that ranking is prohibited; inspect the generated
        # content after removing that fixed policy sentence.
        lowered = body.replace(html.escape(PURPOSE_LIMITATION), "").casefold()
        forbidden = [
            "<img",
            ".png",
            "window title",
            "ウィンドウタイトル",
            "ランキング",
            "employee ranking",
            "performance score",
            "査定",
            "懲戒",
        ]
        if any(value in lowered for value in forbidden):
            raise ValueError("management_report_contains_forbidden_data")

    def _record_weekly_cost(self, usage: Usage, settings: Settings) -> None:
        configured = bool(
            settings.token_input_jpy_per_million or settings.token_output_jpy_per_million
        )
        cost = None
        if configured and usage.measured:
            cost = (
                usage.input_tokens * settings.token_input_jpy_per_million
                + usage.output_tokens * settings.token_output_jpy_per_million
            ) / 1_000_000
        self.database.add_cost(
            operation="weekly_report",
            model=settings.report_model,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            cost_jpy=cost,
            is_estimate=not (configured and usage.measured),
        )
