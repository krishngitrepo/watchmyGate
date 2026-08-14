"""Application configuration.

All settings come from the environment. In production these are injected from Google
Secret Manager by Cloud Run; nothing sensitive is ever read from a file in the repo.

External integrations degrade to stub mode when their credentials are absent, so the
API runs locally with no cloud accounts at all. See `is_stubbed` on each integration.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import SecretStr, computed_field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["local", "dev", "staging", "production"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    @model_validator(mode="before")
    @classmethod
    def _blank_is_unset(cls, data: object) -> object:
        """Treat an empty environment value as absent.

        `.env.example` ships credentials as blank lines (`MSG91_AUTH_KEY=`). Without
        this, they load as `""` rather than `None`, every `*_is_stubbed` check reports
        False, and the API makes live calls to real external services with empty
        credentials — billing real money and leaking real phone numbers to a provider
        that will reject them. Blank must mean unset.
        """
        if isinstance(data, dict):
            return {
                k: (None if isinstance(v, str) and v.strip() == "" else v) for k, v in data.items()
            }
        return data

    environment: Environment = "local"
    log_level: str = "INFO"

    # --- Database -----------------------------------------------------------
    # DATABASE_URL uses the restricted application role (NOBYPASSRLS).
    # DATABASE_MIGRATION_URL uses the owner role and is only for Alembic.
    database_url: str
    database_migration_url: str = ""
    db_pool_size: int = 10
    db_max_overflow: int = 5
    db_echo: bool = False

    # --- Auth ---------------------------------------------------------------
    jwt_secret: SecretStr
    jwt_algorithm: str = "HS256"
    jwt_access_ttl_minutes: int = 15
    jwt_refresh_ttl_days: int = 30
    otp_ttl_seconds: int = 300
    otp_max_attempts: int = 5
    otp_resend_cooldown_seconds: int = 60

    # --- External services (blank => stub mode) -----------------------------
    msg91_auth_key: SecretStr | None = None
    msg91_sender_id: str | None = None
    msg91_otp_template_id: str | None = None

    razorpay_key_id: str | None = None
    razorpay_key_secret: SecretStr | None = None
    razorpay_webhook_secret: SecretStr | None = None

    r2_account_id: str | None = None
    r2_access_key_id: str | None = None
    r2_secret_access_key: SecretStr | None = None
    r2_bucket: str = "watchmygate"
    r2_public_host: str | None = None

    anthropic_api_key: SecretStr | None = None
    exotel_sid: str | None = None
    exotel_token: SecretStr | None = None
    exotel_caller_id: str | None = None
    fcm_credentials_json: SecretStr | None = None

    # --- Google Cloud (deployment only) -------------------------------------
    gcp_project_id: str | None = None
    gcp_region: str = "asia-southeast1"
    cloud_tasks_queue: str = "approval-ladder"
    worker_base_url: str | None = None
    worker_service_account: str | None = None

    sentry_dsn: str | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @computed_field  # type: ignore[prop-decorator]
    @property
    def sms_is_stubbed(self) -> bool:
        return self.msg91_auth_key is None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def payments_are_stubbed(self) -> bool:
        return self.razorpay_key_id is None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def storage_is_stubbed(self) -> bool:
        return self.r2_access_key_id is None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def push_is_stubbed(self) -> bool:
        return self.fcm_credentials_json is None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def voice_is_stubbed(self) -> bool:
        return self.exotel_sid is None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def tasks_are_stubbed(self) -> bool:
        """Cloud Tasks drives the approval ladder.

        Stubbed, ladder rungs are logged with the delay they would have fired at
        instead of being enqueued, so the flow is exercisable without Google Cloud.
        """
        return self.gcp_project_id is None or self.worker_base_url is None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def ocr_is_stubbed(self) -> bool:
        return self.anthropic_api_key is None

    def migration_url(self) -> str:
        """Owner connection for Alembic, falling back to the app URL locally."""
        return self.database_migration_url or self.database_url


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    settings = Settings()  # type: ignore[call-arg]

    # Fail loudly rather than silently shipping a development secret to production.
    if settings.is_production:
        if settings.jwt_secret.get_secret_value().startswith("change-me"):
            raise RuntimeError("JWT_SECRET is still the development placeholder.")
        if settings.sms_is_stubbed:
            raise RuntimeError(
                "MSG91 credentials are required in production — OTP cannot be stubbed."
            )

    return settings
