from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from urllib.parse import urlparse

DEFAULT_ADMIN_API_URL = "https://screen-capture-report-admin.m-okamura-8e7.workers.dev"


def admin_api_url() -> str:
    return os.environ.get("SCREEN_CAPTURE_REPORT_ADMIN_API_URL", DEFAULT_ADMIN_API_URL).rstrip("/")


@dataclass(frozen=True, slots=True)
class EnrollmentResult:
    device_token: str
    api_url: str


class EnrollmentClient:
    def __init__(self, *, timeout_seconds: float = 20.0):
        self.timeout_seconds = timeout_seconds

    def enroll(
        self,
        *,
        invite_code: str,
        display_name: str,
        employee_id: str,
        department: str,
        api_url: str | None = None,
    ) -> EnrollmentResult:
        base_url = (api_url or admin_api_url()).rstrip("/")
        parsed = urlparse(base_url)
        if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1"}:
            raise ValueError("管理サーバーのURLが正しくありません")
        payload = json.dumps(
            {
                "inviteCode": invite_code,
                "displayName": display_name,
                "employeeId": employee_id,
                "department": department,
            },
            ensure_ascii=False,
        ).encode("utf-8")
        request = urllib.request.Request(
            base_url + "/api/enroll",
            data=payload,
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "User-Agent": "ScreenCaptureReport/0.3",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 401:
                raise ValueError("招待コードが正しくありません") from None
            raise ValueError("管理サーバーへの登録に失敗しました") from None
        except urllib.error.URLError:
            raise ValueError("管理サーバーに接続できません") from None
        token = str(body.get("deviceToken") or "")
        if not token:
            raise ValueError("管理サーバーから登録情報を受け取れませんでした")
        return EnrollmentResult(device_token=token, api_url=base_url)
