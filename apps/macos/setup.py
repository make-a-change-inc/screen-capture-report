from setuptools import setup

APP = ['src/main.py']
DATA_FILES = ['.env', 'app_icon.icns']
OPTIONS = {
    'argv_emulation': True,
    'iconfile': 'app_icon.icns',
    'plist': {
        'LSUIElement': True,
        'CFBundleName': 'ScreenCaptureReport',
        'CFBundleDisplayName': 'ScreenCaptureReport',
        'CFBundleGetInfoString': "Screen Capture & Report App",
        'CFBundleIdentifier': "com.makeachange.screencapturereport",
        'CFBundleVersion': "0.1.0",
        'CFBundleShortVersionString': "0.1.0",
        'NSHumanReadableCopyright': "Copyright © 2025 Make A Change",
        'NSDesktopFolderUsageDescription': "Needed to save capture logs.",
        'NSDocumentsFolderUsageDescription': "Needed to save capture logs.",
    },
    'packages': ['rumps', 'mss', 'PIL', 'Quartz', 'Cocoa', 'requests', 'schedule', 'dotenv'],
    'includes': ['email', 'smtplib', 'ssl', 'subprocess', 'threading', 'datetime', 'logging', 'json', 'google', 'google.generativeai', 'google.ai'],
}

setup(
    app=APP,
    data_files=DATA_FILES,
    options={'py2app': OPTIONS},
    setup_requires=['py2app'],
)
