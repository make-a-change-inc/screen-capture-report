from __future__ import annotations

import io
import logging
import time as time_module
import uuid
from collections.abc import Callable
from datetime import datetime, time
from typing import Protocol

import mss
from PIL import Image

from src.config import Settings
from src.platform_win import WindowInfo
from src.security import EncryptedFileStore
from src.storage import Database

logger = logging.getLogger(__name__)


class PlatformState(Protocol):
    def foreground_window(self) -> WindowInfo | None: ...

    def visible_windows(self) -> list[WindowInfo]: ...

    def is_locked(self) -> bool: ...

    def idle_seconds(self) -> float: ...


class Screenshot(Protocol):
    size: tuple[int, int]
    bgra: bytes


class MSSContext(Protocol):
    monitors: list[dict[str, int]]

    def __enter__(self) -> MSSContext: ...

    def __exit__(self, *_args: object) -> object: ...

    def grab(self, monitor: dict[str, int]) -> Screenshot: ...


class ExclusionMatcher:
    def __init__(self, settings: Settings):
        self.processes = {
            value.casefold(): index for index, value in enumerate(settings.excluded_processes)
        }
        self.title_keywords = [value.casefold() for value in settings.excluded_title_keywords]

    def match(self, window: WindowInfo) -> str | None:
        if self.processes and not window.process_inspectable:
            return "process:inspection_failed"
        process = window.process_name.casefold()
        if process in self.processes:
            return f"process:{self.processes[process]}"
        title = window.title.casefold()
        for index, keyword in enumerate(self.title_keywords):
            if keyword and keyword in title:
                return f"title_keyword:{index}"
        return None


def within_work_hours(now: datetime, start_text: str, end_text: str) -> bool:
    start = time.fromisoformat(start_text)
    end = time.fromisoformat(end_text)
    current = now.time().replace(tzinfo=None)
    if start <= end:
        return start <= current < end
    return current >= start or current < end


