import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")


@dataclass(frozen=True)
class Settings:
    portal_url: str
    portal_token: str
    data_dir: Path
    db_path: Path


def get_settings() -> Settings:
    data_dir = Path(os.environ.get("DATA_DIR", ROOT / "data"))
    return Settings(
        portal_url=os.environ["SOONY_PORTAL_URL"].rstrip("/"),
        portal_token=os.environ["SOONY_API_TOKEN"],
        data_dir=data_dir,
        db_path=Path(os.environ.get("DB_PATH", data_dir / "state.sqlite")),
    )
