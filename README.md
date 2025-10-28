# Prompt to Playlist

Generate curated Spotify playlists from free-form prompts with an OpenAI-powered agent and a production-ready Flask backend.

## Features
- Spotify OAuth flow with automatic token refresh.
- Playlist generation powered by the OpenAI Responses API with tool calling.
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

## Deployment Notes
- The application factory (`aria.create_app`) is compatible with WSGI servers like Gunicorn or uWSGI.
- Ensure HTTPS is enforced in production so Spotify redirects succeed.
- Set `SECRET_KEY_FOR_SESSION` to a strong value and configure persistent session storage if you scale beyond a single instance.
- Configure logging at the platform level; the app defaults to STDOUT.

