from __future__ import annotations

from openai import OpenAI


def create_openai_client(api_key: str) -> OpenAI:
    """Create a configured OpenAI client."""
    return OpenAI(api_key=api_key)

