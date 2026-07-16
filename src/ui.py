from __future__ import annotations

import threading
from collections.abc import Callable
from html.parser import HTMLParser
from typing import Any

from PIL import Image, ImageDraw

from src.autostart import AutostartManager
from src.config import SecretBackend, Settings, SettingsStore
from src.constants import PURPOSE_LIMITATION
from src.platform_win import WindowsPlatform
from src.reporting import ReportService
from src.service import RuntimeService
from src.utils import get_resource_path


class _HTMLTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, _attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"h1", "h2", "h3", "p", "li", "tr", "br"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        value = data.strip()
        if value:
            self.parts.append(value + " ")

    def text(self) -> str:
        return "".join(self.parts).strip()


def onboarding_notice(settings: Settings) -> str:
    return (
        PURPOSE_LIMITATION
        + f"\n\n取得頻度: 業務時間中は{settings.capture_interval_seconds}秒ごと。"
            "対象: 既定は前景ウィンドウ（全画面は設定で明示選択）。"
        "画像は分類のためGoogle Gemini APIへ送信されます。"
        "画像は解析成功直後に削除し、障害時も最大24時間、業務ログは"
        f"{settings.log_retention_days}日、レポートは{settings.report_retention_days}日保持します。"
        "本人日報は本人メール、週次集計は経営レポートメールへ送ります。"
        "訂正・削除・事故連絡は下記のプライバシー窓口へ行えます。"
        "取得中はトレイで確認でき、停止状態は再起動後も維持されます。"
    )


