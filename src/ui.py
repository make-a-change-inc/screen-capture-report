from __future__ import annotations

import json
import logging
import os
import threading
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from html.parser import HTMLParser
from io import BytesIO
from typing import Any

from PIL import Image, ImageDraw, ImageTk

from src.autostart import AutostartManager
from src.config import SecretBackend, Settings, SettingsStore
from src.constants import PURPOSE_LIMITATION
from src.enrollment import EnrollmentClient
from src.platform_win import WindowsPlatform
from src.reporting import ReportService
from src.service import RuntimeService
from src.utils import get_resource_path
from src.viewer import EmployeeArchive, EmployeeArchiveDay

logger = logging.getLogger(__name__)

WEEKDAY_LABELS = ("月", "火", "水", "木", "金", "土", "日")


def selected_weekdays(selected: Sequence[bool]) -> list[int]:
    return [day for day, is_selected in enumerate(selected) if is_selected]


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
        "本人日報はアプリ内で確認できます。確定済みの週次集計のみ管理Webへ送信され、"
        "画面画像・本人日報・ウィンドウタイトルは送信されません。"
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
        employee_archive: EmployeeArchive | None = None,
    ):
        self.service = service
        self.reports = reports
        self.settings_store = settings_store
        self.secrets = secrets
        self.platform = platform_api
        self.autostart = autostart
        self.employee_archive = employee_archive
        self.icon: Any | None = None
        self._tray_startup_error: str | None = None

    def run_onboarding(self) -> bool:
        import tkinter as tk
        from tkinter import messagebox

        settings = self.settings_store.load()
        root = tk.Tk()
        root.title("Screen Capture Report - 初期設定")
        root.geometry("680x760")
        root.minsize(560, 480)
        root.resizable(True, True)

        body = tk.Frame(root)
        body.pack(fill="both", expand=True, padx=8, pady=8)
        canvas = tk.Canvas(body, highlightthickness=0)
        scrollbar = tk.Scrollbar(body, orient="vertical", command=canvas.yview)
        scrollable = tk.Frame(canvas)
        scrollable_window = canvas.create_window((0, 0), window=scrollable, anchor="nw")
        canvas.configure(yscrollcommand=scrollbar.set)
        canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

        def update_scroll_region(_event=None) -> None:
            canvas.configure(scrollregion=canvas.bbox("all"))

        def resize_scrollable(event) -> None:
            canvas.itemconfigure(scrollable_window, width=event.width)

        scrollable.bind("<Configure>", update_scroll_region)
        canvas.bind("<Configure>", resize_scrollable)
        canvas.bind_all(
            "<MouseWheel>",
            lambda event: canvas.yview_scroll(int(-event.delta / 120), "units"),
        )

        tk.Label(scrollable, text="Screen Capture Report", font=("Segoe UI", 20, "bold")).pack(
            pady=(20, 8)
        )
        tk.Message(
            scrollable,
            text=onboarding_notice(settings),
            width=620,
            font=("Segoe UI", 10),
        ).pack(padx=28, pady=8)

        form = tk.Frame(scrollable)
        form.pack(fill="x", padx=28, pady=12)
        values: dict[str, tk.StringVar] = {}

        def add_row(label: str, key: str, value: str = "", secret: bool = False) -> None:
            row = tk.Frame(form)
            row.pack(fill="x", pady=5)
            tk.Label(row, text=label, width=32, anchor="w").pack(side="left")
            variable = tk.StringVar(value=value)
            values[key] = variable
            tk.Entry(row, textvariable=variable, show="*" if secret else "").pack(
                side="left", fill="x", expand=True
            )

        add_row("Gemini APIキー（必須）", "gemini_api_key", "", True)
        add_row("氏名（必須）", "display_name", self.secrets.get("display_name") or "")
        add_row("社員ID（必須）", "employee_id", self.secrets.get("employee_id") or "")
        add_row("所属部署（必須）", "department", self.secrets.get("department") or "")
        add_row("招待コード（必須）", "invite_code", "", True)

        consent = tk.BooleanVar(value=False)
        tk.Checkbutton(
            scrollable,
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
                for key in ("display_name", "employee_id", "department")
            }
            if not all(required_identity.values()):
                messagebox.showerror("入力エラー", "氏名、社員ID、所属部署は必須です。")
                return
            invite_code = values["invite_code"].get().strip()
            if not invite_code:
                messagebox.showerror("入力エラー", "招待コードが必要です。")
                return
            if not consent.get():
                messagebox.showerror("同意が必要です", "同意前に画面取得は開始できません。")
                return
            settings.grant_consent()
            try:
                enrollment = EnrollmentClient().enroll(
                    invite_code=invite_code,
                    display_name=required_identity["display_name"],
                    employee_id=required_identity["employee_id"],
                    department=required_identity["department"],
                )
                settings.admin_api_url = enrollment.api_url
                settings.grant_server_sync_consent()
                settings.server_sync_enabled = True
                self.secrets.set("gemini_api_key", api_key)
                for key, value in required_identity.items():
                    self.secrets.set(key, value)
                self.secrets.set("admin_upload_token", enrollment.device_token)
                # Consent is the commit marker and is persisted only after all
                # required Credential Manager/DPAPI writes succeed.
                self.settings_store.save(settings)
            except Exception as exc:
                messagebox.showerror("保存エラー", f"設定を保存できません: {type(exc).__name__}")
                return
            accepted["value"] = True
            root.destroy()

        buttons = tk.Frame(scrollable)
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
            pystray.MenuItem("管理サーバーへ同期", self._sync_now),
            pystray.MenuItem("レポートと画像を見る", self._open_employee_archive),
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
            "Screen Capture Report - 起動中",
            menu,
        )
        self.icon = icon

        # A custom pystray setup replaces its default setup, so it must set
        # visible explicitly. The runtime service starts only after that call.
        icon.run(setup=self._tray_setup)
        if self._tray_startup_error:
            raise RuntimeError(f"tray_startup_failed:{self._tray_startup_error}")

    def _tray_setup(self, icon: Any) -> None:
        try:
            icon.visible = True
            if not icon.visible:
                raise RuntimeError("tray_visibility_not_confirmed")
            self.service.start()
            self._refresh_icon()
        except Exception as exc:
            self._tray_startup_error = type(exc).__name__
            logger.critical(
                "Tray startup failed exception_type=%s",
                self._tray_startup_error,
            )
            self._write_tray_evidence(
                visible=bool(getattr(icon, "visible", False)),
                service_started=False,
                error_type=self._tray_startup_error,
            )
            self.platform.notify(
                "Screen Capture Report",
                "トレイアイコンを表示できないため、画面取得を開始しませんでした。",
            )
            try:
                self.service.stop()
            except Exception as stop_exc:
                logger.error(
                    "Service cleanup after tray failure failed exception_type=%s",
                    type(stop_exc).__name__,
                )
            icon.stop()
            return

        self._write_tray_evidence(
            visible=True,
            service_started=True,
            error_type=None,
        )

    def _write_tray_evidence(
        self,
        *,
        visible: bool,
        service_started: bool,
        error_type: str | None,
    ) -> None:
        if os.environ.get("SCREEN_CAPTURE_REPORT_TRAY_EVIDENCE") != "1":
            return
        try:
            destination = self.settings_store.path.parent / "tray-evidence.json"
            temporary = destination.with_suffix(".tmp")
            temporary.write_text(
                json.dumps(
                    {
                        "visible": visible,
                        "service_started": service_started,
                        "error_type": error_type,
                        "timestamp": datetime.now(UTC).isoformat(),
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            os.replace(temporary, destination)
        except Exception as exc:
            logger.error(
                "Tray evidence write failed exception_type=%s",
                type(exc).__name__,
            )

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

    def _sync_now(self, *_args) -> None:
        self._background("管理サーバー同期", lambda: self.service.sync_reports_now())

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

    def _open_employee_archive(self, *_args) -> None:
        if self.employee_archive is None:
            self.platform.notify("本人アーカイブ", "アーカイブを利用できません")
            return
        threading.Thread(target=self._show_employee_archive_window, daemon=True).start()

    def _show_employee_archive_window(self) -> None:
        import tkinter as tk
        from tkinter import messagebox, ttk

        if self.employee_archive is None:
            return
        archive = self.employee_archive
        try:
            days = archive.list_days()
        except Exception as exc:
            self.platform.notify("本人アーカイブ", f"読込に失敗しました: {type(exc).__name__}")
            return

        root = tk.Tk()
        root.title("Screen Capture Report - 本人アーカイブ")
        root.geometry("1120x760")
        root.minsize(860, 600)

        header = tk.Frame(root)
        header.pack(fill="x", padx=14, pady=(12, 6))
        tk.Label(header, text="本人アーカイブ", font=("Segoe UI", 17, "bold")).pack(
            side="left"
        )
        tk.Label(
            header,
            text="復号内容はこの画面のメモリ内だけで表示します",
            fg="#4b5563",
        ).pack(side="right")

        body = tk.PanedWindow(root, orient="horizontal", sashwidth=5)
        body.pack(fill="both", expand=True, padx=14, pady=(0, 14))
        date_frame = tk.Frame(body)
        content_frame = tk.Frame(body)
        body.add(date_frame, minsize=190)
        body.add(content_frame, minsize=620)

        tk.Label(date_frame, text="日付", anchor="w", font=("Segoe UI", 10, "bold")).pack(
            fill="x", pady=(0, 4)
        )
        day_list = tk.Listbox(date_frame, exportselection=False)
        day_list.pack(fill="both", expand=True)

        notebook = ttk.Notebook(content_frame)
        notebook.pack(fill="both", expand=True)
        report_tab = tk.Frame(notebook)
        capture_tab = tk.Frame(notebook)
        notebook.add(report_tab, text="日報")
        notebook.add(capture_tab, text="キャプチャ")
        management_tab = tk.Frame(notebook)
        notebook.add(management_tab, text="管理者に共有される内容")

        report_text = tk.Text(report_tab, wrap="word", font=("Segoe UI", 10))
        report_scroll = tk.Scrollbar(report_tab, command=report_text.yview)
        report_text.configure(yscrollcommand=report_scroll.set)
        report_scroll.pack(side="right", fill="y")
        report_text.pack(fill="both", expand=True, padx=8, pady=8)

        capture_split = tk.PanedWindow(capture_tab, orient="horizontal", sashwidth=5)
        capture_split.pack(fill="both", expand=True, padx=8, pady=8)
        capture_list = tk.Listbox(capture_split, exportselection=False)
        preview = tk.Label(
            capture_split,
            text="画像を選択してください",
            bg="#111827",
            fg="white",
            anchor="center",
        )
        capture_split.add(capture_list, minsize=220)
        capture_split.add(preview, minsize=480)

        management_split = tk.PanedWindow(management_tab, orient="horizontal", sashwidth=5)
        management_split.pack(fill="both", expand=True, padx=8, pady=8)
        management_list = tk.Listbox(management_split, exportselection=False)
        management_text = tk.Text(management_split, wrap="word", font=("Segoe UI", 10))
        management_split.add(management_list, minsize=260)
        management_split.add(management_text, minsize=500)
        management_previews = archive.list_management_share_previews()

        state: dict[str, Any] = {"day": None, "captures": [], "photo": None}

        def select_day(_event: Any = None) -> None:
            selection = day_list.curselection()
            if not selection:
                return
            selected_day: EmployeeArchiveDay = days[selection[0]]
            state["day"] = selected_day
            state["captures"] = list(selected_day.captures)
            report_text.configure(state="normal")
            report_text.delete("1.0", "end")
            if selected_day.report_html:
                extractor = _HTMLTextExtractor()
                extractor.feed(selected_day.report_html)
                report_text.insert("1.0", extractor.text())
            else:
                report_text.insert("1.0", "この日の日報はまだ生成されていません。")
            report_text.configure(state="disabled")
            capture_list.delete(0, "end")
            for item in selected_day.captures:
                captured_at = datetime.fromisoformat(item.captured_at).astimezone()
                capture_list.insert("end", f"{captured_at:%H:%M:%S}  {item.status}")
            preview.configure(image="", text="画像を選択してください")
            state["photo"] = None

        def select_capture(_event: Any = None) -> None:
            selection = capture_list.curselection()
            captures = state["captures"]
            if not selection or selection[0] >= len(captures):
                return
            try:
                payload = archive.read_capture(captures[selection[0]])
                image = Image.open(BytesIO(payload))
                image.load()
                image.thumbnail((800, 620), Image.Resampling.LANCZOS)
                photo = ImageTk.PhotoImage(image)
                state["photo"] = photo
                preview.configure(image=photo, text="")
            except Exception as exc:
                preview.configure(image="", text="画像を表示できません")
                state["photo"] = None
                messagebox.showerror(
                    "画像エラー",
                    f"復号または表示に失敗しました: {type(exc).__name__}",
                )

        for item in days:
            suffix = []
            if item.report_html:
                suffix.append("日報")
            if item.captures:
                suffix.append(f"画像{len(item.captures)}")
            day_list.insert("end", f"{item.day.isoformat()}  {' / '.join(suffix)}")
        day_list.bind("<<ListboxSelect>>", select_day)
        capture_list.bind("<<ListboxSelect>>", select_capture)
        for management_item in management_previews:
            state_label = {
                "synced": "同期済み",
                "pending": "送信待ち",
                "failed": "再試行待ち",
                "auth_required": "再認証が必要",
                "not_queued": "未送信",
            }.get(management_item.sync_status, management_item.sync_status)
            draft_label = "確定" if management_item.finalized else "プレビュー"
            management_list.insert(
                "end",
                f"{management_item.period_start}〜{management_item.period_end}  "
                f"{draft_label} / {state_label}",
            )

        def select_management(_event: Any = None) -> None:
            selection = management_list.curselection()
            if not selection:
                return
            selected_management = management_previews[selection[0]]
            extractor = _HTMLTextExtractor()
            extractor.feed(selected_management.report_html)
            management_text.configure(state="normal")
            management_text.delete("1.0", "end")
            management_text.insert("1.0", extractor.text())
            management_text.configure(state="disabled")

        management_list.bind("<<ListboxSelect>>", select_management)
        if management_previews:
            management_list.selection_set(0)
            select_management()
        else:
            management_text.insert("1.0", "管理者向け週次レポートはまだ生成されていません。")
            management_text.configure(state="disabled")
        if days:
            day_list.selection_set(0)
            select_day()
        else:
            report_text.insert("1.0", "表示できる日報または画像がありません。")
            report_text.configure(state="disabled")
        if os.environ.get("SCREEN_CAPTURE_REPORT_VIEWER_SMOKE") == "1":
            root.after(300, root.destroy)
        root.mainloop()

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
            ("氏名", "display_name", self.secrets.get("display_name") or ""),
            ("社員ID", "employee_id", self.secrets.get("employee_id") or ""),
            ("所属部署", "department", self.secrets.get("department") or ""),
            ("勤務開始 HH:MM", "work_start", settings.work_start),
            ("勤務終了 HH:MM", "work_end", settings.work_end),
        ]
        for label, key, current in fields:
            row = tk.Frame(form)
            row.pack(fill="x", pady=5)
            tk.Label(row, text=label, width=22, anchor="w").pack(side="left")
            variable = tk.StringVar(value=current)
            values[key] = variable
            tk.Entry(row, textvariable=variable).pack(side="left", fill="x", expand=True)

        weekday_row = tk.Frame(form)
        weekday_row.pack(fill="x", pady=5)
        tk.Label(weekday_row, text="勤務曜日", width=22, anchor="w").pack(side="left")
        weekday_values = [
            tk.BooleanVar(value=day in settings.work_weekdays) for day in range(len(WEEKDAY_LABELS))
        ]
        for day, label in enumerate(WEEKDAY_LABELS):
            tk.Checkbutton(weekday_row, text=label, variable=weekday_values[day]).pack(side="left")
        tk.Label(
            form,
            text="選択した曜日・時間帯に自動で画面を取得します。",
            anchor="w",
            foreground="#555555",
        ).pack(fill="x", pady=(0, 8))

        api_key = tk.StringVar()
        row = tk.Frame(form)
        row.pack(fill="x", pady=5)
        tk.Label(row, text="Gemini APIキーを変更", width=22, anchor="w").pack(side="left")
        tk.Entry(row, textvariable=api_key, show="*").pack(side="left", fill="x", expand=True)

        autostart = tk.BooleanVar(value=self.autostart.is_enabled())
        tk.Checkbutton(form, text="Windowsログイン時に起動", variable=autostart).pack(
            anchor="w", pady=8
        )

        def save() -> None:
            try:
                if not all(
                    values[key].get().strip()
                    for key in ("display_name", "employee_id", "department")
                ):
                    raise ValueError("氏名、社員ID、所属部署は必須です")
                settings.work_start = values["work_start"].get().strip()
                settings.work_end = values["work_end"].get().strip()
                settings.work_weekdays = selected_weekdays(
                    [value.get() for value in weekday_values]
                )
                self.settings_store.save(settings)
                self.autostart.set_enabled(autostart.get())
                for key in (
                    "display_name",
                    "employee_id",
                    "department",
                ):
                    value = values[key].get().strip()
                    if value:
                        self.secrets.set(key, value)
                    else:
                        self.secrets.delete(key)
                if api_key.get().strip():
                    self.secrets.set("gemini_api_key", api_key.get().strip())
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
                "APIキーと社員情報をWindows資格情報から削除しますか？",
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
                "admin_upload_token",
                "admin_sites_bypass_token",
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
