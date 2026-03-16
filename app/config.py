"""Application configuration."""

from __future__ import annotations

import os
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent.parent

# Marker value used to detect when SECRET_KEY was not explicitly configured.
_DEFAULT_SECRET = "change-me-in-production"


class Config:
    """Base configuration."""

    SECRET_KEY: str = os.environ.get("SECRET_KEY", _DEFAULT_SECRET)
    SQLALCHEMY_DATABASE_URI: str = os.environ.get(
        "DATABASE_URL",
        f"sqlite:///{BASE_DIR / 'instance' / 'multiview.db'}",
    )
    SQLALCHEMY_TRACK_MODIFICATIONS: bool = False
    PRESETS_DIR: Path = BASE_DIR / "presets"
    DEFAULT_ADMIN_USER: str = os.environ.get("ADMIN_USER", "admin")
    DEFAULT_ADMIN_PASS: str = os.environ.get("ADMIN_PASS", "admin")
    GRID_SIZE_DEFAULT: int = 4
    MAX_STREAMS: int = 16
