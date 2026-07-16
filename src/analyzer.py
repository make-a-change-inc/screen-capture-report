from __future__ import annotations

import io
import json
import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Protocol

from PIL import Image

from src.capturer import ScreenCapturer
from src.config import SecretBackend, Settings
from src.storage import CaptureRecord, Database

logger = logging.getLogger(__name__)


def analysis_batch_ready(
    records: list[CaptureRecord],
    *,
    batch_size: int,
    interval_seconds: int,
    now: datetime | None = None,
) -> bool:
    if len(records) >= batch_size:
        return True
    if not records:
        return False
    current = (now or datetime.now().astimezone()).astimezone()
    oldest = min(datetime.fromisoformat(record.captured_at).astimezone() for record in records)
    maximum_wait = timedelta(seconds=interval_seconds * batch_size)
    return current - oldest >= maximum_wait


@dataclass(slots=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    measured: bool = True


class ModelResponseError(RuntimeError):
    def __init__(self, usage: Usage, cause_name: str):
        super().__init__(cause_name)
        self.usage = usage


@dataclass(slots=True)
class AnalysisItem:
    category: str
    summary: str
    confidence: float
    estimated_minutes: float
    capture_ids: list[str]


@dataclass(slots=True)
class AnalysisResponse:
    items: list[AnalysisItem]
    usage: Usage


@dataclass(slots=True)
class WeeklyResponse:
    improvement_methods: list[dict[str, Any]]
    ai_candidates: list[dict[str, Any]]
    productivity_impacts: list[dict[str, Any]]
    usage: Usage


class AnalysisGateway(Protocol):
    def analyze(
        self,
        *,
        images: list[Image.Image],
        capture_ids: list[str],
        categories: list[dict[str, str]],
        interval_minutes: float,
    ) -> AnalysisResponse: ...

    def weekly_insights(
        self,
        *,
        aggregates: list[dict[str, Any]],
        evidence_log_ids: list[str],
    ) -> WeeklyResponse: ...


class GeminiGateway:
    def __init__(self, api_key: str, analysis_model: str, report_model: str):
        if not api_key:
            raise ValueError("Gemini API key is required")
        try:
            from google import genai
        except ImportError as exc:  # pragma: no cover - packaging failure path
            raise RuntimeError("google-genai is required") from exc
        self.client = genai.Client(api_key=api_key)
        self.analysis_model = analysis_model
        self.report_model = report_model

    def analyze(
        self,
        *,
        images: list[Image.Image],
        capture_ids: list[str],
        categories: list[dict[str, str]],
        interval_minutes: float,
    ) -> AnalysisResponse:
        category_ids = [item["id"] for item in categories]
        schema = {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "category": {"type": "string", "enum": category_ids},
                            "summary": {"type": "string"},
                            "confidence": {"type": "number"},
                            "estimated_minutes": {"type": "number"},
                            "capture_ids": {
                                "type": "array",
                                "items": {"type": "string", "enum": capture_ids},
                            },
                        },
                        "required": [
                            "category",
                            "summary",
                            "confidence",
                            "estimated_minutes",
                            "capture_ids",
                        ],
                    },
                }
            },
            "required": ["items"],
        }
        prompt = (
            "あなたは業務改善用の活動分類器です。画像を時系列に分析し、"
            "推測できない固有名詞や個人情報は出力せず、各画像を必ず一つの項目へ割り当ててください。"
            f"利用可能カテゴリ: {json.dumps(categories, ensure_ascii=False)}。"
            f"画像IDの順序: {json.dumps(capture_ids)}。"
            f"1画像あたりの基準時間は{interval_minutes:.2f}分です。"
            "要約は業務内容だけを簡潔にし、パスワード、メール本文、顧客名などの生情報を転記しないでください。"
        )
        contents: list[Any] = [prompt, *images]
        response = self.client.models.generate_content(
            model=self.analysis_model,
            contents=contents,
            config={
                "response_mime_type": "application/json",
                "response_schema": schema,
            },
        )
        usage = self._usage(response)
        try:
            payload = json.loads(response.text or "")
            items = [
                AnalysisItem(
                    category=item["category"],
                    summary=item["summary"],
                    confidence=float(item["confidence"]),
                    estimated_minutes=float(item["estimated_minutes"]),
                    capture_ids=list(item["capture_ids"]),
                )
                for item in payload["items"]
            ]
        except Exception as exc:
            raise ModelResponseError(usage, type(exc).__name__) from exc
        return AnalysisResponse(items=items, usage=usage)

    def weekly_insights(
        self,
        *,
        aggregates: list[dict[str, Any]],
        evidence_log_ids: list[str],
    ) -> WeeklyResponse:
        suggestion = {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "proposal_type": {"type": "string"},
                "description": {"type": "string"},
                "expected_effect": {"type": "string"},
                "assumptions": {"type": "array", "items": {"type": "string"}},
                "evidence_log_ids": {
                    "type": "array",
                    "items": {"type": "string", "enum": evidence_log_ids},
                },
            },
            "required": [
                "title",
                "proposal_type",
                "description",
                "expected_effect",
                "assumptions",
                "evidence_log_ids",
            ],
        }
        schema = {
            "type": "object",
            "properties": {
                "improvement_methods": {"type": "array", "items": suggestion},
                "ai_candidates": {"type": "array", "items": suggestion},
                "productivity_impacts": {"type": "array", "items": suggestion},
            },
            "required": [
                "improvement_methods",
                "ai_candidates",
                "productivity_impacts",
            ],
        }
        prompt = (
            "以下の週次業務集計から、経営層が採否判断できる業務改善案を作成してください。"
            "従業員の順位付け、査定、懲戒、個人比較は行わないでください。"
            "各提案に種類、期待効果、前提、根拠ログIDを含め、根拠のない数値は断定しないでください。"
            f"集計: {json.dumps(aggregates, ensure_ascii=False)}"
        )
        response = self.client.models.generate_content(
            model=self.report_model,
            contents=prompt,
            config={
                "response_mime_type": "application/json",
                "response_schema": schema,
            },
        )
        usage = self._usage(response)
        try:
            payload = json.loads(response.text or "")
            return WeeklyResponse(
                improvement_methods=payload["improvement_methods"],
                ai_candidates=payload["ai_candidates"],
                productivity_impacts=payload["productivity_impacts"],
                usage=usage,
            )
        except Exception as exc:
            raise ModelResponseError(usage, type(exc).__name__) from exc

    @staticmethod
    def _usage(response: Any) -> Usage:
        metadata = getattr(response, "usage_metadata", None)
        prompt_tokens = getattr(metadata, "prompt_token_count", None)
        output_tokens = getattr(metadata, "candidates_token_count", None)
        if metadata is None or prompt_tokens is None or output_tokens is None:
            return Usage(measured=False)
        return Usage(
            input_tokens=int(prompt_tokens),
            output_tokens=int(output_tokens),
            measured=True,
        )


