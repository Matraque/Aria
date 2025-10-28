from __future__ import annotations

import os
from dataclasses import dataclass


class ConfigError(RuntimeError):
    """Raised when mandatory configuration values are missing or invalid."""


@dataclass(frozen=True)
class SpotifySettings:
    client_id: str
    client_secret: str
    base_redirect_uri: str
    scope: str = "playlist-modify-public playlist-modify-private"

    @property
    def redirect_uri(self) -> str:
        return self.base_redirect_uri.rstrip("/") + "/callback"


@dataclass(frozen=True)
class OpenAISettings:
    api_key: str
    model: str = "gpt-5-mini"


@dataclass(frozen=True)
class AppConfig:
    secret_key: str
    spotify: SpotifySettings
    openai: OpenAISettings


def load_config() -> AppConfig:
    missing = []

    client_id = os.getenv("SPOTIFY_CLIENT_ID")
    if not client_id:
        missing.append("SPOTIFY_CLIENT_ID")

    client_secret = os.getenv("SPOTIFY_CLIENT_SECRET")
    if not client_secret:
        missing.append("SPOTIFY_CLIENT_SECRET")

    openai_key = os.getenv("OPENAI_API_KEY")
    if not openai_key:
        missing.append("OPENAI_API_KEY")

    if missing:
        raise ConfigError(f"Missing environment variables: {', '.join(missing)}")

    base_redirect = os.getenv("SPOTIFY_REDIRECT_URI", "http://127.0.0.1:3000")
    secret_key = os.getenv("SECRET_KEY_FOR_SESSION", "dev-secret-not-secure")
    openai_model = os.getenv("OPENAI_MODEL", "gpt-5-mini")

    spotify_cfg = SpotifySettings(
        client_id=client_id,
        client_secret=client_secret,
        base_redirect_uri=base_redirect,
    )
    openai_cfg = OpenAISettings(api_key=openai_key, model=openai_model)

    return AppConfig(
        secret_key=secret_key,
        spotify=spotify_cfg,
        openai=openai_cfg,
    )

