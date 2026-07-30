from __future__ import annotations

from datetime import UTC, datetime

from src.capturer import ScreenCapturer
from src.platform_win import WindowInfo

from .conftest import FakeMSS, FakePlatform

NOW = datetime(2026, 7, 16, 10, 0, tzinfo=UTC)


def build_capturer(database, files, settings, platform):
    return ScreenCapturer(
        database=database,
        files=files,
        settings_provider=lambda: settings,
        platform_state=platform,
        mss_factory=FakeMSS,
    )


def test_capture_requires_consent(database, files, settings) -> None:
    settings.consented_at = ""
    capturer = build_capturer(database, files, settings, FakePlatform())

    capture_id = capturer.capture(now=NOW)

    assert database.get_capture(capture_id).status == "consent_required"


def test_capture_records_ineligible_states(database, files, settings) -> None:
    platform = FakePlatform(locked=True)
    capturer = build_capturer(database, files, settings, platform)
    assert database.get_capture(capturer.capture(now=NOW)).status == "locked"

    platform.locked = False
    platform.idle = 301
    assert database.get_capture(capturer.capture(now=NOW)).status == "idle"

    platform.idle = 0
    assert database.get_capture(capturer.capture(now=NOW, paused=True)).status == "paused"

    settings.work_start = "11:00"
    settings.work_end = "12:00"
    assert database.get_capture(capturer.capture(now=NOW)).status == "outside_hours"


def test_exclusion_happens_before_pixel_capture(database, files, settings) -> None:
    platform = FakePlatform(
        window=WindowInfo(
            process_name="editor.exe",
            title="給与 and private data",
            bounds={"left": 0, "top": 0, "width": 4, "height": 4},
        )
    )

    class MustNotCapture:
        def __init__(self):
            raise AssertionError("pixels must not be captured")

    capturer = ScreenCapturer(
        database=database,
        files=files,
        settings_provider=lambda: settings,
        platform_state=platform,
        mss_factory=MustNotCapture,
    )
    capture_id = capturer.capture(now=NOW)
    record = database.get_capture(capture_id)

    assert record.status == "excluded"
    assert record.rule_id.startswith("title_keyword:")
    assert record.window_title is None
    assert record.file_path is None


def test_successful_capture_is_encrypted(database, files, settings) -> None:
    capturer = build_capturer(database, files, settings, FakePlatform())

    capture_id = capturer.capture(now=NOW)
    record = database.get_capture(capture_id)

    assert record.status == "captured"
    assert record.file_path
    assert files.exists(record.file_path)
    assert files.read(record.file_path).startswith(b"\x89PNG")
    assert not (files.root / record.file_path).read_bytes().startswith(b"\x89PNG")
    raw_database = database.path.read_bytes()
    assert b"Synthetic test document" not in raw_database
    assert b"editor.exe" not in raw_database


def test_all_monitor_mode(database, files, settings) -> None:
    settings.capture_mode = "all_screens"
    capturer = build_capturer(database, files, settings, FakePlatform())

    capture_id = capturer.capture(now=NOW)

    assert database.get_capture(capture_id).status == "captured"


def test_all_monitor_mode_fails_closed_for_excluded_secondary_window(
    database, files, settings
) -> None:
    settings.capture_mode = "all_screens"
    allowed = WindowInfo(
        process_name="editor.exe",
        title="Synthetic work",
        bounds={"left": 0, "top": 0, "width": 4, "height": 4},
    )
    excluded = WindowInfo(
        process_name="1password.exe",
        title="",
        bounds={"left": 5, "top": 0, "width": 4, "height": 4},
    )
    platform = FakePlatform(window=allowed, windows=[allowed, excluded])
    capturer = build_capturer(database, files, settings, platform)

    record = database.get_capture(capturer.capture(now=NOW))

    assert record is not None
    assert record.status == "excluded"
    assert record.rule_id == "all_screens:process:0"
    assert record.file_path is None


def test_process_exclusions_fail_closed_when_process_is_uninspectable(
    database, files, settings
) -> None:
    platform = FakePlatform(
        window=WindowInfo(
            process_name="unknown",
            title="Synthetic work",
            bounds={"left": 0, "top": 0, "width": 4, "height": 4},
            process_inspectable=False,
        )
    )
    capturer = build_capturer(database, files, settings, platform)

    record = database.get_capture(capturer.capture(now=NOW))

    assert record is not None
    assert record.status == "excluded"
    assert record.rule_id == "process:inspection_failed"
