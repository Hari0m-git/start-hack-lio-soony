"""Bounded, transient audio transport for the employee voice pilot."""
import io
import math
import os
import wave
from xml.sax.saxutils import escape

import httpx
from pydantic import BaseModel, ConfigDict, Field

from app import autonomy, llm
from app.assistant import Language
from app.config import Settings
from app.pipeline import DAILY_BUDGET_USD

STT_MODEL = "gpt-transcribe"
TTS_MODEL = os.environ.get("OPENAI_TTS_MODEL", "gpt-4o-mini-tts")
TTS_VOICE = os.environ.get("OPENAI_TTS_VOICE", "alloy")
OPENAI_SPEECH_USD_PER_MILLION_CHARS = float(os.environ.get("OPENAI_SPEECH_USD_PER_MILLION_CHARS", "20"))
RATE = 16_000
MAX_SECONDS = 20
MAX_AUDIO_BYTES = RATE * MAX_SECONDS * 2 + 44
MAX_SPEECH_CHARS = 1500
VOICES = {
    "en": ("en-US", "en-US-JennyNeural"),
    "de": ("de-DE", "de-DE-KatjaNeural"),
    "zh": ("zh-CN", "zh-CN-XiaoxiaoNeural"),
    "pl": ("pl-PL", "pl-PL-ZofiaNeural"),
    "ko": ("ko-KR", "ko-KR-SunHiNeural"),
}


class Speak(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conversation_id: str = Field(min_length=1, max_length=40)
    answer_id: str = Field(min_length=1, max_length=40)
    language: Language | None = None


def pilot_enabled(settings: Settings) -> bool:
    keys = [str(user["key"]) for user in settings.users]
    return (os.getenv("VOICE_PILOT", "").lower() == "on" and not autonomy.enabled()
            and bool(keys) and len(set(keys)) == len(keys) and settings.access_key not in keys)


def synthesis_rate() -> float | None:
    try:
        price = float(os.getenv("AZURE_SPEECH_USD_PER_MILLION_CHARS", ""))
    except ValueError:
        return None
    return price if math.isfinite(price) and price > 0 else None


def azure_ready() -> bool:
    return bool(os.getenv("AZURE_SPEECH_KEY") and os.getenv("AZURE_SPEECH_REGION") and synthesis_rate())


def capabilities(settings: Settings) -> dict:
    # Answers are read aloud by Azure where it is configured, otherwise by the OpenAI speech model, which speaks
    # every reply language. Either way the browser does not need a voice installed for that language.
    pilot = pilot_enabled(settings)
    return {"transcribe": pilot and bool(llm.keys()), "speak": pilot and (azure_ready() or bool(llm.keys()))}


def _normalized_wav(audio: bytes) -> tuple[bytes, float]:
    try:
        with wave.open(io.BytesIO(audio), "rb") as source:
            frames = source.getnframes()
            if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, 2, RATE):
                raise ValueError("Record mono 16 kHz PCM audio.")
            if not 1 <= frames <= RATE * MAX_SECONDS:
                raise ValueError("Record up to 20 seconds of audio.")
            samples = source.readframes(frames)
            if len(samples) != frames * 2:
                raise ValueError("The recording is incomplete.")
    except (wave.Error, EOFError) as exc:
        raise ValueError("The recording must be a valid WAV file.") from exc
    clean = io.BytesIO()
    with wave.open(clean, "wb") as target:
        target.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        target.writeframes(samples)
    return clean.getvalue(), frames / RATE


def transcribe(conn, audio: bytes, language: Language | None) -> dict:
    clean, duration = _normalized_wav(audio)
    # Reserve rounded-up duration and charge our locally validated audio length.
    per_second = 0.0045 / 60
    row = llm.reserve_usage(conn, "voice:transcribe", STT_MODEL, math.ceil(duration) * per_second, DAILY_BUDGET_USD)
    result = llm.client().post(
        "/audio/transcriptions", headers={"Authorization": f"Bearer {llm.keys()[0]}"},
        files={"file": ("utterance.wav", clean, "audio/wav")},
        data={"model": STT_MODEL, "languages": [language] if language else list(VOICES)}, timeout=20,
    )
    result.raise_for_status()
    llm.settle_usage(conn, row, duration * per_second)
    data = result.json()
    detected = {item["code"].lower().split("-")[0] for item in data.get("languages") or []}
    supported = {"zh" if code == "cmn" else code for code in detected} & VOICES.keys()
    return {"text": data["text"].strip()[:2000],
            "language": language or (next(iter(supported)) if len(supported) == 1 else None)}


def _speak_openai(conn, text: str) -> bytes:
    """Read the text aloud with the OpenAI speech model. It takes the language from the text itself."""
    spoken = text.replace("*", "").replace("`", "")  # the marks of bold and code are not words
    cost = len(spoken) * OPENAI_SPEECH_USD_PER_MILLION_CHARS / 1_000_000  # an estimate; the provider bills by audio length
    row = llm.reserve_usage(conn, "voice:speak", TTS_MODEL, cost, DAILY_BUDGET_USD)
    result = llm.client().post(
        "/audio/speech", headers={"Authorization": f"Bearer {llm.keys()[0]}"},
        json={"model": TTS_MODEL, "voice": TTS_VOICE, "input": spoken, "response_format": "mp3"}, timeout=40,
    )
    result.raise_for_status()
    llm.settle_usage(conn, row, cost)
    return result.content


def speak(conn, text: str, language: Language | None) -> bytes:
    text = text.strip()
    if len(text) > MAX_SPEECH_CHARS:
        raise ValueError("The answer is too long for playback.")
    if not text or any(ord(char) < 32 and char not in "\n\r\t" for char in text):
        raise ValueError("Enter valid text to play.")
    if not azure_ready():
        return _speak_openai(conn, text)
    if not language:
        raise ValueError("Choose a reply language for playback.")
    locale, voice_name = VOICES[language]
    region = os.environ["AZURE_SPEECH_REGION"]
    if not region.isascii() or not region.isalnum():
        raise ValueError("The synthesis region is invalid.")
    body = (f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="{locale}">'
            f'<voice name="{voice_name}">{escape(text)}</voice></speak>')
    rate = synthesis_rate()
    if rate is None:
        raise ValueError("Configure the synthesis price.")
    cost = sum(2 if ord(char) >= 0x2E80 else 1 for char in text) * rate / 1_000_000
    row = llm.reserve_usage(conn, "voice:speak", voice_name, cost, DAILY_BUDGET_USD)
    result = httpx.post(f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1",
                        headers={"Ocp-Apim-Subscription-Key": os.environ["AZURE_SPEECH_KEY"],
                                 "Content-Type": "application/ssml+xml",
                                 "X-Microsoft-OutputFormat": "audio-16khz-32kbitrate-mono-mp3"},
                        content=body.encode(), timeout=20)
    result.raise_for_status()
    llm.settle_usage(conn, row, cost)
    return result.content
