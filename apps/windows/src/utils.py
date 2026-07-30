from __future__ import annotations

import logging
import sys
from pathlib import Path

from src.config import get_data_dir


def get_resource_path(relative_path: str) -> Path:
    root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    return root / relative_path


def configure_logging(data_dir: Path | None = None) -> None:
    target = data_dir or get_data_dir()
    target.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        handlers=[
            logging.FileHandler(target / "app.log", encoding="utf-8"),
            logging.StreamHandler(),
        ],
        force=True,
    )
    # Third-party HTTP clients must not emit request payloads or credentials.
    for name in ("httpx", "httpcore", "urllib3", "google"):
        logging.getLogger(name).setLevel(logging.WARNING)


def executable_command() -> str:
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}"'
    return f'"{sys.executable}" -m src.main'
