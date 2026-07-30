# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path

root = Path(SPECPATH)

a = Analysis(
    [str(root / "src" / "main.py")],
    pathex=[str(root)],
    binaries=[],
    datas=[(str(root / "app_icon.png"), ".")],
    hiddenimports=[
        "keyring.backends.Windows",
        "pystray._win32",
        "win32timezone",
        "google.genai",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["Quartz", "Cocoa", "rumps"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="ScreenCaptureReport",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    # PyInstaller converts Pillow-supported PNG input to an ICO on Windows.
    icon=str(root / "app_icon.png"),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="ScreenCaptureReport",
)
