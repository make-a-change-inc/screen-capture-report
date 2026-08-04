from __future__ import annotations

import csv
import math
from collections import Counter, defaultdict
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any

from src.config import Settings
from src.storage import Database


def export_accuracy_labels(database: Database, day: date, destination: Path) -> int:
    zone = datetime.now().astimezone().tzinfo
    start = datetime.combine(day, time.min, tzinfo=zone)
    end = start + timedelta(days=1)
    logs = database.list_work_logs(start, end)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "log_id",
                "start_at",
                "end_at",
                "actual_category",
                "expected_category",
            ],
        )
        writer.writeheader()
        for item in logs:
            writer.writerow(
                {
                    "log_id": item["id"],
                    "start_at": item["start_at"],
                    "end_at": item["end_at"],
                    "actual_category": item["category"],
                    "expected_category": "",
                }
            )
    return len(logs)


def calculate_category_accuracy(
    labels_path: Path,
    *,
    allowed_categories: set[str],
    target: float = 0.8,
) -> dict[str, Any]:
    total = 0
    correct = 0
    invalid_rows: list[int] = []
    with labels_path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        required = {"actual_category", "expected_category"}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError("labels CSV is missing required columns")
        for row_number, row in enumerate(reader, start=2):
            actual = (row.get("actual_category") or "").strip()
            expected = (row.get("expected_category") or "").strip()
            if not expected:
                continue
            if actual not in allowed_categories or expected not in allowed_categories:
                invalid_rows.append(row_number)
                continue
            total += 1
            correct += int(actual == expected)
    rate = correct / total if total else None
    return {
        "labelled": total,
        "correct": correct,
        "accuracy": rate,
        "target": target,
        "invalid_rows": invalid_rows,
        "measured": total > 0 and not invalid_rows,
        "passed": bool(total > 0 and not invalid_rows and rate is not None and rate >= target),
    }


def capture_cadence_metrics(
    database: Database,
    day: date,
    settings: Settings,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    zone = datetime.now().astimezone().tzinfo
    start_time = time.fromisoformat(settings.work_start)
    end_time = time.fromisoformat(settings.work_end)
    start = datetime.combine(day, start_time, tzinfo=zone)
    end = datetime.combine(day, end_time, tzinfo=zone)
    current = (now or datetime.now().astimezone()).astimezone(zone)
    end = min(end, max(start, current))
    interval = settings.capture_interval_seconds
    scheduled = (
        math.ceil((end - start).total_seconds() / interval)
        if day.weekday() in settings.work_weekdays
        else 0
    )
    events = database.capture_status_events(start, end)
    slots: dict[int, list[str]] = defaultdict(list)
    counts: Counter[str] = Counter()
    for event in events:
        captured_at = datetime.fromisoformat(event["captured_at"]).astimezone(zone)
        slot = int((captured_at - start).total_seconds() // interval)
        if 0 <= slot < scheduled:
            slots[slot].append(event["status"])
            counts[event["status"]] += 1

    control_events = database.control_events(start, end)
    active_slots: set[int] = set()

    def add_active_slots(begin: datetime, finish: datetime) -> None:
        first = max(0, int((begin - start).total_seconds() // interval))
        stop = min(
            scheduled,
            math.ceil((finish - start).total_seconds() / interval),
        )
        active_slots.update(range(first, stop))

    if control_events:
        state = "paused"
        cursor = start
        for event in control_events:
            occurred_at = datetime.fromisoformat(event["occurred_at"]).astimezone(zone)
            if occurred_at < start:
                state = event["state"]
                continue
            if state == "active" and occurred_at > cursor:
                add_active_slots(cursor, occurred_at)
            state = event["state"]
            cursor = occurred_at
        if state == "active" and end > cursor:
            add_active_slots(cursor, end)
    elif events:
        # Backward-compatible evidence for databases created before control events.
        active_slots.update(range(scheduled))

    successful_statuses = {"captured", "analyzed", "analysis_failed", "expired"}
    ineligible_statuses = {"paused", "locked", "idle", "excluded", "consent_required"}
    successful = 0
    failed = 0
    ineligible = 0
    duplicates = 0
    for slot, statuses in slots.items():
        if slot not in active_slots:
            continue
        duplicates += max(0, len(statuses) - 1)
        if any(status in successful_statuses for status in statuses):
            successful += 1
        elif "capture_failed" in statuses:
            failed += 1
        elif any(status in ineligible_statuses for status in statuses):
            ineligible += 1
    eligible = max(0, len(active_slots) - ineligible)
    missing = max(0, eligible - successful - failed)
    rate = successful / eligible if eligible else None
    return {
        "counts": dict(counts),
        "scheduled_intervals": scheduled,
        "expected_intervals": len(active_slots),
        "ineligible_intervals": ineligible,
        "eligible": eligible,
        "successful": successful,
        "failed": failed,
        "missing_intervals": missing,
        "duplicate_attempts": duplicates,
        "success_rate": rate,
        "target": 0.95,
        "passed": bool(
            eligible and rate is not None and rate >= 0.95 and duplicates == 0
        ),
    }


def daily_operational_metrics(
    database: Database, day: date, settings: Settings
) -> dict[str, Any]:
    zone = datetime.now().astimezone().tzinfo
    start = datetime.combine(day, time.min, tzinfo=zone)
    end = start + timedelta(days=1)
    capture = capture_cadence_metrics(database, day, settings)
    cost = database.cost_summary(start, end)
    return {
        "day": day.isoformat(),
        "capture": capture,
        "cost": cost,
        "passed": bool(capture["passed"] and cost["passed"]),
    }
