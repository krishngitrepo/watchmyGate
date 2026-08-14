"""Configuration safety.

The stub-mode checks are what stop local development from calling real external
services. A blank credential in `.env` must mean "absent", never "empty string" —
otherwise the API cheerfully posts real phone numbers to MSG91 with no auth key.
"""

from __future__ import annotations

import pytest

from app.common.config import Settings

BASE_ENV = {
    "database_url": "postgresql+asyncpg://u:p@localhost:5432/db",
    "jwt_secret": "test-secret",
}


def _settings(**overrides: str) -> Settings:
    return Settings(_env_file=None, **BASE_ENV, **overrides)  # type: ignore[arg-type]


def test_blank_credential_is_treated_as_unset() -> None:
    """Regression: `.env.example` ships blanks like `MSG91_AUTH_KEY=`.

    Loaded as `""` these are truthy-not-None, every stub check reports False, and the
    API makes live calls to real providers with empty credentials.
    """
    settings = _settings(msg91_auth_key="", razorpay_key_id="", r2_access_key_id="")

    assert settings.msg91_auth_key is None
    assert settings.sms_is_stubbed is True
    assert settings.payments_are_stubbed is True
    assert settings.storage_is_stubbed is True


def test_whitespace_only_credential_is_also_unset() -> None:
    assert _settings(msg91_auth_key="   ").sms_is_stubbed is True


def test_present_credential_disables_stub_mode() -> None:
    settings = _settings(msg91_auth_key="real-key-value")
    assert settings.sms_is_stubbed is False
    assert settings.msg91_auth_key is not None
    assert settings.msg91_auth_key.get_secret_value() == "real-key-value"


def test_production_rejects_placeholder_jwt_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """A development secret reaching production would make every session forgeable."""
    from app.common import config as config_module

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("JWT_SECRET", "change-me-local-development-only")
    monkeypatch.setenv("DATABASE_URL", BASE_ENV["database_url"])
    monkeypatch.setenv("MSG91_AUTH_KEY", "real-key")
    config_module.get_settings.cache_clear()

    try:
        with pytest.raises(RuntimeError, match="JWT_SECRET"):
            config_module.get_settings()
    finally:
        config_module.get_settings.cache_clear()


def test_production_rejects_stubbed_sms(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub mode in production would silently stop sending login codes to residents."""
    from app.common import config as config_module

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("JWT_SECRET", "a-genuine-production-secret")
    monkeypatch.setenv("DATABASE_URL", BASE_ENV["database_url"])
    monkeypatch.setenv("MSG91_AUTH_KEY", "")
    config_module.get_settings.cache_clear()

    try:
        with pytest.raises(RuntimeError, match="MSG91"):
            config_module.get_settings()
    finally:
        config_module.get_settings.cache_clear()
