"""Voice complaint filing, in eight languages.

The most genuinely useful AI feature in this product, and the least discussed. A society
has residents in their seventies and domestic staff with limited literacy. Both can
describe a broken lift out loud; neither will type it into a form in English.

What this does: takes an audio clip, returns a transcript in the speaker's own language,
an English summary for the vendor who will actually be dispatched, and a suggested
category. What it does **not** do is file the ticket. The resident confirms first —
because a complaint filed from a misheard sentence wastes a vendor visit and teaches the
resident that the feature does not work.

Category suggestion is a suggestion. It arrives with a confidence and the helpdesk
service applies its own routing rules on top; the model never picks the vendor.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from app.common.config import Settings

TRANSCRIBE_MODEL = "claude-sonnet-4-5"

# The eight the guard and resident apps ship. Kept here rather than inferred, so the
# model is told what it may return instead of guessing at a dialect we cannot display.
SUPPORTED_LANGUAGES: dict[str, str] = {
    "en": "English",
    "hi": "Hindi",
    "kn": "Kannada",
    "ta": "Tamil",
    "te": "Telugu",
    "mr": "Marathi",
    "bn": "Bengali",
    "ml": "Malayalam",
}


@dataclass
class VoiceComplaint:
    transcript: str = ""
    language: str = "en"
    english_summary: str = ""
    suggested_category: str | None = None
    confidence: str = "low"
    stubbed: bool = False
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "transcript": self.transcript,
            "language": self.language,
            "languageName": SUPPORTED_LANGUAGES.get(self.language, "Unknown"),
            "englishSummary": self.english_summary,
            "suggestedCategory": self.suggested_category,
            "confidence": self.confidence,
            "stubbed": self.stubbed,
            "warnings": self.warnings,
            # The resident confirms before anything is filed. Stated in the payload so a
            # client cannot quietly skip the step.
            "requiresConfirmation": True,
        }


def _prompt() -> str:
    languages = ", ".join(f"{code} ({name})" for code, name in SUPPORTED_LANGUAGES.items())
    return (
        "A resident of an Indian housing society is describing a maintenance problem.\n\n"
        f"Transcribe exactly what they said, in their own language. Supported: {languages}.\n"
        "Then write a one-sentence English summary for the vendor who will be sent.\n\n"
        "Rules:\n"
        "- Transcribe what was said, not what you think they meant. Do not tidy it up.\n"
        "- Keep flat numbers, tower names and times exactly as spoken.\n"
        "- If the audio is unclear, say so in `warnings` and set confidence 'low' — a "
        "guessed complaint wastes a vendor visit and teaches the resident this does not "
        "work.\n"
        "- Suggest a category only if it is obvious. Null is a better answer than a "
        "wrong one; the helpdesk applies its own routing rules regardless.\n\n"
        'Return JSON: {"transcript", "language", "englishSummary", '
        '"suggestedCategory", "confidence", "warnings"}'
    )


def parse_model_response(payload: str) -> VoiceComplaint:
    """Validate the model's answer.

    Never raises. A malformed response yields an empty complaint carrying a warning, and
    the client shows the resident a "we could not hear that, please try again" — which is
    an honest outcome. An exception here would surface as a crash on a phone held by
    someone who is already struggling with the interface.
    """
    result = VoiceComplaint()

    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        result.warnings.append("Could not read the transcription.")
        return result

    if not isinstance(data, dict):
        result.warnings.append("Could not read the transcription.")
        return result

    result.transcript = str(data.get("transcript", "")).strip()[:5000]
    result.english_summary = str(data.get("englishSummary", "")).strip()[:1000]

    language = data.get("language")
    # An unrecognised language falls back to English rather than being displayed in a
    # script the app has no strings for.
    result.language = language if language in SUPPORTED_LANGUAGES else "en"
    if language not in SUPPORTED_LANGUAGES and language:
        result.warnings.append(f"Unsupported language '{language}', treated as English.")

    confidence = data.get("confidence")
    result.confidence = confidence if confidence in ("high", "medium", "low") else "low"

    category = data.get("suggestedCategory")
    result.suggested_category = str(category)[:120] if category else None

    extra = data.get("warnings")
    if isinstance(extra, list):
        result.warnings.extend(str(w)[:200] for w in extra[:10])

    if not result.transcript:
        result.warnings.append("Nothing was transcribed.")
        result.confidence = "low"

    return result


def _stub_result() -> VoiceComplaint:
    return VoiceComplaint(
        transcript="STUB — no Anthropic key configured.",
        language="en",
        english_summary="STUB — voice transcription is not configured.",
        confidence="low",
        stubbed=True,
        warnings=["Voice filing is stubbed. Set ANTHROPIC_API_KEY to transcribe."],
    )


async def transcribe_complaint(
    audio_bytes: bytes,
    media_type: str,
    settings: Settings,
) -> VoiceComplaint:
    if settings.ocr_is_stubbed:
        return _stub_result()

    import base64

    import httpx

    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": settings.anthropic_api_key.get_secret_value(),
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": TRANSCRIBE_MODEL,
                "max_tokens": 4096,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "document",
                                "source": {
                                    "type": "base64",
                                    "media_type": media_type,
                                    "data": base64.standard_b64encode(audio_bytes).decode(
                                        "ascii"
                                    ),
                                },
                            },
                            {"type": "text", "text": _prompt()},
                        ],
                    }
                ],
            },
        )
        response.raise_for_status()
        body = response.json()

    text = "".join(
        block.get("text", "") for block in body.get("content", []) if isinstance(block, dict)
    )
    return parse_model_response(text)
