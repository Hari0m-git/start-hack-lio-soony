import pytest


@pytest.fixture(autouse=True)
def no_local_settings(monkeypatch):
    """Tests must not depend on what the developer's own .env switches on."""
    for name in ("APP_USERS", "APP_ACCESS_KEY", "VOICE_PILOT", "AUTO_SEND", "AGENTS"):
        monkeypatch.delenv(name, raising=False)
