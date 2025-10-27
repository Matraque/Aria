import os
import urllib.parse
import requests
from flask import Flask, session, redirect, request, render_template_string, jsonify
from dotenv import load_dotenv
import spotipy
from spotipy.exceptions import SpotifyException
from openai import OpenAI
from flask import render_template

from agent_core import run_agent_for_user




# ========== CONFIG / INIT =====================================================

load_dotenv()

CLIENT_ID     = os.getenv("SPOTIFY_CLIENT_ID")
CLIENT_SECRET = os.getenv("SPOTIFY_CLIENT_SECRET")
BASE_REDIRECT = os.getenv("SPOTIFY_REDIRECT_URI", "http://127.0.0.1:3000")
REDIRECT_URI  = BASE_REDIRECT.rstrip("/") + "/callback"
SCOPE         = "playlist-modify-public playlist-modify-private"

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise SystemExit("⚠️ Manque OPENAI_API_KEY dans .env")

AUTH_URL  = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY_FOR_SESSION", "dev-secret-not-secure")

openai_client = OpenAI(api_key=OPENAI_API_KEY)


# ========== AUTH TOKEN HELPERS ===============================================

def set_session_tokens(access_token: str, refresh_token: str | None = None):
    session["access_token"] = access_token
    if refresh_token:
        session["refresh_token"] = refresh_token


def exchange_code_for_token(code: str):
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI,
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    resp = requests.post(TOKEN_URL, data=data, headers=headers, timeout=30)
    resp.raise_for_status()
    token_json = resp.json()

    access_token  = token_json["access_token"]
    refresh_token = token_json.get("refresh_token")
    set_session_tokens(access_token, refresh_token)


def attempt_refresh_token() -> bool:
    refresh_token = session.get("refresh_token")
    if not refresh_token:
        return False

    data = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    resp = requests.post(TOKEN_URL, data=data, headers=headers, timeout=30)

    if resp.status_code != 200:
        return False

    token_json = resp.json()
    new_access_token  = token_json["access_token"]
    new_refresh_token = token_json.get("refresh_token", refresh_token)
    set_session_tokens(new_access_token, new_refresh_token)
    return True


def build_spotify_client_from_session() -> spotipy.Spotify | None:
    access_token = session.get("access_token")
    if not access_token:
        return None
    return spotipy.Spotify(auth=access_token)


def ensure_valid_spotify_client() -> spotipy.Spotify | None:
    """
    Essaie de rendre un client Spotify valide.
    Si le token est expiré, tente un refresh. Si ça échoue, wipe les tokens.
    """
    sp = build_spotify_client_from_session()
    if sp is None:
        return None

    try:
        sp.current_user()
        return sp
    except SpotifyException as e:
        if e.http_status == 401:
            # token mort -> refresh
            if not attempt_refresh_token():
                session.pop("access_token", None)
                session.pop("refresh_token", None)
                return None

            # token rafraîchi -> re-test
            sp = build_spotify_client_from_session()
            if sp is None:
                return None
            try:
                sp.current_user()
                return sp
            except SpotifyException:
                session.pop("access_token", None)
                session.pop("refresh_token", None)
                return None
        else:
            # autre erreur spotify
            return None


def is_user_actually_connected() -> bool:
    """
    Pour l'UI: on vérifie vraiment si on peut parler à l'API Spotify.
    On NE modifie pas la session dans cette fonction (pas de refresh).
    """
    access_token = session.get("access_token")
    if not access_token:
        return False
    try:
        sp = spotipy.Spotify(auth=access_token)
        sp.current_user()
        return True
    except SpotifyException:
        return False



def start_spotify_oauth_flow():
    params = {
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPE,
        "show_dialog": "true",
    }
    url = AUTH_URL + "?" + urllib.parse.urlencode(params)
    return redirect(url)


# ========== ROUTES ============================================================

@app.get("/")
def index():
    pending_prompt = session.get("pending_prompt", "")
    result = session.pop("last_result", None)  # récupère et supprime

    return render_template(
        "home.html",
        connected=is_user_actually_connected(),
        result=result,
        pending_prompt=pending_prompt,
    )


@app.post("/generate")
def generate():
    prompt = request.form.get("prompt", "").strip()
    if not prompt:
        return "Prompt vide", 400

    session["pending_prompt"] = prompt

    sp = ensure_valid_spotify_client()
    if sp is None:
        return start_spotify_oauth_flow()

    agent_result = run_agent_for_user(
        user_prompt=prompt,
        sp=sp,
        openai_client=openai_client,
    )

    session["pending_prompt"] = ""

    return render_template("home.html", connected=is_user_actually_connected(), result=agent_result)

@app.post("/generate_async")
def generate_async():
    """
    Version fetch/AJAX : renvoie juste des données JSON.
    Le frontend mettra à jour l'UI sans recharger la page.
    """
    prompt = request.form.get("prompt", "").strip()
    if not prompt:
        return jsonify({"error": "Prompt vide"}), 400

    session["pending_prompt"] = prompt

    sp = ensure_valid_spotify_client()
    if sp is None:
        # Si l'utilisateur n'est pas encore auth Spotify,
        # on démarre le flow OAuth comme avant.
        # MAIS côté front on doit gérer cette redirection.
        auth_url = start_spotify_oauth_flow().location
        return jsonify({
            "need_auth": True,
            "auth_url": auth_url
        }), 401

    agent_result = run_agent_for_user(
        user_prompt=prompt,
        sp=sp,
        openai_client=openai_client,
    )
    # agent_result = {
    #   "summary": "...",
    #   "playlist_url": "https://open.spotify.com/playlist/...",
    #   "playlist_name": "..."
    # }

    session["pending_prompt"] = ""

    return jsonify(agent_result), 200


@app.get("/callback")
def callback():
    code = request.args.get("code")
    if not code:
        return "Missing 'code' from Spotify", 400

    # 1. on récupère le token Spotify et on le met en session
    exchange_code_for_token(code)

    # 2. on rend une page qui :
    #    - montre l’overlay Aria
    #    - déclenche la génération côté serveur via /finish_generation
    #    - puis redirige vers "/"
    return render_template("after_auth_loading.html")

@app.post("/finish_generation")
def finish_generation():
    """
    Appelé automatiquement par after_auth_loading.html juste après l'OAuth.
    - On récupère le prompt en attente.
    - On génère la playlist avec le LLM.
    - On stocke le résultat dans la session.
    - On renvoie un petit JSON de succès.
    """
    prompt = session.get("pending_prompt", "").strip()
    if not prompt:
        return jsonify({"error": "no_prompt"}), 400

    sp = ensure_valid_spotify_client()
    if sp is None:
        return jsonify({"error": "no_spotify_client"}), 401

    agent_result = run_agent_for_user(
        user_prompt=prompt,
        sp=sp,
        openai_client=openai_client,
    )
    # agent_result = { "summary": "...", "playlist_url": "...", "playlist_name": "..." }

    # on vide le pending_prompt pour ne pas le réutiliser ensuite
    session["pending_prompt"] = ""

    # on sauvegarde le résultat final pour l'afficher sur la home après redirection
    session["last_result"] = agent_result

    return jsonify({"ok": True}), 200

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=3000, debug=True)