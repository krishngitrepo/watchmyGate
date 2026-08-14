"""Google Secret Manager access.

Used for two kinds of secret:

* Platform secrets injected by Cloud Run at boot (database URL, JWT key). Those arrive
  as environment variables and never come through this module.
* **Per-tenant secrets read at request time** — a flat owner's own payment gateway
  credentials (payments Mode 2) and society pass-signing private keys.

The second kind is the most sensitive data in the system: it is somebody else's money
credential, held on their behalf. The rules are therefore strict.

    - Read into memory for a single request. Never cached, never written to disk.
    - Never logged. Never returned by any endpoint, in any form.
    - Readable back only as a masked suffix; replacement, not retrieval.
    - Every read is audit-logged with actor and reason.
    - Destroyed on offboarding rather than soft-deleted.

Without Google Cloud credentials this falls back to a local in-memory store so the
payment flows are exercisable in development. That fallback refuses to run in
production.
"""

from __future__ import annotations

import structlog

from app.common.config import get_settings
from app.common.errors import ConflictError

log = structlog.get_logger(__name__)

#: Development-only fallback. Never populated in production — see _guard_production.
_LOCAL_STORE: dict[str, str] = {}


def _guard_production() -> None:
    if get_settings().is_production:
        raise ConflictError(
            "Secret Manager is not configured. Refusing to fall back to local storage "
            "for credentials in production."
        )


def mask(value: str) -> str:
    """Safe-to-display remnant of a secret. Never the secret."""
    if len(value) <= 4:
        return "••••"
    return f"••••{value[-4:]}"


async def write_secret(path: str, value: str) -> str:
    """Store a secret and return its reference path.

    The value is never returned again — callers get the reference and, if they need to
    show the user something, `mask()`.
    """
    settings = get_settings()

    if settings.gcp_project_id is None:
        _guard_production()
        _LOCAL_STORE[path] = value
        log.warning("secret_stub_write", path=path, detail="stored in memory, not Secret Manager")
        return path

    from google.cloud import secretmanager

    client = secretmanager.SecretManagerServiceAsyncClient()
    parent = f"projects/{settings.gcp_project_id}"
    secret_id = path.replace("/", "-")

    try:
        await client.create_secret(
            request={
                "parent": parent,
                "secret_id": secret_id,
                "secret": {
                    "replication": {
                        "user_managed": {"replicas": [{"location": settings.gcp_region}]}
                    }
                },
            }
        )
    except Exception:  # noqa: BLE001 — already-exists is the normal path on rotation
        log.info("secret_exists", path=secret_id)

    await client.add_secret_version(
        request={
            "parent": f"{parent}/secrets/{secret_id}",
            "payload": {"data": value.encode()},
        }
    )
    log.info("secret_written", path=secret_id)
    return f"{parent}/secrets/{secret_id}"


async def read_secret(path: str) -> str:
    """Fetch a secret value. In memory only, for the life of one request.

    The returned string must not be logged, cached, stored, or included in a response.
    """
    settings = get_settings()

    if settings.gcp_project_id is None:
        _guard_production()
        value = _LOCAL_STORE.get(path)
        if value is None:
            raise ConflictError("Those payment credentials are not available.")
        return value

    from google.cloud import secretmanager

    client = secretmanager.SecretManagerServiceAsyncClient()
    name = path if path.endswith("/versions/latest") else f"{path}/versions/latest"

    response = await client.access_secret_version(request={"name": name})
    return response.payload.data.decode()


async def destroy_secret(path: str) -> None:
    """Permanently remove a secret. Used on owner offboarding.

    Deletion rather than disabling: once an owner stops using direct payments we should
    no longer hold their gateway credentials at all.
    """
    settings = get_settings()

    if settings.gcp_project_id is None:
        _guard_production()
        _LOCAL_STORE.pop(path, None)
        return

    from google.cloud import secretmanager

    client = secretmanager.SecretManagerServiceAsyncClient()
    await client.delete_secret(request={"name": path})
    log.info("secret_destroyed", path=path)
