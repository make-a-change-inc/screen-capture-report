from __future__ import annotations

import csv
from datetime import date, datetime, time, timedelta
from pathlib import Path

from src.metrics import calculate_category_accuracy, daily_operational_metrics


def test_category_accuracy_requires_labelled_rows(tmp_path: Path) -> None:
    path = tmp_path / "labels.csv"
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["actual_category", "expected_category"])
        writer.writeheader()
        writer.writerow({"actual_category": "development", "expected_category": "development"})
        writer.writerow({"actual_category": "research", "expected_category": "development"})

    result = calculate_category_accuracy(path, allowed_categories={"development", "research"})

    assert result["accuracy"] == 0.5
    assert not result["passed"]


def test_daily_metrics_do_not_pass_missing_measurements(database, settings) -> None:
    zone = datetime.now().astimezone().tzinfo
    settings.work_start = "10:00"
    settings.work_end = "10:02"
    settings.capture_interval_seconds = 60
    day = date(2026, 7, 13)
    start = datetime.combine(day, time(10), tzinfo=zone)
    database.record_capture("captured", captured_at=start)
    database.record_capture("capture_failed", captured_at=start + timedelta(minutes=1))

    result = daily_operational_metrics(database, day, settings)

    assert result["capture"]["success_rate"] == 0.5
    assert not result["capture"]["passed"]
    assert not result["cost"]["measured"]
    assert not result["cost"]["passed"]
    assert not result["passed"]


def test_daily_metrics_count_process_downtime_as_missing(database, settings) -> None:
    zone = datetime.now().astimezone().tzinfo
    settings.work_start = "10:00"
    settings.work_end = "10:03"
    settings.capture_interval_seconds = 60
    day = date(2026, 7, 13)
    start = datetime.combine(day, time(10), tzinfo=zone)
    database.record_capture("captured", captured_at=start)

    result = daily_operational_metrics(database, day, settings)

    assert result["capture"]["expected_intervals"] == 3
    assert result["capture"]["missing_intervals"] == 2
    assert result["capture"]["success_rate"] == 1 / 3
    assert not result["capture"]["passed"]


def test_paused_control_period_is_removed_from_expected_intervals(database, settings) -> None:
    zone = datetime.now().astimezone().tzinfo
    day = date(2026, 7, 13)
    settings.work_start = "10:00"
    settings.work_end = "10:03"
    settings.capture_interval_seconds = 60
    start = datetime.combine(day, time(10), tzinfo=zone)
    database.record_control_event("active", at=start)
    database.record_capture("captured", captured_at=start)
    database.record_control_event("paused", at=start + timedelta(minutes=1))

    result = daily_operational_metrics(database, day, settings)

    assert result["capture"]["scheduled_intervals"] == 3
    assert result["capture"]["expected_intervals"] == 1
    assert result["capture"]["success_rate"] == 1.0
