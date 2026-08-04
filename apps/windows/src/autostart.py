from __future__ import annotations

import platform
from importlib import import_module
from typing import Any

from src.utils import executable_command


class AutostartManager:
    VALUE_NAME = "ScreenCaptureReport"

    def set_enabled(self, enabled: bool) -> None:
        if platform.system() != "Windows":
            raise RuntimeError("Autostart is only available on Windows")
        winreg: Any = import_module("winreg")

        path = r"Software\Microsoft\Windows\CurrentVersion\Run"
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            path,
            0,
            winreg.KEY_SET_VALUE,
        ) as key:
            if enabled:
                winreg.SetValueEx(key, self.VALUE_NAME, 0, winreg.REG_SZ, executable_command())
            else:
                try:
                    winreg.DeleteValue(key, self.VALUE_NAME)
                except FileNotFoundError:
                    pass

    def is_enabled(self) -> bool:
        if platform.system() != "Windows":
            return False
        winreg: Any = import_module("winreg")

        path = r"Software\Microsoft\Windows\CurrentVersion\Run"
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as key:
                winreg.QueryValueEx(key, self.VALUE_NAME)
            return True
        except FileNotFoundError:
            return False
