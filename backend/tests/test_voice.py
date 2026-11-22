import io
import wave
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from threading import Barrier

import httpx
import pytest

from app import llm, voice
from app.db import connect
from .test_assistant import PERSONAL, SHARED, client, desk


def recording() -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as clip:
        clip.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        clip.writeframes(b"\0\0" * 1600)
    return output.getvalue()


@pytest.fixture
def pilot(desk, monkeypatch):
    monkeypatch.setenv("VOICE_PILOT", "on")
    monkeypatch.setenv("AUTO_SEND", "off")
    monkeypatch.setenv("AZURE_SPEECH_REGION", "testregion")
    monkeypatch.setenv("AZURE_SPEECH_KEY", "test-only")
    monkeypatch.setenv("AZURE_SPEECH_USD_PER_MILLION_CHARS", "20")
    return desk


def test_voice_fails_closed_when_autonomy_on_or_personal_keys_unconfigured(pilot, monkeypatch):
    assert pilot.get("/api/overview", headers=SHARED).json()["voice"]["transcribe"]
    monkeypatch.setenv("AUTO_SEND", "inquiries")
    assert not pilot.get("/api/overview", headers=SHARED).json()["voice"]["transcribe"]
    assert pilot.post("/api/voice/transcribe", headers=SHARED).status_code == 503
    monkeypatch.setenv("AUTO_SEND", "off")
    monkeypatch.setenv("APP_USERS", '[{"name":"Collision","key":"desk-key","role":"admin"}]')
    assert pilot.post("/api/voice/transcribe", headers=SHARED).status_code == 503
    monkeypatch.delenv("APP_USERS")
    assert pilot.post("/api/voice/transcribe", headers=SHARED).status_code == 503


@pytest.mark.parametrize("code", ["en", "de", "zh-cn", "pl", "ko", None])
def test_transcription_language_usage_and_audit(pilot, monkeypatch, tmp_path, code):
    class SpeechProvider:
        def post(self, path, **kwargs):
            assert path == "/audio/transcriptions"
            assert kwargs["files"]["file"][1] == recording()
            assert kwargs["data"]["languages"] == ["en", "de", "zh", "pl", "ko"]
            return httpx.Response(200, json={"text": "Transcript", "languages": [{"code": code}] if code else []},
                                  request=httpx.Request("POST", "https://example.invalid"))

    monkeypatch.setattr(llm, "client", SpeechProvider)
    headers = {**PERSONAL, "Content-Type": "audio/wav"}
    result = pilot.post("/api/voice/transcribe", headers=headers, content=recording())
    assert result.status_code == 200
    assert result.headers["cache-control"] == "no-store"
    assert result.json() == {"text": "Transcript", "language": code.split("-")[0] if code else None}
    with closing(connect(tmp_path / "state.sqlite")) as conn:
        entry = conn.execute("SELECT purpose, cost_usd FROM llm_usage").fetchone()
        assert entry["purpose"] == "voice:transcribe"
        assert entry["cost_usd"] == pytest.approx(0.1 * 0.0045 / 60)
        entry = conn.execute("SELECT actor, detail FROM audit").fetchone()
        assert tuple(entry) == ("Alice", None)


def test_invalid_audio_never_calls_provider(pilot, monkeypatch):
    monkeypatch.setattr(llm, "client", lambda: pytest.fail("provider called"))
    headers = {**PERSONAL, "Content-Type": "audio/wav"}
    assert pilot.post("/api/voice/transcribe", content=recording()).status_code == 401
    assert pilot.post("/api/voice/transcribe", headers=PERSONAL, content=b"x").status_code == 415
    assert pilot.post("/api/voice/transcribe", headers=headers, content=b"x").status_code == 422
    assert pilot.post("/api/voice/transcribe", headers=headers, content=b"x" * (voice.MAX_AUDIO_BYTES + 1)).status_code == 413


@pytest.mark.parametrize("language", sorted(voice.VOICES))
def test_only_owned_answers_can_be_synthesized(pilot, monkeypatch, language):
    monkeypatch.setattr(llm, "assistant_chat", lambda *args: {"content": "Test & <data>"})

    def provider(url, **kwargs):
        assert url.startswith("https://testregion.")
        assert f'xml:lang="{voice.VOICES[language][0]}"'.encode() in kwargs["content"]
        assert b"Test &amp; &lt;data&gt;" in kwargs["content"]
        return httpx.Response(200, content=b"mp3", request=httpx.Request("POST", url))

    monkeypatch.setattr(voice.httpx, "post", provider)
    answer = pilot.post("/api/assistant/turn", headers=PERSONAL,
                        json={"message": "What's the status?", "language": language}).json()
    data = {"conversation_id": answer["conversation_id"], "answer_id": answer["answer_id"], "language": language}
    assert pilot.post("/api/voice/speak", headers=SHARED, json=data).status_code == 404
    assert pilot.post("/api/voice/speak", headers=PERSONAL, json={**data, "text": "arbitrary"}).status_code == 422
    response = pilot.post("/api/voice/speak", headers=PERSONAL, json=data)
    assert response.content == b"mp3"
    assert response.headers["content-type"] == "audio/mpeg"


def test_budget_reservations_are_atomic(tmp_path):
    path = tmp_path / "atomic.sqlite"
    with closing(connect(path)):
        pass
    ready = Barrier(2)

    def request():
        with closing(connect(path)) as conn:
            ready.wait(timeout=5)
            try:
                return llm.reserve_usage(conn, "voice:speak", "voice", 0.7, 1)
            except llm.BudgetExceeded:
                return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(lambda _: request(), range(2)))
    assert sum(value is not None for value in outcomes) == 1
    with closing(connect(path)) as conn:
        llm.settle_usage(conn, next(value for value in outcomes if value), 0.1)
        assert llm.reserve_usage(conn, "voice:transcribe", "speech", 0.7, 1)
