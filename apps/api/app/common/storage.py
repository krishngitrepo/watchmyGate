"""Cloudflare R2 object storage.

Two rules that carry the tenant boundary into the object store:

1. **Every key is prefixed with the society id.** `societies/{society_id}/…`. A signed
   URL therefore proves which society an object belongs to, and a listing cannot span
   tenants even if a query is wrong.
2. **Nothing is ever public.** The bucket is private; access is always a short-lived
   presigned URL. Uploads are presigned too, so photo bytes go straight from the
   resident's phone to R2 and never through the API — which matters at ~2M gate photos
   a day.

Cross-society access returns 404 rather than 403: confirming an object exists is
itself a disclosure.

Stub mode (no R2 credentials) returns deterministic fake URLs so the complaint and
gate flows are testable end to end without a Cloudflare account.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import urllib.parse
import uuid
from typing import Literal

import structlog

from app.common.config import get_settings
from app.common.errors import ValidationError

log = structlog.get_logger(__name__)

AttachmentKind = Literal["photo", "video", "voice", "document"]

#: Deliberately narrow. Anything not listed is rejected at the API boundary rather
#: than stored and dealt with later.
ALLOWED_CONTENT_TYPES: dict[str, AttachmentKind] = {
    "image/jpeg": "photo",
    "image/png": "photo",
    "image/webp": "photo",
    "image/heic": "photo",
    "video/mp4": "video",
    "video/quicktime": "video",
    "audio/mpeg": "voice",
    "audio/mp4": "voice",
    "audio/ogg": "voice",
    "audio/webm": "voice",
    "application/pdf": "document",
}

MAX_BYTES: dict[AttachmentKind, int] = {
    "photo": 15 * 1024 * 1024,
    "video": 100 * 1024 * 1024,
    "voice": 10 * 1024 * 1024,
    "document": 25 * 1024 * 1024,
}

UPLOAD_URL_TTL = dt.timedelta(minutes=15)
DOWNLOAD_URL_TTL = dt.timedelta(minutes=10)


def classify(content_type: str) -> AttachmentKind:
    kind = ALLOWED_CONTENT_TYPES.get(content_type.lower().split(";")[0].strip())
    if kind is None:
        raise ValidationError(f"Files of type {content_type} are not accepted.")
    return kind


def build_key(
    society_id: uuid.UUID,
    owner_type: str,
    owner_id: uuid.UUID,
    kind: AttachmentKind,
) -> str:
    """Object key. The society prefix is the tenant boundary in the object store."""
    stamp = dt.datetime.now(dt.UTC).strftime("%Y/%m")
    return f"societies/{society_id}/{owner_type}/{stamp}/{owner_id}/{kind}/{uuid.uuid4().hex}"


def key_belongs_to(key: str, society_id: uuid.UUID) -> bool:
    """Guard every download against the caller's society.

    RLS protects the database row; this protects the object itself, so a leaked or
    guessed key cannot be redeemed by a member of another society.
    """
    return key.startswith(f"societies/{society_id}/")


def _sign(secret: str, msg: str) -> str:
    return hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()


def presign_upload(
    society_id: uuid.UUID,
    owner_type: str,
    owner_id: uuid.UUID,
    content_type: str,
    content_length: int,
) -> tuple[str, str]:
    """Return `(object_key, upload_url)`.

    The phone PUTs bytes directly to R2. The API never handles the file, so a resident
    attaching two lift photos costs us no bandwidth and no memory.
    """
    kind = classify(content_type)
    limit = MAX_BYTES[kind]
    if content_length > limit:
        raise ValidationError(
            f"That {kind} is too large. The limit is {limit // (1024 * 1024)} MB."
        )
    if content_length <= 0:
        raise ValidationError("Empty files cannot be uploaded.")

    key = build_key(society_id, owner_type, owner_id, kind)
    settings = get_settings()

    if settings.storage_is_stubbed:
        log.warning("storage_stub_upload", key=key, content_type=content_type)
        return key, f"https://stub.local/upload/{urllib.parse.quote(key, safe='')}"

    expires = int((dt.datetime.now(dt.UTC) + UPLOAD_URL_TTL).timestamp())
    host = settings.r2_public_host or f"{settings.r2_account_id}.r2.cloudflarestorage.com"
    secret = settings.r2_secret_access_key.get_secret_value()  # type: ignore[union-attr]
    signature = _sign(secret, f"PUT\n{key}\n{expires}\n{content_type}")

    url = (
        f"https://{host}/{settings.r2_bucket}/{key}"
        f"?X-Amz-Expires={expires}"
        f"&X-Amz-Credential={settings.r2_access_key_id}"
        f"&X-Amz-Signature={signature}"
    )
    return key, url


def presign_download(key: str, society_id: uuid.UUID) -> str:
    """Short-lived read URL, scoped to the caller's society.

    Raises `NotFoundError` semantics via ValidationError-free 404 handling upstream —
    callers must map a mismatch to 404, never 403.
    """
    if not key_belongs_to(key, society_id):
        # Caller is expected to translate this into a 404.
        raise PermissionError("Object does not belong to this society.")

    settings = get_settings()
    if settings.storage_is_stubbed:
        return f"https://stub.local/download/{urllib.parse.quote(key, safe='')}"

    expires = int((dt.datetime.now(dt.UTC) + DOWNLOAD_URL_TTL).timestamp())
    host = settings.r2_public_host or f"{settings.r2_account_id}.r2.cloudflarestorage.com"
    secret = settings.r2_secret_access_key.get_secret_value()  # type: ignore[union-attr]
    signature = _sign(secret, f"GET\n{key}\n{expires}")

    return (
        f"https://{host}/{settings.r2_bucket}/{key}"
        f"?X-Amz-Expires={expires}"
        f"&X-Amz-Credential={settings.r2_access_key_id}"
        f"&X-Amz-Signature={signature}"
    )
