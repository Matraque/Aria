from __future__ import annotations

import logging
import urllib.parse
from typing import Any, MutableMapping, Optional

import requests
import spotipy
from spotipy.exceptions import SpotifyException

from ..config import SpotifySettings

AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"

logger = logging.getLogger(__name__)


def build_authorize_url(settings: SpotifySettings, state: str | None = None) -> str:
    params = {
        "client_id": settings.client_id,
        "response_type": "code",
        "redirect_uri": settings.redirect_uri,
        "scope": settings.scope,
        "show_dialog": "false",
    }
    if state:
        params["state"] = state

    return f"{AUTH_URL}?{urllib.parse.urlencode(params)}"


def set_session_tokens(
    session_store: MutableMapping[str, Any],
    access_token: str,
    refresh_token: str | None = None,
) -> None:
    session_store["access_token"] = access_token
    if refresh_token:
        session_store["refresh_token"] = refresh_token


def clear_session_tokens(session_store: MutableMapping[str, Any]) -> None:
    session_store.pop("access_token", None)
    session_store.pop("refresh_token", None)


def exchange_code_for_token(
    code: str,
    session_store: MutableMapping[str, Any],
    settings: SpotifySettings,
) -> None:
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": settings.redirect_uri,
        "client_id": settings.client_id,
        "client_secret": settings.client_secret,
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    resp = requests.post(TOKEN_URL, data=data, headers=headers, timeout=30)
    resp.raise_for_status()

    token_json = resp.json()
    access_token = token_json["access_token"]
    refresh_token = token_json.get("refresh_token")

    set_session_tokens(session_store, access_token, refresh_token)


def attempt_refresh_token(
    session_store: MutableMapping[str, Any],
    settings: SpotifySettings,
) -> bool:
    refresh_token = session_store.get("refresh_token")
    if not refresh_token:
        return False

    data = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": settings.client_id,
        "client_secret": settings.client_secret,
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    resp = requests.post(TOKEN_URL, data=data, headers=headers, timeout=30)

    if resp.status_code != 200:
        logger.warning("Failed to refresh Spotify token (status=%s)", resp.status_code)
        return False

    token_json = resp.json()
    new_access_token = token_json["access_token"]
    new_refresh_token = token_json.get("refresh_token", refresh_token)

    set_session_tokens(session_store, new_access_token, new_refresh_token)
    return True


def build_spotify_client_from_session(
    session_store: MutableMapping[str, Any],
) -> Optional[spotipy.Spotify]:
    access_token = session_store.get("access_token")
    if not access_token:
        return None
    return spotipy.Spotify(auth=access_token)


def ensure_valid_spotify_client(
    session_store: MutableMapping[str, Any],
    settings: SpotifySettings,
) -> Optional[spotipy.Spotify]:
    """
    Returns a Spotify client if the session contains a valid token.
    Attempts a refresh when needed, otherwise clears the session.
    """
    client = build_spotify_client_from_session(session_store)
    if client is None:
        return None

    try:
        client.current_user()
        return client
    except SpotifyException as exc:
        if exc.http_status != 401:
            raise

        logger.info("Spotify token expired, attempting refresh")
        if not attempt_refresh_token(session_store, settings):
            clear_session_tokens(session_store)
            return None

        refreshed_client = build_spotify_client_from_session(session_store)
        if refreshed_client is None:
            return None

        try:
            refreshed_client.current_user()
            return refreshed_client
        except SpotifyException:
            clear_session_tokens(session_store)
            return None


def is_user_authenticated(session_store: MutableMapping[str, Any]) -> bool:
    return "access_token" in session_store

