from __future__ import annotations

from typing import Any, Dict

from flask import (
    Blueprint,
    Response,
    current_app,
    jsonify,
    redirect,
    render_template,
    request,
    session,
)

from ..agent import run_agent_for_user
from ..config import AppConfig
from ..services import spotify as spotify_service

bp = Blueprint("main", __name__)


@bp.get("/")
def index() -> str:
    pending_prompt = session.get("pending_prompt", "")
    result = session.pop("last_result", None)

    return render_template(
        "home.html",
        connected=spotify_service.is_user_authenticated(session),
        result=result,
        pending_prompt=pending_prompt,
    )


@bp.post("/generate")
def generate() -> str | Response:
    prompt = request.form.get("prompt", "").strip()
    if not prompt:
        return "Prompt vide", 400

    session["pending_prompt"] = prompt

    spotify_client = _ensure_spotify_client()
    if spotify_client is None:
        return _start_spotify_oauth_flow()

    agent_result = run_agent_for_user(
        user_prompt=prompt,
        sp=spotify_client,
        openai_client=_get_openai_client(),
        model_name=_get_app_config().openai.model,
    )

    session["pending_prompt"] = ""

    return render_template(
        "home.html",
        connected=spotify_service.is_user_authenticated(session),
        result=agent_result,
    )


@bp.post("/generate_async")
def generate_async() -> Response:
    prompt = request.form.get("prompt", "").strip()
    if not prompt:
        return jsonify({"error": "Prompt vide"}), 400

    session["pending_prompt"] = prompt

    spotify_client = _ensure_spotify_client()
    if spotify_client is None:
        auth_url = spotify_service.build_authorize_url(_get_app_config().spotify)
        return jsonify({"need_auth": True, "auth_url": auth_url}), 401

    agent_result = run_agent_for_user(
        user_prompt=prompt,
        sp=spotify_client,
        openai_client=_get_openai_client(),
        model_name=_get_app_config().openai.model,
    )

    session["pending_prompt"] = ""

    return jsonify(agent_result), 200


@bp.get("/callback")
def callback() -> str | Response:
    code = request.args.get("code")
    if not code:
        return "Missing 'code' from Spotify", 400

    spotify_service.exchange_code_for_token(
        code=code,
        session_store=session,
        settings=_get_app_config().spotify,
    )

    return render_template("after_auth_loading.html")


@bp.post("/finish_generation")
def finish_generation() -> Response:
    prompt = session.get("pending_prompt", "").strip()
    if not prompt:
        return jsonify({"error": "no_prompt"}), 400

    spotify_client = _ensure_spotify_client()
    if spotify_client is None:
        return jsonify({"error": "no_spotify_client"}), 401

    agent_result = run_agent_for_user(
        user_prompt=prompt,
        sp=spotify_client,
        openai_client=_get_openai_client(),
        model_name=_get_app_config().openai.model,
    )

    session["pending_prompt"] = ""
    session["last_result"] = agent_result

    return jsonify({"ok": True}), 200


def _ensure_spotify_client():
    return spotify_service.ensure_valid_spotify_client(
        session_store=session,
        settings=_get_app_config().spotify,
    )


def _start_spotify_oauth_flow() -> Response:
    auth_url = spotify_service.build_authorize_url(_get_app_config().spotify)
    return redirect(auth_url)


def _get_openai_client():
    return current_app.extensions["openai_client"]


def _get_app_config() -> AppConfig:
    return current_app.config["APP_CONFIG"]