class ScreenCapturer:
    def __init__(
        self,
        *,
        database: Database,
        files: EncryptedFileStore,
        settings_provider: Callable[[], Settings],
        platform_state: PlatformState,
        mss_factory: Callable[[], MSSContext] = mss.mss,  # type: ignore[assignment]
        foreground_retry_delay_seconds: float = 0.1,
        foreground_retry_attempts: int = 6,
    ):
        self.database = database
        self.files = files
        self.settings_provider = settings_provider
        self.platform = platform_state
        self.mss_factory = mss_factory
        self.foreground_retry_delay_seconds = foreground_retry_delay_seconds
        self.foreground_retry_attempts = foreground_retry_attempts

    def capture(
        self,
        *,
        now: datetime | None = None,
        manual: bool = False,
        paused: bool = False,
    ) -> str:
        now = now or datetime.now().astimezone()
        settings = self.settings_provider()
        if not settings.has_consent:
            return self.database.record_capture("consent_required", captured_at=now)
        if paused:
            return self.database.record_capture("paused", captured_at=now)
        if not manual and (
            now.weekday() not in settings.work_weekdays
            or not within_work_hours(now, settings.work_start, settings.work_end)
        ):
            return self.database.record_capture("outside_hours", captured_at=now)
        if self.platform.is_locked():
            return self.database.record_capture("locked", captured_at=now)
        if not manual and self.platform.idle_seconds() >= settings.idle_threshold_seconds:
            return self.database.record_capture("idle", captured_at=now)

        window = self._foreground_window(manual=manual)
        if window is None:
            return self.database.record_capture(
                "capture_failed", captured_at=now, error_code="foreground_unavailable"
            )

        matcher = ExclusionMatcher(settings)
        rule_id = matcher.match(window)
        if rule_id:
            return self.database.record_capture("excluded", captured_at=now, rule_id=rule_id)
        if settings.capture_mode == "all_screens":
            try:
                for visible_window in self.platform.visible_windows():
                    rule_id = matcher.match(visible_window)
                    if rule_id:
                        return self.database.record_capture(
                            "excluded",
                            captured_at=now,
                            rule_id=f"all_screens:{rule_id}",
                        )
            except Exception:
                # Enumeration must succeed before any pixel from secondary
                # monitors is read. A failure therefore blocks the capture.
                return self.database.record_capture(
                    "capture_failed",
                    captured_at=now,
                    error_code="all_screens_window_inspection_failed",
                )

        capture_id = str(uuid.uuid4())
        relative_path = f"captures/{now:%Y-%m-%d}/{capture_id}.png.enc"
        try:
            payload = self._capture_png(settings, window)
            self.files.write(relative_path, payload)
            self.database.record_capture(
                "captured",
                capture_id=capture_id,
                captured_at=now,
                process_name=window.process_name,
                window_title=window.title,
                file_path=relative_path,
            )
            return capture_id
        except Exception as exc:
            logger.warning("Capture failed: %s", type(exc).__name__)
            if self.files.exists(relative_path):
                self.files.delete(relative_path)
            return self.database.record_capture(
                "capture_failed",
                capture_id=capture_id,
                captured_at=now,
                error_code=type(exc).__name__,
            )

    def _foreground_window(self, *, manual: bool) -> WindowInfo | None:
        """Allow the previous app to regain focus after a tray-menu command.

        Windows can briefly report no foreground window while the notification
        area menu is closing. Automatic captures do not need this delay, while
        a manual command should wait briefly instead of producing a false
        failure.
        """
        attempts = self.foreground_retry_attempts if manual else 1
        for attempt in range(attempts):
            window = self.platform.foreground_window()
            if window is not None:
                return window
            if attempt + 1 < attempts:
                time_module.sleep(self.foreground_retry_delay_seconds)
        # GetForegroundWindow can return NULL for a background tray process
        # even though an ordinary application window is visible. EnumWindows
        # returns top-level windows in Z order, so the first inspectable-sized
        # entry is the closest safe approximation of the active target.
        try:
            return next(
                (
                    candidate
                    for candidate in self.platform.visible_windows()
                    if candidate.title.strip()
                    and candidate.bounds["width"] >= 64
                    and candidate.bounds["height"] >= 64
                    and candidate.process_name.casefold() != "screencapturereport.exe"
                ),
                None,
            )
        except Exception:
            return None

    def read_capture(self, capture_id: str) -> bytes:
        record = self.database.get_capture(capture_id)
        if not record or not record.file_path:
            raise FileNotFoundError(capture_id)
        return self.files.read(record.file_path)

    def delete_capture_payload(self, capture_id: str, reason: str) -> bool:
        record = self.database.get_capture(capture_id)
        if not record or not record.file_path:
            return False
        deleted = self.files.delete(record.file_path)
        if deleted:
            self.database.clear_capture_file(capture_id)
            self.database.audit_retention("capture", capture_id, reason)
        return deleted

    def _capture_png(self, settings: Settings, window: WindowInfo) -> bytes:
        with self.mss_factory() as sct:
            if settings.capture_mode == "active_window":
                image = self._grab(sct, window.bounds)
            else:
                image = self._grab_all_monitors(sct)
        image.thumbnail((settings.max_image_edge, settings.max_image_edge))
        output = io.BytesIO()
        image.save(output, format="PNG", optimize=True)
        return output.getvalue()

    @staticmethod
    def _grab(sct: MSSContext, monitor: dict[str, int]) -> Image.Image:
        screenshot = sct.grab(monitor)
        return Image.frombytes("RGB", screenshot.size, screenshot.bgra, "raw", "BGRX")

    def _grab_all_monitors(self, sct: MSSContext) -> Image.Image:
        monitors = sct.monitors[1:]
        if not monitors:
            raise RuntimeError("no_monitors")
        min_x = min(item["left"] for item in monitors)
        min_y = min(item["top"] for item in monitors)
        max_x = max(item["left"] + item["width"] for item in monitors)
        max_y = max(item["top"] + item["height"] for item in monitors)
        canvas = Image.new("RGB", (max_x - min_x, max_y - min_y))
        for monitor in monitors:
            image = self._grab(sct, monitor)
            canvas.paste(image, (monitor["left"] - min_x, monitor["top"] - min_y))
        return canvas
