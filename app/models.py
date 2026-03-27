"""Database models."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from flask_login import UserMixin
from werkzeug.security import check_password_hash, generate_password_hash

from app.extensions import db


class User(UserMixin, db.Model):  # type: ignore[name-defined]
    """Application user."""

    __tablename__ = "users"

    id: int = db.Column(db.Integer, primary_key=True)
    username: str = db.Column(db.String(80), unique=True, nullable=False)
    password_hash: str = db.Column(db.String(256), nullable=False)
    role: str = db.Column(db.String(20), default="operator", nullable=False)
    created_at: datetime = db.Column(
        db.DateTime, default=lambda: datetime.now(timezone.utc)
    )

    # Relationships
    streams = db.relationship("Stream", back_populates="owner", cascade="all, delete-orphan")
    presets = db.relationship("Preset", back_populates="owner", cascade="all, delete-orphan")
    switcher_state = db.relationship("SwitcherState", back_populates="owner", uselist=False, cascade="all, delete-orphan")

    def set_password(self, password: str) -> None:
        self.password_hash = generate_password_hash(password)

    def check_password(self, password: str) -> bool:
        return check_password_hash(self.password_hash, password)


class LoginAttempt(db.Model):  # type: ignore[name-defined]
    """Tracks failed login attempts for rate limiting (shared across workers)."""

    __tablename__ = "login_attempts"

    id: int = db.Column(db.Integer, primary_key=True)
    ip: str = db.Column(db.String(45), nullable=False, index=True)
    timestamp: float = db.Column(db.Float, nullable=False)


class Stream(db.Model):  # type: ignore[name-defined]
    """A video source (HLS or YouTube URL), scoped to a user."""

    __tablename__ = "streams"

    id: int = db.Column(db.Integer, primary_key=True)
    user_id: int = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    name: str = db.Column(db.String(120), nullable=False)
    url: str = db.Column(db.String(500), nullable=False)
    stream_type: str = db.Column(db.String(20), default="hls")  # hls | youtube
    position: int = db.Column(db.Integer, default=0, index=True)
    is_active: bool = db.Column(db.Boolean, default=True)
    created_at: datetime = db.Column(
        db.DateTime, default=lambda: datetime.now(timezone.utc)
    )
    updated_at: datetime = db.Column(
        db.DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    owner = db.relationship("User", back_populates="streams")

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "url": self.url,
            "stream_type": self.stream_type,
            "position": self.position,
            "is_active": self.is_active,
        }


class Preset(db.Model):  # type: ignore[name-defined]
    """A saved multiview configuration, scoped to a user."""

    __tablename__ = "presets"

    id: int = db.Column(db.Integer, primary_key=True)
    user_id: int = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    name: str = db.Column(db.String(80), nullable=False)
    description: str = db.Column(db.String(200), default="")
    grid_size: int = db.Column(db.Integer, default=4)
    created_at: datetime = db.Column(
        db.DateTime, default=lambda: datetime.now(timezone.utc)
    )
    items = db.relationship("PresetItem", back_populates="preset", cascade="all, delete-orphan")
    owner = db.relationship("User", back_populates="presets")

    # Unique per user
    __table_args__ = (db.UniqueConstraint("user_id", "name", name="uq_user_preset_name"),)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "grid_size": self.grid_size,
            "items": [item.to_dict() for item in self.items],
        }


class PresetItem(db.Model):  # type: ignore[name-defined]
    """A stream assignment within a preset."""

    __tablename__ = "preset_items"

    id: int = db.Column(db.Integer, primary_key=True)
    preset_id: int = db.Column(db.Integer, db.ForeignKey("presets.id"), nullable=False)
    stream_id: int = db.Column(db.Integer, db.ForeignKey("streams.id"), nullable=True)
    position: int = db.Column(db.Integer, nullable=False)
    preset = db.relationship("Preset", back_populates="items")
    stream = db.relationship("Stream")

    def to_dict(self) -> dict[str, Any]:
        return {
            "position": self.position,
            "stream": self.stream.to_dict() if self.stream else None,
        }


class SwitcherState(db.Model):  # type: ignore[name-defined]
    """Per-user PGM/PVW switcher state."""

    __tablename__ = "switcher_state"

    id: int = db.Column(db.Integer, primary_key=True)
    user_id: int = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, unique=True)
    pgm_stream_id: int | None = db.Column(
        db.Integer, db.ForeignKey("streams.id"), nullable=True
    )
    pvw_stream_id: int | None = db.Column(
        db.Integer, db.ForeignKey("streams.id"), nullable=True
    )
    grid_size: int = db.Column(db.Integer, default=4)
    transition_type: str = db.Column(db.String(20), default="cut")
    transition_duration: int = db.Column(db.Integer, default=500)

    owner = db.relationship("User", back_populates="switcher_state")
    pgm_stream = db.relationship("Stream", foreign_keys=[pgm_stream_id])
    pvw_stream = db.relationship("Stream", foreign_keys=[pvw_stream_id])

    def to_dict(self) -> dict[str, Any]:
        return {
            "pgm": self.pgm_stream.to_dict() if self.pgm_stream else None,
            "pvw": self.pvw_stream.to_dict() if self.pvw_stream else None,
            "grid_size": self.grid_size,
            "transition_type": self.transition_type,
            "transition_duration": self.transition_duration,
        }

    @classmethod
    def get_for_user(cls, user_id: int) -> SwitcherState:
        """Return the state row for a given user, creating if needed."""
        state = cls.query.filter_by(user_id=user_id).first()
        if state is None:
            state = cls(user_id=user_id, grid_size=4)
            db.session.add(state)
            db.session.commit()
        return state
