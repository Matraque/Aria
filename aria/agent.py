from __future__ import annotations

import json
import logging
import importlib.resources as resources
import unicodedata
from typing import Any, Dict, List

from openai import OpenAI
import spotipy
from spotipy.exceptions import SpotifyException

logger = logging.getLogger(__name__)


def _load_tools_schema() -> List[Dict[str, Any]]:
    with resources.files("aria.data").joinpath("tools.json").open("r", encoding="utf-8") as fp:
        return json.load(fp)


tools_schema = _load_tools_schema()


def _strip_control_chars(value: str) -> str:
    """
    Remove ASCII control characters that can break downstream APIs (e.g. Spotify rejecting NUL bytes).
    NFC normalisation avoids weird accent encodings when coming from the model.
    """
    if not value:
        return value
    normalised = unicodedata.normalize("NFC", value)
    cleaned = "".join(ch for ch in normalised if ch >= " " or ch in "\n\r\t")
    if cleaned != value:
        logger.debug("Sanitised string from %r to %r", value, cleaned)
    return cleaned


def _sanitise_arguments(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {key: _sanitise_arguments(val) for key, val in obj.items()}
    if isinstance(obj, list):
        return [_sanitise_arguments(item) for item in obj]
    if isinstance(obj, str):
        return _strip_control_chars(obj)
    return obj


def build_tool_impls(sp: spotipy.Spotify) -> Dict[str, Any]:
    me = sp.current_user()
    user_id = me["id"]

    def create_playlist(name: str, description: str, public: bool) -> Dict[str, Any]:
        playlist = sp.user_playlist_create(
            user=user_id,
            name=name[:100],
            public=public,
            description=description[:300],
        )
        return {
            "id": playlist["id"],
            "url": playlist["external_urls"]["spotify"],
            "name": playlist["name"],
            "description": playlist.get("description", ""),
        }

    def add_tracks(playlist_id: str, uris: List[str]) -> Dict[str, Any]:
        if not uris:
            return {"added": 0}
        limited = uris[:100]
        sp.playlist_add_items(playlist_id=playlist_id, items=limited)
        return {"added": len(limited)}

    def search_items(query: str, item_types: List[str], limit: int) -> Dict[str, Any]:
        type_param = ",".join(item_types)
        results = sp.search(q=query, type=type_param, limit=limit)

        out: Dict[str, Any] = {}

        if "tracks" in results and results["tracks"] and "items" in results["tracks"]:
            tracks_out = []
            for t in results["tracks"]["items"]:
                tracks_out.append({
                    "id": t["id"],
                    "uri": t["uri"],
                    "name": t["name"],
                    "artists": ", ".join(a["name"] for a in t.get("artists", [])),
                })
            out["tracks"] = tracks_out

        if "artists" in results and results["artists"] and "items" in results["artists"]:
            artists_out = []
            for a in results["artists"]["items"]:
                artists_out.append({
                    "id": a["id"],
                    "name": a["name"],
                    "genres": a.get("genres", []),
                })
            out["artists"] = artists_out

        if "albums" in results and results["albums"] and "items" in results["albums"]:
            albums_out = []
            for al in results["albums"]["items"]:
                albums_out.append({
                    "id": al["id"],
                    "name": al["name"],
                    "artists": ", ".join(a["name"] for a in al.get("artists", [])),
                })
            out["albums"] = albums_out

        return out

    return {
        "create_playlist": create_playlist,
        "add_tracks": add_tracks,
        "search_items": search_items,
    }


def run_agent_for_user(
    user_prompt: str,
    sp: spotipy.Spotify,
    openai_client: OpenAI,
    model_name: str = "gpt-5-mini",
) -> Dict[str, str]:
    """
    Generates a playlist via OpenAI tool calling and returns a summary payload:
    {
        "summary": "...",
        "playlist_url": "...",
        "playlist_name": "..."
    }
    """

    tool_impls = build_tool_impls(sp)
    last_playlist_info: Dict[str, Any] | None = None

    input_list: list[Dict[str, Any]] = [
        {
            "role": "system",
            "content": (
                "Tu es Aria, un assistant musical qui crée des playlists Spotify à partir d'une requête utilisateur.\n"
                "1. Créer la playlist Spotify (appelle create_playlist UNE seule fois au début avec public=true).\n"
                "2. Construire une sélection cohérente avec la requête utilisateur (~15 à ~20 titres max) et ajouter ces titres dans la playlist via add_tracks.\n"
                "3. Finir en répondant dans la langue de la requête avec :\n"
                "   - le nom de la playlist\n"
                "   - une courte description d'ambiance / scénario\n"
                "Comment trouver les bons titres :\n"
                "- Utilise search_items pour rechercher des tracks, artistes ou genres.\n"
                "- Récupère les URIs des tracks pertinents.\n"
                "- Appelle add_tracks avec toutes les URIs quand tu es prêt.\n"
            ),
        },
        {
            "role": "user",
            "content": user_prompt,
        },
    ]

    step_index = 0

    while True:
        step_index += 1
        logger.info("Starting agent step %s", step_index)

        response = openai_client.responses.create(
            model=model_name,
            tools=tools_schema,
            input=input_list,
            temperature=1,
        )

        new_items = list(response.output)
        input_list += new_items

        function_calls = []
        final_text_chunks = []

        for item in new_items:
            if item.type == "function_call":
                function_calls.append(item)
            elif item.type == "message" and getattr(item, "content", None):
                for block in item.content:
                    if block.type == "output_text":
                        final_text_chunks.append(block.text)

        if final_text_chunks:
            logger.debug("Model candidate response: %s", " ".join(chunk.strip() for chunk in final_text_chunks))

        if not function_calls:
            summary_text = "\n".join(final_text_chunks).strip()
            return {
                "summary": summary_text if summary_text else "(aucun texte du modèle)",
                "playlist_url": (last_playlist_info.get("url") if last_playlist_info else ""),
                "playlist_name": (last_playlist_info.get("name") if last_playlist_info else ""),
            }

        for fc in function_calls:
            name = fc.name
            raw_args = fc.arguments
            call_id = fc.call_id

            logger.debug("Executing tool call '%s' with payload: %s", name, raw_args)

            try:
                args = json.loads(raw_args) if raw_args else {}
                args = _sanitise_arguments(args)
            except json.JSONDecodeError:
                logger.exception("Invalid JSON payload received from model")
                args = {}

            if name not in tool_impls:
                logger.error("Unknown tool requested by model: %s", name)
                result = {"error": f"unknown function {name}"}
            else:
        try:
            py_fn = tool_impls[name]
            result = py_fn(**args)
                    if name == "create_playlist" and isinstance(result, dict):
                        last_playlist_info = result
                        playlist_url = result.get("url")
                        if playlist_url:
                            logger.info("Created playlist at %s", playlist_url)
                except SpotifyException as exc:
                    logger.exception("Spotify API error while executing tool '%s'", name)
                    result = {
                        "error": "spotify_api_error",
                        "status": getattr(exc, "http_status", None),
                        "message": str(exc),
                    }
                except Exception as exc:  # pragma: no cover - defensive
                    logger.exception("Unexpected error while executing tool '%s'", name)
                    result = {"error": str(exc)}

            input_list.append({
                "type": "function_call_output",
                "call_id": call_id,
                "output": json.dumps(result),
            })