class AnalysisCoordinator:
    def __init__(
        self,
        *,
        database: Database,
        capturer: ScreenCapturer,
        settings_provider: Callable[[], Settings],
        gateway_provider: Callable[[], AnalysisGateway],
    ):
        self.database = database
        self.capturer = capturer
        self.settings_provider = settings_provider
        self.gateway_provider = gateway_provider
        self._processing_lock = threading.Lock()

    def process_pending(self, *, force: bool = False) -> int:
        with self._processing_lock:
            return self._process_pending(force=force)

    def _process_pending(self, *, force: bool = False) -> int:
        settings = self.settings_provider()
        records = self.database.pending_captures(
            limit=settings.analysis_batch_size,
            ignore_retry_at=force,
        )
        if not records:
            return 0
        if not force and not analysis_batch_ready(
            records,
            batch_size=settings.analysis_batch_size,
            interval_seconds=settings.capture_interval_seconds,
        ):
            return 0
        ready_records: list[CaptureRecord] = []
        images: list[Image.Image] = []
        for record in records:
            try:
                images.append(self._load_image(record))
                ready_records.append(record)
            except Exception as exc:
                delay = min(3600, 60 * (2**record.retry_count))
                self.database.mark_analysis_failed(
                    [record.id],
                    type(exc).__name__,
                    retry_at=datetime.now().astimezone() + timedelta(seconds=delay),
                )
        if not ready_records:
            return 0
        records = ready_records
        capture_ids = [record.id for record in records]
        attempt_usage = Usage(measured=False)
        try:
            response = self.gateway_provider().analyze(
                images=images,
                capture_ids=capture_ids,
                categories=settings.categories,
                interval_minutes=settings.capture_interval_seconds / 60.0,
            )
            attempt_usage = response.usage
            self._validate_response(response, capture_ids, settings)
            timestamps = [datetime.fromisoformat(record.captured_at) for record in records]
            logs: list[dict[str, Any]] = []
            for item in response.items:
                item_times = [
                    datetime.fromisoformat(record.captured_at)
                    for record in records
                    if record.id in item.capture_ids
                ]
                logs.append(
                    {
                        "start_at": min(item_times or timestamps),
                        "end_at": max(item_times or timestamps)
                        + timedelta(seconds=settings.capture_interval_seconds),
                        "category": item.category,
                        "summary": item.summary,
                        "confidence": item.confidence,
                        "estimated_minutes": item.estimated_minutes,
                        "capture_ids": item.capture_ids,
                    }
                )
            self.database.complete_analysis(
                capture_ids=capture_ids,
                logs=logs,
                cost=self._cost_entry(
                    operation="capture_analysis",
                    model=settings.analysis_model,
                    usage=response.usage,
                    settings=settings,
                ),
            )
        except Exception as exc:
            if isinstance(exc, ModelResponseError):
                attempt_usage = exc.usage
            cost_entry = self._cost_entry(
                operation="capture_analysis",
                model=settings.analysis_model,
                usage=attempt_usage,
                settings=settings,
            )
            try:
                self.database.add_cost(**cost_entry)
            except Exception as cost_exc:
                logger.error("Failed analysis cost audit: %s", type(cost_exc).__name__)
            retry_count = max((record.retry_count for record in records), default=0)
            delay = min(3600, 60 * (2**retry_count))
            error_code = type(exc).__name__
            logger.warning("Analysis failed: %s", error_code)
            self.database.mark_analysis_failed(
                capture_ids,
                error_code,
                retry_at=datetime.now().astimezone() + timedelta(seconds=delay),
            )
            return 0
        if settings.capture_retention_hours == 0:
            for capture_id in capture_ids:
                try:
                    self.capturer.delete_capture_payload(
                        capture_id, "analysis_success_immediate_delete"
                    )
                except Exception as exc:
                    logger.error("Post-analysis deletion failed: %s", type(exc).__name__)
        return len(capture_ids)

    def _load_image(self, record: CaptureRecord) -> Image.Image:
        if not record.file_path:
            raise FileNotFoundError(record.id)
        image = Image.open(io.BytesIO(self.capturer.read_capture(record.id)))
        image.load()
        return image

    @staticmethod
    def _validate_response(
        response: AnalysisResponse, capture_ids: list[str], settings: Settings
    ) -> None:
        allowed_categories = {item["id"] for item in settings.categories}
        assigned: list[str] = []
        for item in response.items:
            if item.category not in allowed_categories:
                raise ValueError("unknown_category")
            if not 0 <= item.confidence <= 1:
                raise ValueError("invalid_confidence")
            if item.estimated_minutes < 0:
                raise ValueError("invalid_duration")
            if not set(item.capture_ids).issubset(capture_ids):
                raise ValueError("unknown_capture_id")
            assigned.extend(item.capture_ids)
        if sorted(assigned) != sorted(capture_ids):
            raise ValueError("captures_must_be_assigned_once")

    @staticmethod
    def _cost_entry(
        *, operation: str, model: str, usage: Usage, settings: Settings
    ) -> dict[str, Any]:
        configured = bool(
            settings.token_input_jpy_per_million or settings.token_output_jpy_per_million
        )
        cost = None
        if configured and usage.measured:
            cost = (
                usage.input_tokens * settings.token_input_jpy_per_million
                + usage.output_tokens * settings.token_output_jpy_per_million
            ) / 1_000_000
        return {
            "operation": operation,
            "model": model,
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "cost_jpy": cost,
            "is_estimate": not (configured and usage.measured),
        }


def build_gateway(settings: Settings, secrets: SecretBackend) -> GeminiGateway:
    api_key = secrets.get("gemini_api_key") or ""
    return GeminiGateway(api_key, settings.analysis_model, settings.report_model)
