from __future__ import annotations

import logging
from pathlib import Path

from flask import Flask
from dotenv import load_dotenv

from .config import AppConfig, ConfigError, load_config
from .routes.main import bp as main_bp
from .services.openai_client import create_openai_client


def create_app() -> Flask:
    """
    Application factory used by both development and production entry points.
    Loads environment variables, validates configuration, initialises shared services,
    and registers HTTP routes.
    """
    load_dotenv()

    config = _build_config()

    package_root = Path(__file__).resolve().parent
    template_dir = package_root / "templates"
    static_dir = package_root / "static"

    app = Flask(
        __name__,
        template_folder=str(template_dir),
        static_folder=str(static_dir),
    )
    app.config["SECRET_KEY"] = config.secret_key
    app.config["APP_CONFIG"] = config
    app.config.update(
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
    )

    app.extensions["openai_client"] = create_openai_client(config.openai.api_key)

    app.register_blueprint(main_bp)

    _configure_logging(app)

    return app


def _build_config() -> AppConfig:
    try:
        return load_config()
    except ConfigError as exc:  # pragma: no cover - defensive, retained for runtime clarity
        raise SystemExit(f"Configuration error: {exc}") from exc


def _configure_logging(app: Flask) -> None:
    """Ensure the app logger has a sane default when running in production shells."""
    if app.logger.handlers:
        return
    handler = logging.StreamHandler()
    handler.setLevel(logging.INFO)
    app.logger.setLevel(logging.INFO)
    app.logger.addHandler(handler)

