"""Parsing of model output.

Every test here is about what happens when the model is *wrong*, because that is the
only interesting case. A model returning clean JSON needs no defending; a model that
hallucinates a row, mislabels a direction or returns prose instead of JSON is what
actually reaches an accountant.

The rule these encode: **a bad row is dropped with a warning, never raised and never
silently accepted.** Raising loses the other 199 rows of a statement. Accepting puts a
wrong number into a reconciliation, which is the one place nobody would look for it.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.modules.ocr import normalise_amount, parse_model_response as parse_ocr
from app.modules.voice import SUPPORTED_LANGUAGES, parse_model_response as parse_voice


class TestNormaliseAmount:
    def test_strips_what_a_statement_prints(self) -> None:
        assert normalise_amount("₹1,23,456.50") == "123456.50"
        assert normalise_amount("  4,500.00  ") == "4500.00"
        assert normalise_amount("1500.00 Cr") == "1500.00"

    def test_returns_a_string_not_a_float(self) -> None:
        value = normalise_amount("6497.4999")
        assert isinstance(value, str)
        assert value == "6497.4999"

    def test_preserves_precision_a_float_would_lose(self) -> None:
        # The string is returned as cleaned, not re-rendered from a Decimal, so the
        # bank's own precision and trailing zeros survive exactly.
        assert normalise_amount("99999999999999999.99") == "99999999999999999.99"
        assert normalise_amount("100.00") == "100.00"

    def test_rejects_what_is_not_an_amount(self) -> None:
        for junk in ["", "abc", "1.2.3", "12.345678", "--5"]:
            assert normalise_amount(junk) is None


class TestStatementParsing:
    def _payload(self, lines: list[dict]) -> str:
        return json.dumps({"lines": lines})

    def test_reads_a_well_formed_statement(self) -> None:
        result = parse_ocr(
            self._payload(
                [
                    {
                        "valueDate": "2026-08-01",
                        "description": "NEFT A-101 MAINT",
                        "amount": "4500.00",
                        "direction": "credit",
                        "confidence": "high",
                    }
                ]
            )
        )
        assert len(result.lines) == 1
        assert result.lines[0].amount == "4500.00"
        assert not result.warnings

    def test_one_bad_row_does_not_lose_the_others(self) -> None:
        result = parse_ocr(
            self._payload(
                [
                    {
                        "valueDate": "2026-08-01",
                        "description": "good",
                        "amount": "100.00",
                        "direction": "credit",
                    },
                    {"valueDate": "2026-08-02", "description": "bad", "amount": "???"},
                    {
                        "valueDate": "2026-08-03",
                        "description": "good",
                        "amount": "200.00",
                        "direction": "debit",
                    },
                ]
            )
        )
        assert len(result.lines) == 2
        assert len(result.warnings) == 1
        assert "Row 2" in result.warnings[0]

    def test_an_unlabelled_row_is_treated_as_uncertain(self) -> None:
        # The safe default is the one that puts a row in front of a person.
        result = parse_ocr(
            self._payload(
                [
                    {
                        "valueDate": "2026-08-01",
                        "description": "x",
                        "amount": "1.00",
                        "direction": "credit",
                    }
                ]
            )
        )
        assert result.lines[0].confidence == "low"

    def test_prose_instead_of_json_yields_a_warning_not_a_crash(self) -> None:
        result = parse_ocr("Sure! Here is the statement you asked for:")
        assert result.lines == []
        assert result.warnings

    def test_an_unknown_direction_is_dropped_rather_than_guessed(self) -> None:
        # Guessing credit vs debit inverts a reconciliation. Dropping is recoverable;
        # a silently inverted transaction is not.
        result = parse_ocr(
            self._payload(
                [
                    {
                        "valueDate": "2026-08-01",
                        "description": "x",
                        "amount": "1.00",
                        "direction": "sideways",
                    }
                ]
            )
        )
        assert result.lines == []
        assert result.warnings

    def test_the_payload_states_that_nothing_was_posted(self) -> None:
        # Every consumer is reminded the ledger is untouched.
        assert parse_ocr(self._payload([])).as_dict()["posted"] is False


class TestVoiceParsing:
    def test_reads_a_complaint(self) -> None:
        result = parse_voice(
            json.dumps(
                {
                    "transcript": "ಲಿಫ್ಟ್‌ನಲ್ಲಿ ಲೈಟ್ ಕೆಲಸ ಮಾಡುತ್ತಿಲ್ಲ",
                    "language": "kn",
                    "englishSummary": "The light in the lift is not working.",
                    "suggestedCategory": "Common Area > Lift > Lighting",
                    "confidence": "high",
                }
            )
        )
        assert result.language == "kn"
        assert result.confidence == "high"
        assert result.suggested_category is not None

    def test_an_unsupported_language_falls_back_rather_than_rendering_nothing(self) -> None:
        # The app has no strings for a language it does not ship; displaying a script it
        # cannot lay out is worse than falling back.
        result = parse_voice(
            json.dumps({"transcript": "hello", "language": "fr", "confidence": "high"})
        )
        assert result.language == "en"
        assert any("Unsupported language" in w for w in result.warnings)

    def test_empty_audio_is_reported_honestly(self) -> None:
        result = parse_voice(json.dumps({"transcript": "", "language": "en"}))
        assert result.confidence == "low"
        assert any("Nothing was transcribed" in w for w in result.warnings)

    def test_garbage_yields_a_warning_not_an_exception(self) -> None:
        # This runs on a phone held by someone already struggling with the interface.
        # A crash is the worst possible outcome.
        for junk in ["", "not json", "[]", "null"]:
            result = parse_voice(junk)
            assert result.warnings

    def test_confirmation_is_always_required(self) -> None:
        # A complaint filed from a misheard sentence wastes a vendor visit and teaches
        # the resident the feature does not work.
        payload = parse_voice(json.dumps({"transcript": "x", "language": "en"})).as_dict()
        assert payload["requiresConfirmation"] is True

    def test_all_eight_app_languages_are_supported(self) -> None:
        assert set(SUPPORTED_LANGUAGES) == {
            "en",
            "hi",
            "kn",
            "ta",
            "te",
            "mr",
            "bn",
            "ml",
        }


class TestEndpoints:
    """The HTTP surface, including the parts that must refuse.

    These endpoints take a resident's bank statement and a resident's voice. Nothing
    with a user session should ever reach them — only the TypeScript API, holding the
    shared service token.
    """

    def _client(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("DATABASE_URL", "postgresql://unused/unused")
        monkeypatch.setenv("JWT_SECRET", "test-secret-at-least-16-chars")
        monkeypatch.setenv("SERVICE_TOKEN", "test-token")
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

        from app.common.config import get_settings

        get_settings.cache_clear()
        from app.main import app

        return TestClient(app)

    def test_liveness_checks_nothing_external(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Cloud Run restarts a container that fails this, and restarting fixes neither a
        # missing key nor an Anthropic outage — it would turn degraded into a crash loop.
        assert self._client(monkeypatch).get("/healthz").status_code == 200

    def test_readiness_reports_stub_mode_rather_than_failing_on_it(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        body = self._client(monkeypatch).get("/readyz").json()
        assert body["status"] == "ready"
        assert body["ocrStubbed"] is True

    def test_no_token_is_refused(self, monkeypatch: pytest.MonkeyPatch) -> None:
        assert self._client(monkeypatch).get("/internal/ai/capabilities").status_code == 401

    def test_a_wrong_token_is_refused(self, monkeypatch: pytest.MonkeyPatch) -> None:
        client = self._client(monkeypatch)
        response = client.get(
            "/internal/ai/capabilities", headers={"x-service-token": "wrong"}
        )
        assert response.status_code == 401

    def test_capabilities_admits_what_is_stubbed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A society told "voice complaints are available" that then gets a placeholder
        # learns to distrust everything else on the page.
        body = self._client(monkeypatch).get(
            "/internal/ai/capabilities", headers={"x-service-token": "test-token"}
        ).json()
        assert body["stubbed"] is True
        assert body["voiceTranscription"] is False
        assert body["reason"]

    def test_extraction_never_reports_a_posting(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        body = self._client(monkeypatch).post(
            "/internal/ai/statements/extract",
            headers={"x-service-token": "test-token"},
            files={"file": ("s.pdf", b"%PDF fake", "application/pdf")},
        ).json()
        assert body["posted"] is False
        assert body["stubbed"] is True

    def test_an_empty_upload_is_rejected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        response = self._client(monkeypatch).post(
            "/internal/ai/statements/extract",
            headers={"x-service-token": "test-token"},
            files={"file": ("s.pdf", b"", "application/pdf")},
        )
        assert response.status_code == 422

    def test_a_non_audio_upload_is_rejected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        response = self._client(monkeypatch).post(
            "/internal/ai/complaints/transcribe",
            headers={"x-service-token": "test-token"},
            files={"file": ("a.txt", b"x", "text/plain")},
        )
        assert response.status_code == 415

    def test_transcription_always_asks_for_confirmation(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        body = self._client(monkeypatch).post(
            "/internal/ai/complaints/transcribe",
            headers={"x-service-token": "test-token"},
            files={"file": ("a.mp3", b"fake", "audio/mpeg")},
        ).json()
        assert body["requiresConfirmation"] is True
