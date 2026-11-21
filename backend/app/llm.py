"""Thin wrapper around the OpenAI API for calls that must return structured data."""

import json
import os
import time

import httpx

from app import config  # noqa: F401  (loads .env before the settings below are read)

DEFAULT_MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.4-mini")
_client: httpx.Client | None = None


def client() -> httpx.Client:
    global _client
    if _client is None:
        _client = httpx.Client(
            base_url="https://api.openai.com/v1",
            headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
            timeout=180,
        )
    return _client


def extract(messages: list[dict], name: str, description: str, schema: dict, model: str | None = None) -> dict:
    """Ask the model to fill `schema`; the answer comes back as a forced tool call."""
    body = {
        "model": model or DEFAULT_MODEL,
        "messages": messages,
        "tools": [{"type": "function", "function": {"name": name, "description": description, "parameters": schema}}],
        "tool_choice": {"type": "function", "function": {"name": name}},
    }
    for attempt in range(4):
        r = client().post("/chat/completions", json=body)
        if r.status_code in (429, 500, 502, 503, 504) and attempt < 3:
            time.sleep(2 ** attempt)
            continue
        r.raise_for_status()
        return json.loads(r.json()["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"])
    raise RuntimeError("unreachable")


AGENT_MODEL = os.environ.get("OPENAI_AGENT_MODEL", "gpt-5.5")


def chat(messages: list[dict], tools: list[dict], model: str | None = None) -> dict:
    """One turn of a tool-using conversation; returns the assistant message."""
    body = {"model": model or AGENT_MODEL, "messages": messages, "tools": tools}
    for attempt in range(4):
        r = client().post("/chat/completions", json=body)
        if r.status_code in (429, 500, 502, 503, 504) and attempt < 3:
            time.sleep(2 ** attempt)
            continue
        r.raise_for_status()
        return r.json()["choices"][0]["message"]
    raise RuntimeError("unreachable")
