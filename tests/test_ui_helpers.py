from src.config import Settings
from src.ui import _HTMLTextExtractor, onboarding_notice


def test_html_report_is_rendered_in_memory() -> None:
    extractor = _HTMLTextExtractor()
    extractor.feed("<h1>日報</h1><p>安全な合成データ</p>")

    assert "日報" in extractor.text()
    assert "安全な合成データ" in extractor.text()


def test_onboarding_notice_discloses_collection_and_rights() -> None:
    notice = onboarding_notice(Settings())

    for required in (
        "60秒ごと",
        "Google Gemini API",
        "最大24時間",
        "業務ログは30日",
        "レポートは90日",
        "本人メール",
        "経営レポートメール",
        "訂正・削除・事故連絡",
        "停止状態は再起動後も維持",
    ):
        assert required in notice
