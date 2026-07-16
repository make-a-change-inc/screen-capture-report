from __future__ import annotations

import smtplib
import ssl
from collections.abc import Callable
from dataclasses import dataclass
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from src.config import SecretBackend, Settings


@dataclass(slots=True)
class DeliveryResult:
    success: bool
    error_code: str | None = None


class EmailNotifier:
    def __init__(
        self,
        *,
        settings_provider: Callable[[], Settings],
        secrets: SecretBackend,
        smtp_factory: Callable[..., smtplib.SMTP] = smtplib.SMTP,
    ):
        self.settings_provider = settings_provider
        self.secrets = secrets
        self.smtp_factory = smtp_factory

    def send_html(self, *, destination: str, subject: str, html_body: str) -> DeliveryResult:
        settings = self.settings_provider()
        smtp_user = self.secrets.get("smtp_user")
        password = self.secrets.get("smtp_password")
        if not destination or not smtp_user or not password:
            return DeliveryResult(False, "smtp_not_configured")
        email_from = self.secrets.get("email_from") or smtp_user
        message = MIMEMultipart("alternative")
        message["From"] = email_from
        message["To"] = destination
        message["Subject"] = subject
        message.attach(MIMEText(html_body, "html", "utf-8"))
        try:
            with self.smtp_factory(settings.smtp_server, settings.smtp_port, timeout=30) as server:
                server.starttls(context=ssl.create_default_context())
                server.login(smtp_user, password)
                server.send_message(message)
            return DeliveryResult(True)
        except Exception as exc:
            return DeliveryResult(False, type(exc).__name__)
