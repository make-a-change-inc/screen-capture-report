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
    {"id": "chat_meeting", "label": "チャット・会議"},
    {"id": "documents", "label": "資料作成"},
    {"id": "development", "label": "開発・技術作業"},
    {"id": "research", "label": "調査・閲覧"},
    {"id": "administration", "label": "データ入力・事務"},
    {"id": "customer_support", "label": "顧客対応"},
    {"id": "management", "label": "管理・計画"},
    {"id": "break_idle", "label": "休憩・離席"},
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
