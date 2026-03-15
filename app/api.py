"""REST API blueprint — streams CRUD, presets, switcher control."""

from __future__ import annotations

import json
import logging
import threading
from typing import Any

from flask import Blueprint, Response, current_app, jsonify, request
from flask_login import current_user, login_required

from app.extensions import db, sock
from app.models import Preset, PresetItem, Stream, SwitcherState

api_bp = Blueprint("api", __name__)
logger = logging.getLogger(__name__)

# ── WebSocket clients for real-time tally ──────────────────────────
_ws_clients: list[Any] = []
_ws_lock = threading.Lock()  # C3 — protect _ws_clients


def _broadcast_state(state: SwitcherState | None = None) -> None:
    """Push current switcher state to all connected WebSocket clients."""
    if state is None:
        state = SwitcherState.get()
    # Resolve to_dict() outside the lock to avoid lazy-load queries under lock
    payload = json.dumps({"type": "switcher_state", "data": state.to_dict()})
    stale: list[Any] = []
    with _ws_lock:
        for ws in _ws_clients:
            try:
                ws.send(payload)
            except Exception:
                stale.append(ws)
        for ws in stale:
            _ws_clients.remove(ws)


@sock.route("/ws/tally")
def tally_ws(ws: Any) -> None:
    """WebSocket endpoint for real-time tally/state updates."""
    # C2 — require authentication
    if not current_user.is_authenticated:
        ws.close()
        return

    with _ws_lock:
        _ws_clients.append(ws)
    try:
        # Send initial state
        state = SwitcherState.get()
        ws.send(json.dumps({"type": "switcher_state", "data": state.to_dict()}))
        # Keep alive — client can send pings
        while True:
            msg = ws.receive(timeout=30)
            if msg is None:
                break
    except Exception:
        logger.exception("WebSocket error in tally_ws")  # H4
    finally:
        with _ws_lock:
            if ws in _ws_clients:
                _ws_clients.remove(ws)


# ── Streams CRUD ───────────────────────────────────────────────────

@api_bp.route("/streams", methods=["GET"])
@login_required
def list_streams() -> Response:
    """List all streams ordered by position."""
    streams = Stream.query.order_by(Stream.position).all()
    return jsonify({"streams": [s.to_dict() for s in streams]}), 200


@api_bp.route("/streams", methods=["POST"])
@login_required
def create_stream() -> Response:
    """Create a new stream source."""
    # M2 — enforce MAX_STREAMS
    if Stream.query.count() >= current_app.config["MAX_STREAMS"]:
        return jsonify({"error": f"Maximum of {current_app.config['MAX_STREAMS']} streams reached"}), 400

    data = request.get_json(silent=True)
    if not data or not data.get("name") or not data.get("url"):
        return jsonify({"error": "name and url are required"}), 400

    # Auto-detect stream type
    url = str(data["url"]).strip()
    stream_type = "youtube" if _is_youtube(url) else "hls"

    # Next position
    max_pos = db.session.query(db.func.max(Stream.position)).scalar() or 0

    stream = Stream(
        name=str(data["name"]).strip(),
        url=url,
        stream_type=stream_type,
        position=data.get("position", max_pos + 1),
        is_active=data.get("is_active", True),
    )
    db.session.add(stream)
    db.session.commit()
    return jsonify(stream.to_dict()), 201


@api_bp.route("/streams/<int:stream_id>", methods=["GET"])
@login_required
def get_stream(stream_id: int) -> Response:
    """Get a single stream."""
    stream = db.session.get(Stream, stream_id)
    if not stream:
        return jsonify({"error": "Not found"}), 404
    return jsonify(stream.to_dict()), 200


@api_bp.route("/streams/<int:stream_id>", methods=["PUT"])
@login_required
def update_stream(stream_id: int) -> Response:
    """Update a stream."""
    stream = db.session.get(Stream, stream_id)
    if not stream:
        return jsonify({"error": "Not found"}), 404

    data = request.get_json(silent=True) or {}
    if "name" in data:
        stream.name = str(data["name"]).strip()
    if "url" in data:
        stream.url = str(data["url"]).strip()
        stream.stream_type = "youtube" if _is_youtube(stream.url) else "hls"
    if "position" in data:
        try:
            stream.position = int(data["position"])
        except (ValueError, TypeError):
            return jsonify({"error": "position must be an integer"}), 400
    if "is_active" in data:
        stream.is_active = bool(data["is_active"])

    db.session.commit()
    _broadcast_state()
    return jsonify(stream.to_dict()), 200


@api_bp.route("/streams/<int:stream_id>", methods=["DELETE"])
@login_required
def delete_stream(stream_id: int) -> Response:
    """Delete a stream."""
    stream = db.session.get(Stream, stream_id)
    if not stream:
        return jsonify({"error": "Not found"}), 404

    # Clear from switcher if active
    state = SwitcherState.get()
    if state.pgm_stream_id == stream_id:
        state.pgm_stream_id = None
    if state.pvw_stream_id == stream_id:
        state.pvw_stream_id = None

    db.session.delete(stream)
    db.session.commit()
    _broadcast_state(state)
    return jsonify({"status": "deleted"}), 200


# ── Switcher Control ───────────────────────────────────────────────

@api_bp.route("/switcher/state", methods=["GET"])
@login_required
def switcher_state() -> Response:
    """Get current PGM/PVW state."""
    state = SwitcherState.get()
    return jsonify(state.to_dict()), 200


