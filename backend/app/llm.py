"""Thin wrapper around the OpenAI API. Every call is metered, so a run has a price."""

import json
import logging
import os
import time
from contextlib import closing
from datetime import datetime, timezone

import httpx

from app import config  # noqa: F401  (loads .env before the settings below are read)

log = logging.getLogger(__name__)

DEFAULT_MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.4-mini")  # reading: many small calls
AGENT_MODEL = os.environ.get("OPENAI_AGENT_MODEL", "gpt-5.4")   # deciding: few calls that must be right

# USD per million tokens (input, cached input, output), from OpenAI's pricing page on 2026-11-21.
PRICES = {
    "gpt-5.5": (5.00, 0.50, 30.00),
    "gpt-5.4": (2.50, 0.25, 15.00),
    "gpt-5.4-mini": (0.75, 0.075, 4.50),
    "gpt-5.4-nano": (0.20, 0.02, 1.25),
}
_client: httpx.Client | None = None
_key = 0  # which of the configured keys is in use


def keys() -> list[str]:
    return [k for k in (os.environ.get("OPENAI_API_KEY"), os.environ.get("OPENAI_API_KEY_FALLBACK")) if k]


def client() -> httpx.Client:
    global _client
    if _client is None:
        _client = httpx.Client(base_url="https://api.openai.com/v1", timeout=180)
    return _client


def out_of_credit(r: httpx.Response) -> bool:
    return r.status_code == 401 or (r.status_code == 429 and "insufficient_quota" in r.text)


def cost_usd(model: str, usage: dict) -> float | None:
    price = next((p for name, p in sorted(PRICES.items(), key=lambda kv: -len(kv[0])) if model.startswith(name)), None)
    if not price:
        return None
    cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
    fresh = usage.get("prompt_tokens", 0) - cached
    return (fresh * price[0] + cached * price[1] + usage.get("completion_tokens", 0) * price[2]) / 1_000_000


def _meter(purpose: str, model: str, usage: dict) -> None:
    from app.db import connect  # here to avoid a cycle at import time

    try:
        with closing(connect(config.get_settings().db_path)) as conn:
            conn.execute(
                "INSERT INTO llm_usage (ts, purpose, model, input_tokens, cached_tokens, output_tokens, cost_usd) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (datetime.now(timezone.utc).isoformat(timespec="seconds"), purpose, model, usage.get("prompt_tokens", 0),
                 (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0), usage.get("completion_tokens", 0),
                 cost_usd(model, usage)))
            conn.commit()
    except Exception as e:  # metering must never break the work it measures
        log.warning("could not record usage: %s", e)


def _post(body: dict, purpose: str) -> dict:
    global _key
    for attempt in range(4):
        r = client().post("/chat/completions", json=body, headers={"Authorization": f"Bearer {keys()[_key]}"})
        if out_of_credit(r) and _key + 1 < len(keys()):
            _key += 1  # the first key is used up or revoked: carry on with the spare one
            log.warning("switching to the spare API key")
            continue
        if r.status_code in (429, 500, 502, 503, 504) and attempt < 3:
            time.sleep(2 ** attempt)
            continue
        r.raise_for_status()
        data = r.json()
        _meter(purpose, body["model"], data.get("usage") or {})
        return data["choices"][0]["message"]
    raise RuntimeError("unreachable")


def extract(messages: list[dict], name: str, description: str, schema: dict, model: str | None = None,
            purpose: str = "") -> dict:
    """Ask the model to fill `schema`; the answer comes back as a forced tool call."""
    message = _post({
        "model": model or DEFAULT_MODEL,
        "messages": messages,
        "tools": [{"type": "function", "function": {"name": name, "description": description, "parameters": schema}}],
        "tool_choice": {"type": "function", "function": {"name": name}},
    }, purpose or name)
    return json.loads(message["tool_calls"][0]["function"]["arguments"])


def chat(messages: list[dict], tools: list[dict], model: str | None = None, purpose: str = "") -> dict:
    """One turn of a tool-using conversation; returns the assistant message."""
    return _post({"model": model or AGENT_MODEL, "messages": messages, "tools": tools}, purpose or "chat")


class BudgetExceeded(RuntimeError):
    pass


def reserve_usage(conn, purpose: str, model: str, maximum: float, limit: float) -> int:
    """Store a conservative in-flight charge before calling a provider."""
    now = datetime.now(timezone.utc)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat(timespec="seconds")
    conn.execute("BEGIN IMMEDIATE")
    try:
        spent = conn.execute("SELECT COALESCE(SUM(cost_usd), 0) FROM llm_usage WHERE ts >= ?", (start,)).fetchone()[0]
        if spent + maximum > limit:
            raise BudgetExceeded("The daily AI budget has insufficient funds for this request.")
        row = conn.execute(
            "INSERT INTO llm_usage (ts, purpose, model, input_tokens, cached_tokens, output_tokens, cost_usd) "
            "VALUES (?, ?, ?, 0, 0, 0, ?)",
            (now.isoformat(timespec="seconds"), purpose, model, maximum),
        )
        conn.commit()
        return row.lastrowid
    except BaseException:
        conn.rollback()
        raise


def settle_usage(conn, row: int, cost: float, usage: dict | None = None) -> None:
    usage = usage or {}
    conn.execute(
        "UPDATE llm_usage SET cost_usd = ?, input_tokens = ?, cached_tokens = ?, output_tokens = ? WHERE id = ?",
        (cost, usage.get("prompt_tokens", 0), (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0),
         usage.get("completion_tokens", 0), row),
    )
    conn.commit()


def assistant_chat(conn, messages: list[dict], tools: list[dict]) -> dict:
    from app.pipeline import DAILY_BUDGET_USD

    model = DEFAULT_MODEL
    payload = {"model": model, "messages": messages, "max_completion_tokens": 1400}
    if tools:
        payload["tools"] = tools
    prices = next((price for name, price in sorted(PRICES.items(), key=lambda item: -len(item[0]))
                   if model == name or model.startswith(name + "-20")), None)
    if prices is None:
        raise ValueError("Ask Foredock requires a priced OPENAI_MODEL.")
    maximum = ((len(json.dumps(payload).encode()) + 512) * prices[0] + 1400 * prices[2]) / 1_000_000
    row = reserve_usage(conn, "assistant", model, maximum, DAILY_BUDGET_USD)
    result = client().post("/chat/completions", json=payload, headers={"Authorization": f"Bearer {keys()[_key]}"},
                           timeout=25)
    result.raise_for_status()
    data = result.json()
    if data.get("usage"):
        settle_usage(conn, row, cost_usd(model, data["usage"]), data["usage"])
    return data["choices"][0]["message"]
