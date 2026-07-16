from __future__ import annotations

import ctypes
import os
import platform
from ctypes import wintypes
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast


@dataclass(frozen=True, slots=True)
class WindowInfo:
    process_name: str
    title: str
    bounds: dict[str, int]
    process_inspectable: bool = True


def elapsed_tick_seconds(current_tick: int, last_input_tick: int) -> float:
    """Return elapsed seconds for Windows' wrapping 32-bit tick counters."""
    elapsed_ms = (current_tick - last_input_tick) & 0xFFFFFFFF
    return elapsed_ms / 1000.0


class WindowsSingleInstance:
    """Keeps one per-user process alive so capture schedules cannot duplicate."""

    ERROR_ALREADY_EXISTS = 183

    def __init__(self, name: str = "Local\\ScreenCaptureReport") -> None:
        if platform.system() != "Windows":
            raise RuntimeError("Single-instance guard is only available on Windows")
        kernel32 = cast(Any, ctypes).windll.kernel32
        create_mutex = kernel32.CreateMutexW
        create_mutex.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
        create_mutex.restype = wintypes.HANDLE
        self._close_handle = kernel32.CloseHandle
        self._close_handle.argtypes = [wintypes.HANDLE]
        self._close_handle.restype = wintypes.BOOL
        self._handle = create_mutex(None, False, name)
        if not self._handle:
            raise OSError("CreateMutexW failed")
        self.acquired = int(kernel32.GetLastError()) != self.ERROR_ALREADY_EXISTS
        if not self.acquired:
            self.close()

    def close(self) -> None:
        if self._handle:
            self._close_handle(self._handle)
            self._handle = None


class WindowsPlatform:
    def __init__(self) -> None:
        if platform.system() != "Windows":
            raise RuntimeError("ScreenCaptureReport runtime requires Windows")
        try:
            import psutil
            import win32gui
            import win32process
        except ImportError as exc:  # pragma: no cover - Windows packaging path
            raise RuntimeError("pywin32 and psutil are required on Windows") from exc
        self._psutil = psutil
        self._win32gui = win32gui
        self._win32process = win32process

    def foreground_window(self) -> WindowInfo | None:
        hwnd = self._win32gui.GetForegroundWindow()
        if not hwnd:
            return None
        return self._window_info(hwnd)

    def visible_windows(self) -> list[WindowInfo]:
        windows: list[WindowInfo] = []

        def collect(hwnd: int, _context: object) -> None:
            if not self._win32gui.IsWindowVisible(hwnd):
                return
            info = self._window_info(hwnd)
            if info is not None:
                windows.append(info)

        self._win32gui.EnumWindows(collect, None)
        return windows

    def _window_info(self, hwnd: int) -> WindowInfo | None:
        title = self._win32gui.GetWindowText(hwnd) or ""
        _, process_id = self._win32process.GetWindowThreadProcessId(hwnd)
        process_inspectable = True
        try:
            process_name = self._psutil.Process(process_id).name()
        except (self._psutil.NoSuchProcess, self._psutil.AccessDenied):
            process_name = "unknown"
            process_inspectable = False
        left, top, right, bottom = self._win32gui.GetWindowRect(hwnd)
        width = max(0, right - left)
        height = max(0, bottom - top)
        if width < 2 or height < 2:
            return None
        return WindowInfo(
            process_name=process_name,
            title=title,
            bounds={"left": left, "top": top, "width": width, "height": height},
            process_inspectable=process_inspectable,
        )

    def is_locked(self) -> bool:
        user32 = cast(Any, ctypes).windll.user32
        open_input_desktop = user32.OpenInputDesktop
        open_input_desktop.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        open_input_desktop.restype = wintypes.HANDLE
        close_desktop = user32.CloseDesktop
        close_desktop.argtypes = [wintypes.HANDLE]
        close_desktop.restype = wintypes.BOOL
        desktop = open_input_desktop(0, False, 0x0100)
        if not desktop:
            return True
        close_desktop(desktop)
        return False

    def idle_seconds(self) -> float:
        class LASTINPUTINFO(ctypes.Structure):
            _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]

        info = LASTINPUTINFO()
        info.cbSize = ctypes.sizeof(info)
        windll = cast(Any, ctypes).windll
        get_last_input = windll.user32.GetLastInputInfo
        get_last_input.argtypes = [ctypes.POINTER(LASTINPUTINFO)]
        get_last_input.restype = wintypes.BOOL
        if not get_last_input(ctypes.byref(info)):
            return 0.0
        # LASTINPUTINFO.dwTime is a 32-bit GetTickCount value. Pairing it with
        # GetTickCount64 breaks after the first 49.7-day wrap and can make a
        # workstation appear permanently idle.
        get_tick_count = windll.kernel32.GetTickCount
        get_tick_count.restype = wintypes.DWORD
        return elapsed_tick_seconds(int(get_tick_count()), int(info.dwTime))

    def open_path(self, path: Path) -> None:
        os.startfile(str(path))  # type: ignore[attr-defined]

    def notify(self, title: str, message: str) -> None:
        try:
            from winotify import Notification

            Notification(app_id="Screen Capture Report", title=title, msg=message).show()
        except Exception:
            # Notification failure must not stop capture or report recovery.
            return
