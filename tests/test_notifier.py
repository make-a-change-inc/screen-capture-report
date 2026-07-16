from __future__ import annotations

from src.config import MemorySecretStore
from src.notifier import EmailNotifier


class FakeSMTP:
    tls_context = None
    def __init__(self, host, port, timeout):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.message = None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def starttls(self, *, context):
        type(self).tls_context = context
        return None

    def login(self, user, password):
        assert user == "sender@example.test"
        assert password == "secret"

    def send_message(self, message):
        self.message = message


def test_email_contract(settings) -> None:
    secrets = MemorySecretStore(
        {
            "smtp_user": "sender@example.test",
            "email_from": "sender@example.test",
            "smtp_password": "secret",
        }
    )
    notifier = EmailNotifier(
        settings_provider=lambda: settings,
        secrets=secrets,
        smtp_factory=FakeSMTP,
    )

    result = notifier.send_html(
        destination="employee@example.test",
        subject="Synthetic report",
        html_body="<h1>Safe synthetic report</h1>",
    )

    assert result.success
    assert FakeSMTP.tls_context is not None
    assert FakeSMTP.tls_context.check_hostname
    assert FakeSMTP.tls_context.verify_mode.name == "CERT_REQUIRED"


def test_email_requires_configuration(settings) -> None:
    notifier = EmailNotifier(
        settings_provider=lambda: settings,
        secrets=MemorySecretStore(),
        smtp_factory=FakeSMTP,
    )
    result = notifier.send_html(destination="", subject="x", html_body="x")
    assert not result.success
    assert result.error_code == "smtp_not_configured"
