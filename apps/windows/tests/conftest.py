from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest

from src.config import Settings
from src.platform_win import WindowInfo
from src.security import EncryptedFileStore, EncryptionService
from src.storage import Database


@pytest.fixture
def settings() -> Settings:
    value = Settings(
        work_start="00:00",
        work_end="23:59",
        capture_interval_seconds=60,
        idle_threshold_seconds=300,
        analysis_batch_size=5,
    )
    value.grant_consent()
    return value


@pytest.fixture
def encryption() -> EncryptionService:
    return EncryptionService.for_tests()


@pytest.fixture
def database(tmp_path: Path, encryption: EncryptionService):
    value = Database(tmp_path / "app.sqlite3", encryption)
    yield value
    value.close()


@pytest.fixture
def files(tmp_path: Path, encryption: EncryptionService) -> EncryptedFileStore:
    return EncryptedFileStore(tmp_path / "data", encryption)


@dataclass
class FakePlatform:
    window: WindowInfo | None = WindowInfo(
        process_name="editor.exe",
        title="Synthetic test document",
        bounds={"left": 0, "top": 0, "width": 4, "height": 4},
    )
    locked: bool = False
    idle: float = 0.0
    windows: list[WindowInfo] | None = None

    def foreground_window(self) -> WindowInfo | None:
        return self.window

    def visible_windows(self) -> list[WindowInfo]:
        return self.windows if self.windows is not None else ([self.window] if self.window else [])

    def is_locked(self) -> bool:
        return self.locked

    def idle_seconds(self) -> float:
        return self.idle


class FakeScreenshot:
    size = (4, 4)
    bgra = bytes([0, 0, 255, 255] * 16)


class FakeMSS:
    monitors = [
        {"left": 0, "top": 0, "width": 4, "height": 4},
        {"left": 0, "top": 0, "width": 4, "height": 4},
    ]

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def grab(self, _monitor):
        return FakeScreenshot()
