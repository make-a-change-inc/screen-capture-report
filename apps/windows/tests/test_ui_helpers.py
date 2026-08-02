import json
import time
from pathlib import Path

from src.config import MemorySecretStore, Settings, SettingsStore
from src.service import CaptureNotCompleted
from src.ui import WindowsTrayUI, _HTMLTextExtractor, onboarding_notice


class RecordingService:
    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.paused = False

    def start(self) -> None:
        self.events.append("service.start")

    def stop(self) -> None:
        self.events.append("service.stop")


class RecordingPlatform:
    def __init__(self) -> None:
        self.notifications: list[tuple[str, str]] = []
        self.opened_paths: list[Path] = []

    def notify(self, title: str, message: str) -> None:
        self.notifications.append((title, message))

    def open_path(self, path: Path) -> None:
        self.opened_paths.append(path)


class RecordingIcon:
    def __init__(self, events: list[str], *, fail_visibility: bool = False) -> None:
        self.events = events
        self.fail_visibility = fail_visibility
        self._visible = False
        self.stopped = False

    @property
    def visible(self) -> bool:
        return self._visible

    @visible.setter
    def visible(self, value: bool) -> None:
        self.events.append(f"icon.visible={value}")
        if self.fail_visibility:
            raise OSError("synthetic tray failure")
        self._visible = value

    def stop(self) -> None:
        self.events.append("icon.stop")
        self.stopped = True


def build_ui(tmp_path: Path, events: list[str]) -> tuple[WindowsTrayUI, RecordingPlatform]:
    platform = RecordingPlatform()
    ui = WindowsTrayUI(
        service=RecordingService(events),  # type: ignore[arg-type]
        reports=None,  # type: ignore[arg-type]
        settings_store=SettingsStore(tmp_path / "config.json"),
        secrets=MemorySecretStore(),
        platform_api=platform,  # type: ignore[arg-type]
        autostart=None,  # type: ignore[arg-type]
    )
    ui._refresh_icon = lambda: events.append("icon.refresh")  # type: ignore[method-assign]
    return ui, platform


def test_html_report_is_rendered_in_memory() -> None:
    extractor = _HTMLTextExtractor()
    extractor.feed("<h1>日報</h1><p>安全な合成データ</p>")

    assert "日報" in extractor.text()
    assert "安全な合成データ" in extractor.text()


def test_onboarding_notice_discloses_collection_and_rights() -> None:
    notice = onboarding_notice(Settings())

    for required in (
        "60秒ごと",
        "Google Gemini API",
        "最大24時間",
        "業務ログは30日",
        "レポートは90日",
        "本人メール",
        "経営レポートメール",
        "訂正・削除・事故連絡",
        "停止状態は再起動後も維持",
    ):
        assert required in notice


def test_tray_becomes_visible_before_capture_service_starts(tmp_path: Path) -> None:
    events: list[str] = []
    ui, _platform = build_ui(tmp_path, events)
    icon = RecordingIcon(events)

    ui._tray_setup(icon)

    assert events == ["icon.visible=True", "service.start", "icon.refresh"]
    assert icon.visible
    assert ui._tray_startup_error is None


def test_tray_registration_failure_does_not_start_capture(tmp_path: Path) -> None:
    events: list[str] = []
    ui, platform = build_ui(tmp_path, events)
    icon = RecordingIcon(events, fail_visibility=True)

    ui._tray_setup(icon)

    assert "service.start" not in events
    assert events == ["icon.visible=True", "service.stop", "icon.stop"]
    assert icon.stopped
    assert ui._tray_startup_error == "OSError"
    assert platform.notifications


def test_tray_evidence_contains_only_startup_state(
    tmp_path: Path, monkeypatch
) -> None:
    events: list[str] = []
    ui, _platform = build_ui(tmp_path, events)
    icon = RecordingIcon(events)
    monkeypatch.setenv("SCREEN_CAPTURE_REPORT_TRAY_EVIDENCE", "1")

    ui._tray_setup(icon)

    evidence = json.loads((tmp_path / "tray-evidence.json").read_text(encoding="utf-8"))
    assert evidence["visible"] is True
    assert evidence["service_started"] is True
    assert evidence["error_type"] is None
    assert set(evidence) == {"visible", "service_started", "error_type", "timestamp"}


def test_capture_failure_notification_is_not_reported_as_complete(tmp_path: Path) -> None:
    events: list[str] = []
    ui, platform = build_ui(tmp_path, events)

    def fail() -> None:
        raise CaptureNotCompleted("capture_failed", "foreground_unavailable")

    ui._background("手動取得", fail)
    for _ in range(50):
        if platform.notifications:
            break
        time.sleep(0.01)

    assert platform.notifications
    title, message = platform.notifications[-1]
    assert title == "手動取得"
    assert "失敗" in message
    assert "完了" not in message


def test_open_data_menu_opens_the_capture_and_report_root(tmp_path: Path) -> None:
    events: list[str] = []
    ui, platform = build_ui(tmp_path, events)

    ui._open_data()

    assert platform.opened_paths == [tmp_path]
