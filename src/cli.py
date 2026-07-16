from __future__ import annotations

import argparse
import json
from datetime import date
from pathlib import Path

from src.config import SettingsStore, get_data_dir
from src.metrics import (
    calculate_category_accuracy,
    daily_operational_metrics,
    export_accuracy_labels,
)
from src.security import EncryptionService
from src.storage import Database


def _database() -> tuple[Database, SettingsStore]:
    data_dir = get_data_dir()
    encryption = EncryptionService.from_key_file(data_dir / "data-key.dpapi")
    return (
        Database(data_dir / "screen-capture-report.sqlite3", encryption),
        SettingsStore(data_dir / "config.json"),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="ScreenCaptureReport evidence tools")
    subparsers = parser.add_subparsers(dest="command", required=True)

    metrics_parser = subparsers.add_parser("metrics")
    metrics_parser.add_argument("day", type=date.fromisoformat)

    export_parser = subparsers.add_parser("export-labels")
    export_parser.add_argument("day", type=date.fromisoformat)
    export_parser.add_argument("destination", type=Path)

    accuracy_parser = subparsers.add_parser("accuracy")
    accuracy_parser.add_argument("labels", type=Path)

    args = parser.parse_args(argv)
    database, settings_store = _database()
    try:
        if args.command == "metrics":
            result = daily_operational_metrics(database, args.day, settings_store.load())
        elif args.command == "export-labels":
            result = {
                "exported": export_accuracy_labels(database, args.day, args.destination),
                "destination": str(args.destination),
            }
        else:
            settings = settings_store.load()
            result = calculate_category_accuracy(
                args.labels,
                allowed_categories={item["id"] for item in settings.categories},
            )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get("passed", True) else 2
    finally:
        database.close()


if __name__ == "__main__":
    raise SystemExit(main())