class WindowsTrayUI:
    def __init__(
        self,
        *,
        service: RuntimeService,
        reports: ReportService,
        settings_store: SettingsStore,
        secrets: SecretBackend,
        platform_api: WindowsPlatform,
        autostart: AutostartManager,
    ):
        self.service = service
        self.reports = reports
        self.settings_store = settings_store
        self.secrets = secrets
        self.platform = platform_api
        self.autostart = autostart
        self.icon: Any | None = None

    def run_onboarding(self) -> bool:
        import tkinter as tk
        from tkinter import messagebox

        settings = self.settings_store.load()
        root = tk.Tk()
        root.title("Screen Capture Report - 初期設定")
        root.geometry("680x760")
        root.resizable(False, False)

        tk.Label(root, text="Screen Capture Report", font=("Segoe UI", 20, "bold")).pack(
            pady=(20, 8)
        )
        tk.Message(
            root,
            text=onboarding_notice(settings),
            width=620,
            font=("Segoe UI", 10),
        ).pack(pady=8)

        form = tk.Frame(root)
        form.pack(fill="x", padx=36, pady=12)
        values: dict[str, tk.StringVar] = {}

        def add_row(label: str, key: str, value: str = "", secret: bool = False) -> None:
            row = tk.Frame(form)
            row.pack(fill="x", pady=5)
            tk.Label(row, text=label, width=24, anchor="w").pack(side="left")
            variable = tk.StringVar(value=value)
            values[key] = variable
            tk.Entry(row, textvariable=variable, show="*" if secret else "").pack(
                side="left", fill="x", expand=True
            )

        add_row("Gemini APIキー（必須）", "gemini_api_key", "", True)
        add_row("従業員識別子（必須）", "employee_id", self.secrets.get("employee_id") or "")
        add_row("部署（必須）", "department", self.secrets.get("department") or "")
        add_row(
            "訂正・削除・事故連絡先（必須）",
            "privacy_contact",
            self.secrets.get("privacy_contact") or "",
        )
        add_row(
            "本人メール（任意）",
            "employee_email",
            self.secrets.get("employee_email") or "",
        )
        add_row(
            "経営レポートメール（任意）",
            "management_email",
            self.secrets.get("management_email") or "",
        )
        add_row(
            "SMTPユーザー（任意）",
            "smtp_user",
            self.secrets.get("smtp_user") or "",
        )
        add_row("SMTPアプリパスワード", "smtp_password", "", True)
        add_row("勤務開始 HH:MM", "work_start", settings.work_start)
        add_row("勤務終了 HH:MM", "work_end", settings.work_end)
        add_row(
            "稼働曜日 0=月〜6=日",
            "work_weekdays",
            ",".join(map(str, settings.work_weekdays)),
        )

        consent = tk.BooleanVar(value=False)
        tk.Checkbutton(
            root,
            variable=consent,
            text="目的・取得内容・保持期間を理解し、業務時間中の取得に同意します",
            wraplength=540,
        ).pack(pady=14)

        accepted = {"value": False}

        def save() -> None:
            api_key = values["gemini_api_key"].get().strip()
            if not api_key:
                messagebox.showerror("入力エラー", "Gemini APIキーが必要です。")
                return
            required_identity = {
                key: values[key].get().strip()
                for key in ("employee_id", "department", "privacy_contact")
            }
            if not all(required_identity.values()):
                messagebox.showerror("入力エラー", "対象者、部署、連絡先はすべて必須です。")
                return
            if not consent.get():
                messagebox.showerror("同意が必要です", "同意前に画面取得は開始できません。")
                return
            settings.work_start = values["work_start"].get().strip()
            settings.work_end = values["work_end"].get().strip()
            settings.work_weekdays = [
                int(value.strip())
                for value in values["work_weekdays"].get().split(",")
                if value.strip()
            ]
            settings.grant_consent()
            try:
                self.secrets.set("gemini_api_key", api_key)
                for key, value in required_identity.items():
                    self.secrets.set(key, value)
                for key in ("employee_email", "management_email", "smtp_user"):
                    value = values[key].get().strip()
                    if value:
                        self.secrets.set(key, value)
                    else:
                        self.secrets.delete(key)
                smtp_user = values["smtp_user"].get().strip()
                if smtp_user:
                    self.secrets.set("email_from", smtp_user)
                else:
                    self.secrets.delete("email_from")
                smtp_password = values["smtp_password"].get().strip()
                if smtp_password:
                    self.secrets.set("smtp_password", smtp_password)
                # Consent is the commit marker and is persisted only after all
                # required Credential Manager/DPAPI writes succeed.
                self.settings_store.save(settings)
            except Exception as exc:
                messagebox.showerror("保存エラー", f"設定を保存できません: {type(exc).__name__}")
                return
            accepted["value"] = True
            root.destroy()

        buttons = tk.Frame(root)
        buttons.pack(pady=8)
        tk.Button(buttons, text="同意して開始", width=18, command=save).pack(side="left", padx=8)
        tk.Button(buttons, text="終了", width=12, command=root.destroy).pack(side="left", padx=8)
        root.protocol("WM_DELETE_WINDOW", root.destroy)
        root.mainloop()
        return bool(accepted["value"])

    def run(self) -> None:
        import pystray

        menu = pystray.Menu(
            pystray.MenuItem("取得を開始", self._resume),
            pystray.MenuItem("一時停止", self._pause),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("今すぐ取得", self._capture_now),
            pystray.MenuItem("今すぐ解析", self._analyze_now),
            pystray.MenuItem("日報を生成", self._daily_now),
            pystray.MenuItem("週次レポートを生成", self._weekly_now),
            pystray.MenuItem("最新の日報を開く", self._open_latest_daily),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("今日の画像を削除", self._delete_today),
            pystray.MenuItem("データフォルダを開く", self._open_data),
            pystray.MenuItem("設定", self._settings),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("終了", self._quit),
        )
        icon = pystray.Icon(
            "ScreenCaptureReport",
            self._status_icon(running=not self.service.paused),
            "Screen Capture Report - 取得中",
            menu,
        )
        self.icon = icon

        def setup(_icon: Any) -> None:
            self.service.start()
            self._refresh_icon()

        # pystray invokes setup only after the visible tray icon is ready, so
        # the first automatic capture never precedes the collection indicator.
        icon.run(setup=setup)

    def _resume(self, *_args) -> None:
        try:
            self.service.resume()
            self._refresh_icon()
            self.platform.notify("Screen Capture Report", "画面取得を開始しました")
        except Exception as exc:
            self.platform.notify("開始できません", type(exc).__name__)

    def _pause(self, *_args) -> None:
        self.service.pause()
        self._refresh_icon()
        self.platform.notify("Screen Capture Report", "画面取得を一時停止しました")

    def _capture_now(self, *_args) -> None:
        self._background("手動取得", lambda: self.service.capture_now())

    def _analyze_now(self, *_args) -> None:
        self._background("解析", lambda: self.service.analyze_now())

    def _daily_now(self, *_args) -> None:
        self._background("日報生成", lambda: self.service.daily_report_now())

    def _weekly_now(self, *_args) -> None:
        self._background("週次レポート生成", lambda: self.service.weekly_report_now())

    def _delete_today(self, *_args) -> None:
        self._background("画像削除", lambda: self.service.delete_today_captures())

    def _open_data(self, *_args) -> None:
        self.platform.open_path(self.settings_store.path.parent)

    def _open_latest_daily(self, *_args) -> None:
        reports = [
            item
            for item in self.reports.list_employee_reports()
            if item and item["kind"] == "daily" and item["audience"] == "employee"
        ]
        if not reports:
            self.platform.notify("日報", "生成済みの日報がありません")
            return
        latest = reports[-1]
        payload = latest["payload"] or ""
        threading.Thread(target=self._show_report_window, args=(payload,), daemon=True).start()

    @staticmethod
    def _show_report_window(payload: str) -> None:
        import tkinter as tk

        extractor = _HTMLTextExtractor()
        extractor.feed(payload)
        root = tk.Tk()
        root.title("Screen Capture Report - 日報")
        root.geometry("760x640")
        text = tk.Text(root, wrap="word", font=("Segoe UI", 10))
        text.insert("1.0", extractor.text())
        text.configure(state="disabled")
        scrollbar = tk.Scrollbar(root, command=text.yview)
        text.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side="right", fill="y")
        text.pack(fill="both", expand=True, padx=12, pady=12)
        root.mainloop()

    def _settings(self, *_args) -> None:
        threading.Thread(target=self._settings_dialog, daemon=True).start()

    def _settings_dialog(self) -> None:
        import tkinter as tk
        from tkinter import messagebox

        settings = self.settings_store.load()
        root = tk.Tk()
        root.title("Screen Capture Report - 設定")
        root.geometry("680x740")
        form = tk.Frame(root)
        form.pack(fill="both", expand=True, padx=30, pady=20)
        values: dict[str, tk.StringVar] = {}

        fields = [
            ("従業員識別子", "employee_id", self.secrets.get("employee_id") or ""),
            ("部署", "department", self.secrets.get("department") or ""),
            (
                "訂正・削除・事故連絡先",
                "privacy_contact",
                self.secrets.get("privacy_contact") or "",
            ),
            ("本人メール", "employee_email", self.secrets.get("employee_email") or ""),
            (
                "経営レポートメール",
                "management_email",
                self.secrets.get("management_email") or "",
            ),
            ("SMTPユーザー", "smtp_user", self.secrets.get("smtp_user") or ""),
            ("勤務開始 HH:MM", "work_start", settings.work_start),
            ("勤務終了 HH:MM", "work_end", settings.work_end),
            (
                "稼働曜日 0=月〜6=日",
                "work_weekdays",
                ",".join(map(str, settings.work_weekdays)),
            ),
            ("離席判定（秒）", "idle", str(settings.idle_threshold_seconds)),
            ("ログ保持（日）", "log_days", str(settings.log_retention_days)),
            ("レポート保持（日）", "report_days", str(settings.report_retention_days)),
        ]
        for label, key, current in fields:
            row = tk.Frame(form)
            row.pack(fill="x", pady=5)
            tk.Label(row, text=label, width=22, anchor="w").pack(side="left")
            variable = tk.StringVar(value=current)
            values[key] = variable
            tk.Entry(row, textvariable=variable).pack(side="left", fill="x", expand=True)

        api_key = tk.StringVar()
        smtp_password = tk.StringVar()
        for label, variable in (
            ("新しいGemini APIキー", api_key),
            ("新しいSMTPパスワード", smtp_password),
        ):
            row = tk.Frame(form)
            row.pack(fill="x", pady=5)
            tk.Label(row, text=label, width=22, anchor="w").pack(side="left")
            tk.Entry(row, textvariable=variable, show="*").pack(side="left", fill="x", expand=True)

        mode = tk.StringVar(value=settings.capture_mode)
        row = tk.Frame(form)
        row.pack(fill="x", pady=5)
        tk.Label(row, text="取得モード", width=22, anchor="w").pack(side="left")
        tk.OptionMenu(row, mode, "active_window", "all_screens").pack(side="left")

        autostart = tk.BooleanVar(value=self.autostart.is_enabled())
        tk.Checkbutton(form, text="Windowsログイン時に起動", variable=autostart).pack(
            anchor="w", pady=8
        )

        process_text = tk.Text(form, height=4)
        process_text.insert("1.0", "\n".join(settings.excluded_processes))
        tk.Label(form, text="除外プロセス（1行1件）", anchor="w").pack(fill="x")
        process_text.pack(fill="x")
        title_text = tk.Text(form, height=4)
        title_text.insert("1.0", "\n".join(settings.excluded_title_keywords))
        tk.Label(form, text="除外タイトル語（1行1件）", anchor="w").pack(fill="x")
        title_text.pack(fill="x")

        def save() -> None:
            try:
                if not all(
                    values[key].get().strip()
                    for key in ("employee_id", "department", "privacy_contact")
                ):
                    raise ValueError("対象者、部署、連絡先は必須です")
                settings.work_start = values["work_start"].get().strip()
                settings.work_end = values["work_end"].get().strip()
                settings.work_weekdays = [
                    int(value.strip())
                    for value in values["work_weekdays"].get().split(",")
                    if value.strip()
                ]
                settings.idle_threshold_seconds = int(values["idle"].get())
                settings.log_retention_days = int(values["log_days"].get())
                settings.report_retention_days = int(values["report_days"].get())
                settings.capture_mode = mode.get()
                settings.excluded_processes = [
                    item.strip()
                    for item in process_text.get("1.0", "end").splitlines()
                    if item.strip()
                ]
                settings.excluded_title_keywords = [
                    item.strip()
                    for item in title_text.get("1.0", "end").splitlines()
                    if item.strip()
                ]
                self.settings_store.save(settings)
                self.autostart.set_enabled(autostart.get())
                for key in (
                    "employee_id",
                    "department",
                    "privacy_contact",
                    "employee_email",
                    "management_email",
                    "smtp_user",
                ):
                    value = values[key].get().strip()
                    if value:
                        self.secrets.set(key, value)
                    else:
                        self.secrets.delete(key)
                smtp_user = values["smtp_user"].get().strip()
                if smtp_user:
                    self.secrets.set("email_from", smtp_user)
                else:
                    self.secrets.delete("email_from")
                if api_key.get().strip():
                    self.secrets.set("gemini_api_key", api_key.get().strip())
                if smtp_password.get().strip():
                    self.secrets.set("smtp_password", smtp_password.get().strip())
            except Exception as exc:
                messagebox.showerror("保存エラー", type(exc).__name__)
                return
            root.destroy()
            self.platform.notify("設定", "設定を保存しました")

        buttons = tk.Frame(form)
        buttons.pack(pady=14)
        tk.Button(buttons, text="保存", command=save).pack(side="left", padx=6)

        def delete_credentials() -> None:
            if not messagebox.askyesno(
                "資格情報の削除",
                "API・メール・対象者・連絡先の情報をWindows資格情報から削除しますか？",
            ):
                return
            self.service.pause()
            settings = self.settings_store.load()
            settings.revoke_consent()
            try:
                self.settings_store.save(settings)
            except Exception as exc:
                messagebox.showerror("資格情報", f"同意を取り消せません: {type(exc).__name__}")
                return
            for key in (
                "gemini_api_key",
                "smtp_password",
                "smtp_user",
                "email_from",
                "employee_email",
                "management_email",
                "employee_id",
                "department",
                "privacy_contact",
            ):
                self.secrets.delete(key)
            messagebox.showinfo(
                "資格情報",
                "資格情報を削除し取得を停止しました。次回起動時に再設定が必要です。",
            )

        tk.Button(buttons, text="資格情報を削除", command=delete_credentials).pack(
            side="left", padx=6
        )
        root.mainloop()

    def _quit(self, *_args) -> None:
        self.service.stop()
        if self.icon:
            self.icon.stop()

    def _background(self, label: str, operation: Callable[[], object]) -> None:
        def run() -> None:
            try:
                result = operation()
                self.platform.notify(label, f"完了しました: {result}")
            except Exception as exc:
                self.platform.notify(label, f"失敗しました: {type(exc).__name__}")

        threading.Thread(target=run, daemon=True).start()

    def _refresh_icon(self) -> None:
        if not self.icon:
            return
        running = not self.service.paused
        self.icon.icon = self._status_icon(running)
        self.icon.title = (
            "Screen Capture Report - 取得中" if running else "Screen Capture Report - 一時停止"
        )

    @staticmethod
    def _status_icon(running: bool) -> Image.Image:
        icon_path = get_resource_path("app_icon.png")
        if icon_path.exists():
            image = Image.open(icon_path).convert("RGBA").resize((64, 64))
        else:
            image = Image.new("RGBA", (64, 64), (35, 45, 60, 255))
        draw = ImageDraw.Draw(image)
        color = (34, 197, 94, 255) if running else (107, 114, 128, 255)
        draw.ellipse((42, 42, 62, 62), fill=color, outline=(255, 255, 255, 255), width=2)
        return image
