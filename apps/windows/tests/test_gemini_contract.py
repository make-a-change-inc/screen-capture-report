from __future__ import annotations

from google.genai.types import GenerateContentConfig


def test_installed_google_genai_accepts_structured_output_config() -> None:
    schema = {
        "type": "object",
        "properties": {"category": {"type": "string"}},
        "required": ["category"],
    }

    config = GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=schema,
    )

    assert config.response_mime_type == "application/json"
    assert config.response_schema is not None
