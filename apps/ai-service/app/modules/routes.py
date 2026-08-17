"""HTTP surface for the AI service.

Every route here is **internal**. The TypeScript API calls this service with a shared
service token; residents and guards never reach it directly. That boundary matters:
these endpoints accept a resident's bank statement and a resident's voice, and neither
should be reachable from the public internet with a user session.

Nothing here writes to the database. Extraction returns candidates, transcription
returns text, and the TypeScript service decides what becomes a receipt or a ticket —
against the same ledger and helpdesk rules as a manually entered one.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, File, Header, HTTPException, UploadFile, status

from app.common.config import Settings, get_settings
from app.modules.ocr import extract_statement
from app.modules.voice import transcribe_complaint

router = APIRouter(prefix="/internal/ai", tags=["ai"])

# A statement from a large society runs to a few hundred KB; a voice note to a couple of
# MB. Bounded so a malformed or hostile upload cannot exhaust the container's memory
# before FastAPI has a chance to reject it.
MAX_PDF_BYTES = 20 * 1024 * 1024
MAX_AUDIO_BYTES = 25 * 1024 * 1024

ALLOWED_AUDIO = {"audio/mpeg", "audio/mp4", "audio/wav", "audio/webm", "audio/ogg"}


def require_service_token(
    settings: Annotated[Settings, Depends(get_settings)],
    x_service_token: Annotated[str | None, Header()] = None,
) -> None:
    """Only the TypeScript API may call this service.

    Compared with `secrets.compare_digest` rather than `==` — a plain comparison returns
    early on the first differing byte, which leaks the token's prefix to anyone able to
    time the responses.
    """
    import secrets as _secrets

    expected = settings.service_token
    if expected is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="This service is not configured to accept calls.",
        )
    presented = x_service_token or ""
    if not _secrets.compare_digest(presented, expected.get_secret_value()):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid service token.",
        )


@router.post("/statements/extract", dependencies=[Depends(require_service_token)])
async def extract(
    settings: Annotated[Settings, Depends(get_settings)],
    file: Annotated[UploadFile, File()],
) -> dict:
    """Read a bank statement into reconciliation candidates.

    Returns `posted: false` always. This service cannot write to the ledger and has no
    database credentials to do so with — the guarantee is structural, not a promise.
    """
    payload = await file.read(MAX_PDF_BYTES + 1)
    if len(payload) > MAX_PDF_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="That statement is too large.",
        )
    if not payload:
        raise HTTPException(
            status_code=422,  # Unprocessable Content
            detail="The file was empty.",
        )

    result = await extract_statement(payload, settings)
    return result.as_dict()


@router.post("/complaints/transcribe", dependencies=[Depends(require_service_token)])
async def transcribe(
    settings: Annotated[Settings, Depends(get_settings)],
    file: Annotated[UploadFile, File()],
) -> dict:
    """Transcribe a spoken complaint.

    Returns `requiresConfirmation: true` always. The resident sees the transcript and
    confirms before a ticket exists, because a complaint filed from a misheard sentence
    wastes a vendor visit and teaches them the feature does not work.
    """
    media_type = file.content_type or "audio/mpeg"
    if media_type not in ALLOWED_AUDIO:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Unsupported audio format: {media_type}",
        )

    payload = await file.read(MAX_AUDIO_BYTES + 1)
    if len(payload) > MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="That recording is too long.",
        )
    if not payload:
        raise HTTPException(
            status_code=422,  # Unprocessable Content
            detail="The recording was empty.",
        )

    result = await transcribe_complaint(payload, media_type, settings)
    return result.as_dict()


@router.get("/capabilities", dependencies=[Depends(require_service_token)])
async def capabilities(
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict:
    """What this service can actually do right now.

    The console shows this rather than advertising a feature that is stubbed. A society
    told "voice complaints are available" that then gets a placeholder transcript learns
    to distrust everything else on the page.
    """
    stubbed = settings.ocr_is_stubbed
    return {
        "statementExtraction": not stubbed,
        "voiceTranscription": not stubbed,
        "stubbed": stubbed,
        "reason": "No Anthropic API key configured." if stubbed else None,
    }
