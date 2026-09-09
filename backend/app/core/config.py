import logging
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict
from supabase import Client, create_client

log = logging.getLogger("retailmind.config")

# Both spellings of loopback, on the ports Vite uses. A browser that loads the
# page from 127.0.0.1 sends a different Origin than one that loads it from
# localhost, and a missing entry here fails preflight — which surfaces in the
# browser as an indistinguishable "failed to fetch".
DEV_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "RetailMind AI"
    environment: str = "development"

    supabase_url: str
    supabase_anon_key: str
    supabase_service_role_key: str
    supabase_jwt_secret: str

    cors_origins: str = ",".join(DEV_ORIGINS)

    # Cloudflare Turnstile. Secret stays server-side; the site key is public and
    # lives in the frontend env. Leave blank to disable in local development.
    turnstile_secret_key: str = ""

    # Where Supabase sends the browser back after Google sign-in.
    oauth_redirect_url: str = "http://localhost:5173/auth/callback"

    # Where Supabase sends the browser back after an email confirmation link is
    # clicked (the sign-up verification email). Must be allow-listed under
    # Supabase -> Authentication -> URL Configuration -> Redirect URLs. It is
    # deliberately configurable so a production deploy never bakes localhost
    # into verification emails.
    auth_redirect_url: str = "http://localhost:5173/auth/callback"

    # ------------------------------------------------------------ order email
    #
    # Outbound SMTP for the order-notification workflow (a store manager
    # submits an order -> the manager/admin for that store receives an email
    # with an Excel attachment). All placeholders live in backend/.env.example;
    # leave SMTP_HOST blank to disable email entirely (orders still save).
    email_provider: str = "smtp"
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_use_tls: bool = True
    email_from: str = "RetailMind AI <no-reply@retailmind.local>"
    # Comma-separated fallback recipients for order notifications. Used when a
    # store has no notification_email and no admin/inventory-manager profile
    # can be found for it. Never put a real address in .env.example.
    order_notification_emails: str = ""

    @property
    def email_enabled(self) -> bool:
        return bool(self.smtp_host.strip())

    @property
    def order_notification_list(self) -> list[str]:
        return [e.strip() for e in self.order_notification_emails.split(",") if e.strip()]

    @property
    def is_dev(self) -> bool:
        return self.environment.lower() in ("development", "dev", "local")

    @property
    def captcha_enabled(self) -> bool:
        return bool(self.turnstile_secret_key.strip())

    @property
    def cors_list(self) -> list[str]:
        configured = [o.strip().rstrip("/") for o in self.cors_origins.split(",") if o.strip()]
        if self.is_dev:
            # Union, so a hand-edited .env can never lock you out locally.
            return sorted(set(configured) | set(DEV_ORIGINS))
        return configured


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


@lru_cache
def service_client() -> Client:
    """Service-role client. Bypasses RLS — only use behind a verified role check."""
    s = get_settings()
    return create_client(s.supabase_url, s.supabase_service_role_key)


# Buckets the app needs, with the privacy each feature expects.
REQUIRED_BUCKETS = {
    "product-images": {"public": True},
    "imports": {"public": False},
    "website-media": {"public": True},
}


def ensure_storage_buckets() -> None:
    """Create any missing storage buckets at startup.

    A missing bucket used to surface mid-request as "The bucket has not been
    created". The service-role key can create buckets, so the server now fixes
    the gap itself on boot (and the migration 0005 does it idempotently too).
    """
    try:
        svc = service_client()
        existing = {b["id"] for b in svc.storage.list_buckets()}
        for bucket, options in REQUIRED_BUCKETS.items():
            if bucket in existing:
                continue
            try:
                svc.storage.create_bucket(bucket, options=options)
                log.info("Created storage bucket '%s'.", bucket)
            except Exception as exc:
                message = str(exc).lower()
                if "already exists" in message or "duplicate" in message:
                    continue
                log.warning("Couldn't create storage bucket '%s': %s", bucket, exc)
    except Exception as exc:
        log.warning("Couldn't verify storage buckets at startup: %s", exc)


def anon_client() -> Client:
    s = get_settings()
    return create_client(s.supabase_url, s.supabase_anon_key)


def user_client(access_token: str) -> Client:
    """Client acting as the signed-in user, so RLS applies normally."""
    s = get_settings()
    client = create_client(s.supabase_url, s.supabase_anon_key)
    client.postgrest.auth(access_token)
    return client
