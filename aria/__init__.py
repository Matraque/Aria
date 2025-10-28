from __future__ import annotations

import logging
import os
from pathlib import Path

from flask import Flask
from dotenv import load_dotenv
from werkzeug.middleware.proxy_fix import ProxyFix

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
    if os.getenv("FORCE_HTTPS", "1") == "1":
        app.config["SESSION_COOKIE_SECURE"] = True
        app.config["PREFERRED_URL_SCHEME"] = "https"

    if os.getenv("TRUST_PROXY_HEADERS", "1") == "1":
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)  # type: ignore[assignment]

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
        logging.basicConfig(level=logging.INFO)
        logging.getLogger("aria").setLevel(logging.INFO)
        return
    handler = logging.StreamHandler()
    handler.setLevel(logging.INFO)
    app.logger.setLevel(logging.INFO)
    app.logger.addHandler(handler)
    logging.basicConfig(level=logging.INFO)
    logging.getLogger("aria").setLevel(logging.INFO)
