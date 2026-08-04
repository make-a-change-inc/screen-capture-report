from __future__ import annotations

import json
from types import SimpleNamespace

from src.analyzer import GeminiGateway


class CapturingModels:
    def __init__(self) -> None:
        self.config = None
        self.contents = None

    def generate_content(self, *, model, contents, config):
        self.config = config
        self.contents = contents
        item = {
            "title": "Standardize intake",
            "proposal_type": "workflow",
            "description": "Use one intake form.",
            "expected_effect": "Reduce re-entry.",
            "assumptions": ["The team reviews the form."],
            "evidence_log_ids": ["E0001"],
        }
        return SimpleNamespace(
            text=json.dumps(
                {
                    "improvement_methods": [item],
                    "ai_candidates": [item],
                    "productivity_impacts": [item],
                }
            ),
            usage_metadata=None,
        )


def test_weekly_schema_does_not_enumerate_all_evidence_ids() -> None:
    gateway = GeminiGateway("synthetic-key", "analysis-model", "report-model")
    models = CapturingModels()
    gateway.client = SimpleNamespace(models=models)
    evidence_ids = [f"log-{index:04d}" for index in range(500)]

    response = gateway.weekly_insights(
        aggregates=[
            {
                "category": "development",
                "minutes": 500,
                "evidence_log_ids": evidence_ids,
            }
        ],
        evidence_log_ids=evidence_ids,
    )

    schema = models.config["response_schema"]
    suggestion = schema["properties"]["improvement_methods"]["items"]
    evidence_items = suggestion["properties"]["evidence_log_ids"]["items"]
    assert evidence_items == {"type": "string"}
    assert "log-0000" not in json.dumps(schema)
    assert "log-0000" not in models.contents
    assert "E0001" in models.contents
    assert response.improvement_methods[0]["evidence_log_ids"] == ["log-0000"]