def _set_bus(bus: str, stream_id: int | None) -> Response:
    """Set a switcher bus (pgm or pvw) to the given stream. (M7)"""
    if bus not in ("pgm", "pvw"):
        raise ValueError(f"Invalid bus: {bus}")
    state = SwitcherState.get()
    if stream_id is not None:
        stream = db.session.get(Stream, int(stream_id))
        if not stream:
            return jsonify({"error": "Stream not found"}), 404
        setattr(state, f"{bus}_stream_id", stream.id)
    else:
        setattr(state, f"{bus}_stream_id", None)

    db.session.commit()
    _broadcast_state(state)
    return jsonify(state.to_dict()), 200


@api_bp.route("/switcher/pgm", methods=["POST"])
@login_required
def set_pgm() -> Response:
    """Set PGM (program/live) source."""
    data = request.get_json(silent=True) or {}
    return _set_bus("pgm", data.get("stream_id"))


@api_bp.route("/switcher/pvw", methods=["POST"])
@login_required
def set_pvw() -> Response:
    """Set PVW (preview) source."""
    data = request.get_json(silent=True) or {}
    return _set_bus("pvw", data.get("stream_id"))


@api_bp.route("/switcher/cut", methods=["POST"])
@login_required
def switcher_cut() -> Response:
    """CUT — instantly swap PGM and PVW."""
    state = SwitcherState.get()
    state.pgm_stream_id, state.pvw_stream_id = (
        state.pvw_stream_id,
        state.pgm_stream_id,
    )
    db.session.commit()
    _broadcast_state(state)
    return jsonify(state.to_dict()), 200


@api_bp.route("/switcher/auto", methods=["POST"])
@login_required
def switcher_auto() -> Response:
    """AUTO — transition PVW to PGM (client handles visual transition)."""
    state = SwitcherState.get()
    state.pgm_stream_id, state.pvw_stream_id = (
        state.pvw_stream_id,
        state.pgm_stream_id,
    )
    db.session.commit()
    _broadcast_state(state)
    return jsonify({
        **state.to_dict(),
        "transition": "auto",
        "duration": state.transition_duration,
    }), 200


@api_bp.route("/switcher/settings", methods=["GET"])
@login_required
def get_switcher_settings() -> Response:
    """Get switcher settings."""
    state = SwitcherState.get()
    return jsonify({
        "grid_size": state.grid_size,
        "transition_type": state.transition_type,
        "transition_duration": state.transition_duration,
    }), 200


@api_bp.route("/switcher/settings", methods=["PUT"])
@login_required
def update_switcher_settings() -> Response:
    """Update switcher settings."""
    data = request.get_json(silent=True) or {}
    state = SwitcherState.get()

    # L3 — guard int() casts
    if "grid_size" in data:
        try:
            grid = int(data["grid_size"])
        except (ValueError, TypeError):
            return jsonify({"error": "grid_size must be an integer"}), 400
        if grid in (2, 3, 4):
            state.grid_size = grid
    if "transition_type" in data and data["transition_type"] in ("cut", "mix", "dip"):
        state.transition_type = data["transition_type"]
    if "transition_duration" in data:
        try:
            duration = int(data["transition_duration"])
        except (ValueError, TypeError):
            return jsonify({"error": "transition_duration must be an integer"}), 400
        state.transition_duration = max(100, min(5000, duration))

    db.session.commit()
    _broadcast_state(state)
    return jsonify(state.to_dict()), 200


# ── Presets ────────────────────────────────────────────────────────

@api_bp.route("/presets", methods=["GET"])
@login_required
def list_presets() -> Response:
    """List all presets."""
    presets = Preset.query.order_by(Preset.name).all()
    return jsonify({"presets": [p.to_dict() for p in presets]}), 200


@api_bp.route("/presets", methods=["POST"])
@login_required
def create_preset() -> Response:
    """Create a new preset from current stream assignments."""
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    if not name:
        return jsonify({"error": "name is required"}), 400

    if Preset.query.filter_by(name=name).first():
        return jsonify({"error": "Preset already exists"}), 409

    state = SwitcherState.get()
    preset = Preset(
        name=name,
        description=str(data.get("description", "")),
        grid_size=state.grid_size,
    )
    db.session.add(preset)
    db.session.flush()

    # Save stream assignments — M4: validate position field
    items = data.get("items", [])
    for item in items:
        position = item.get("position")
        if position is None:
            db.session.rollback()
            return jsonify({"error": "Each item must include a 'position' field"}), 400
        try:
            position = int(position)
        except (ValueError, TypeError):
            db.session.rollback()
            return jsonify({"error": "'position' must be an integer"}), 400
        pi = PresetItem(
            preset_id=preset.id,
            stream_id=item.get("stream_id"),
            position=position,
        )
        db.session.add(pi)

    db.session.commit()
    return jsonify(preset.to_dict()), 201


@api_bp.route("/presets/<int:preset_id>", methods=["DELETE"])
@login_required
def delete_preset(preset_id: int) -> Response:
    """Delete a preset."""
    preset = db.session.get(Preset, preset_id)
    if not preset:
        return jsonify({"error": "Not found"}), 404
    db.session.delete(preset)
    db.session.commit()
    return jsonify({"status": "deleted"}), 200


@api_bp.route("/presets/<int:preset_id>/load", methods=["POST"])
@login_required
def load_preset(preset_id: int) -> Response:
    """Load a preset into the current multiview."""
    preset = db.session.get(Preset, preset_id)
    if not preset:
        return jsonify({"error": "Not found"}), 404

    state = SwitcherState.get()
    state.grid_size = preset.grid_size
    db.session.commit()
    _broadcast_state(state)

    return jsonify(preset.to_dict()), 200


# ── Helpers ────────────────────────────────────────────────────────

def _is_youtube(url: str) -> bool:
    """Check if a URL is a YouTube link."""
    return any(
        domain in url.lower()
        for domain in ("youtube.com", "youtu.be")
    )
