from __future__ import annotations

APP_NAME = "ScreenCaptureReport"
APP_SERVICE_NAME = "ScreenCaptureReport"
CONSENT_VERSION = "windows-poc-v2"
SERVER_SYNC_CONSENT_VERSION = "server-sync-v1"
PURPOSE_LIMITATION = (
    "このアプリは業務改善のために利用します。人事評価、査定、懲戒、"
    "従業員ランキング、常時監視には利用しません。"
)

DEFAULT_CATEGORIES = [
    {"id": "email", "label": "メール"},
    {"id": "documents", "label": "資料作成"},
    {"id": "data_entry", "label": "データ入力・転記"},
    {"id": "meeting_minutes", "label": "会議・議事録"},
    {"id": "research", "label": "調査"},
    {"id": "other", "label": "その他"},
]

DEFAULT_EXCLUDED_PROCESSES = [
    "1password.exe",
    "bitwarden.exe",
    "keepass.exe",
    "keepassxc.exe",
    "lastpass.exe",
]

DEFAULT_EXCLUDED_TITLE_KEYWORDS = [
    "パスワード",
    "password",
    "給与",
    "payroll",
    "人事",
    "human resources",
    "医療",
    "medical",
]
