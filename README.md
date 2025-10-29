# Prompt to Playlist

Generate Spotify playlists from free-form prompts.

## Features
- Spotify OAuth flow with automatic token refresh.
- Playlist generation powered by OpenAI with function calling.
- Modern single-page UI with dynamic loading overlay.
- Modular Flask application factory suitable for WSGI/ASGI deployment.

## Getting Started
1. **Install dependencies**
   ```bash
   python -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
2. **Configure environment**
   - Copy `.env.example` to `.env`.
   - Fill in Spotify and OpenAI credentials.
   - Update `SPOTIFY_REDIRECT_URI` to match your domain (e.g. `https://your-app.com`).
3. **Run locally**
   ```bash
   flask --app app run --host 127.0.0.1 --port 3000 --debug
   ```
