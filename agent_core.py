import json
from typing import Any, Dict, List
from openai import OpenAI
import spotipy
from spotipy.exceptions import SpotifyException

# tools_schema charge seulement create_playlist, search_items, add_tracks
with open("tools.json", "r") as f:
    tools_schema = json.load(f)


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
        sp.playlist_add_items(playlist_id=playlist_id, items=uris[:100])
        return {"added": len(uris[:100])}

    def search_items(query: str, item_types: List[str], limit: int) -> Dict[str, Any]:
        type_param = ",".join(item_types)
        results = sp.search(q=query, type=type_param, limit=limit)

        out: Dict[str, Any] = {}

        # tracks
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

        # artists
        if "artists" in results and results["artists"] and "items" in results["artists"]:
            artists_out = []
            for a in results["artists"]["items"]:
                artists_out.append({
                    "id": a["id"],
                    "name": a["name"],
                    "genres": a.get("genres", []),
                })
            out["artists"] = artists_out

        # albums
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
    On renvoie maintenant un dict:
    {
        "summary": <texte final du modèle>,
        "playlist_url": <lien spotify ou "" si pas dispo>,
        "playlist_name": <nom playlist ou "" si pas dispo>
    }
    """

    tool_impls = build_tool_impls(sp)

    # on va capturer la toute première playlist créée par l'IA
    last_playlist_info: Dict[str, Any] | None = None

    # historique qu'on envoie à OpenAI
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
        print(f"\n──────── STEP {step_index} → appel du modèle OpenAI ────────")

        response = openai_client.responses.create(
            model=model_name,
            tools=tools_schema,
            input=input_list,
            temperature=1,
        )

        new_items = list(response.output)

        # on garde trace de ce que le modèle vient de dire/appeler
        input_list += new_items

        function_calls = []
        final_text_chunks = []

        for item in new_items:
            if item.type == "function_call":
                function_calls.append(item)

            elif item.type == "message":
                # texte libre
                if hasattr(item, "content") and item.content:
                    for block in item.content:
                        if block.type == "output_text":
                            final_text_chunks.append(block.text)

        # petit debug console
        if final_text_chunks:
            print("🧠 Modèle (texte candidat) :")
            for chunk in final_text_chunks:
                print("   ", chunk.strip())

        # si plus de tools -> on a fini => on retourne tout ce qu'il faut pour l'UI
        if not function_calls:
            summary_text = "\n".join(final_text_chunks).strip()

            return {
                "summary": summary_text if summary_text else "(aucun texte du modèle)",
                "playlist_url": (last_playlist_info.get("url") if last_playlist_info else ""),
                "playlist_name": (last_playlist_info.get("name") if last_playlist_info else ""),
            }

        # sinon on exécute les tool calls demandés par le modèle
        for fc in function_calls:
            name = fc.name
            raw_args = fc.arguments
            call_id = fc.call_id

            print(f"\n🔧 FUNCTION CALL demandé par le modèle : {name}({raw_args})")

            # parse args safe
            try:
                args = json.loads(raw_args) if raw_args else {}
            except json.JSONDecodeError:
                print("   ↳ ERREUR: JSON invalide envoyé par le modèle")
                args = {}

            # exécuter notre fonction python locale
            if name not in tool_impls:
                print("   ↳ ERREUR: fonction inconnue côté serveur:", name)
                result = {"error": f"unknown function {name}"}
            else:
                try:
                    py_fn = tool_impls[name]
                    result = py_fn(**args)
                    print("   ↳ RESULTAT PYTHON =", result)

                    # si c'était create_playlist on garde l'info pour l'UI ❤️
                    if name == "create_playlist" and isinstance(result, dict):
                        last_playlist_info = result
                        if "url" in result:
                            print(f"   ↳ ✅ Playlist créée pour cet utilisateur : {result['url']}")

                except SpotifyException as e:
                    print("   ↳ EXCEPTION Spotify en exécutant la fonction :", e)
                    result = {
                        "error": "spotify_api_error",
                        "status": getattr(e, "http_status", None),
                        "message": str(e),
                    }
                except Exception as e:
                    print("   ↳ EXCEPTION en exécutant la fonction :", e)
                    result = {"error": str(e)}

            # on répond au modèle avec le "function_call_output"
            input_list.append({
                "type": "function_call_output",
                "call_id": call_id,
                "output": json.dumps(result),
            })