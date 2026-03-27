"""REST API blueprint — streams CRUD, presets, switcher control (per-user)."""

from __future__ import annotations

import json
import logging
import threading
from typing import Any

from flask import Blueprint, Response, abort, current_app, jsonify, request, session
from flask_login import current_user, login_required

from app.extensions import db, sock
from app.models import Preset, PresetItem, Stream, SwitcherState

api_bp = Blueprint("api", __name__)
logger = logging.getLogger(__name__)


@api_bp.before_request
def _check_csrf() -> Response | None:
    """Validate CSRF token on mutating API requests (after auth)."""
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return None
    if not current_user.is_authenticated:
        return None
    token = request.headers.get("X-CSRF-Token") or ""
    if not token or token != session.get("csrf_token"):
        logger.warning(
            "CSRF rejected: %s %s", request.method, request.path,
        )
        return jsonify({"error": "CSRF token missing or invalid"}), 403
    return None

# ── WebSocket clients for real-time tally (per-user) ──────────────
# Maps user_id → list of ws connections
_ws_clients: dict[int, list[Any]] = {}
_ws_lock = threading.Lock()


def _broadcast_state(user_id: int, state: SwitcherState | None = None) -> None:
    """Push current switcher state to all WebSocket clients of a given user."""
    if state is None:
        state = SwitcherState.get_for_user(user_id)
    payload = json.dumps({"type": "switcher_state", "data": state.to_dict()})
    with _ws_lock:
        clients = _ws_clients.get(user_id, [])
        alive: list[Any] = []
        for ws in clients:
            try:
                ws.send(payload)
                alive.append(ws)
            except Exception:
                pass
        _ws_clients[user_id] = alive


@sock.route("/ws/tally")
def tally_ws(ws: Any) -> None:
    """WebSocket endpoint for real-time tally/state updates."""
    if not current_user.is_authenticated:
        ws.close()
        return

    uid = current_user.id
    with _ws_lock:
        _ws_clients.setdefault(uid, []).append(ws)
    try:
        state = SwitcherState.get_for_user(uid)
        ws.send(json.dumps({"type": "switcher_state", "data": state.to_dict()}))
        while True:
            msg = ws.receive(timeout=30)
            if msg is None:
                break
    except (ConnectionError, OSError, Exception) as e:
        if "ConnectionClosed" in type(e).__name__ or isinstance(e, (ConnectionError, OSError)):
            pass
        else:
            logger.exception("Unexpected WebSocket error in tally_ws")
    finally:
        with _ws_lock:
            clients = _ws_clients.get(uid, [])
            if ws in clients:
                clients.remove(ws)


# ── Streams CRUD (per-user) ──────────────────────────────────────

@api_bp.route("/streams", methods=["GET"])
@login_required
def list_streams() -> Response:
    """List current user's streams ordered by position."""
    streams = Stream.query.filter_by(user_id=current_user.id).order_by(Stream.position).all()
    return jsonify({"streams": [s.to_dict() for s in streams]}), 200


@api_bp.route("/streams", methods=["POST"])
@login_required
def create_stream() -> Response:
    """Create a new stream source for current user."""
    count = Stream.query.filter_by(user_id=current_user.id).count()
    if count >= current_app.config["MAX_STREAMS"]:
        return jsonify({"error": f"Maximum of {current_app.config['MAX_STREAMS']} streams reached"}), 400

    data = request.get_json(silent=True)
    if not data or not data.get("name") or not data.get("url"):
        return jsonify({"error": "name and url are required"}), 400

    url = str(data["url"]).strip()
    stream_type = "youtube" if _is_youtube(url) else "hls"

    max_pos = db.session.query(db.func.max(Stream.position)).filter(
        Stream.user_id == current_user.id
    ).scalar() or 0

    stream = Stream(
        user_id=current_user.id,
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
    """Get a single stream (must belong to current user)."""
    stream = db.session.get(Stream, stream_id)
    if not stream or stream.user_id != current_user.id:
        return jsonify({"error": "Not found"}), 404
    return jsonify(stream.to_dict()), 200


@api_bp.route("/streams/<int:stream_id>", methods=["PUT"])
@login_required
def update_stream(stream_id: int) -> Response:
    """Update a stream (must belong to current user)."""
    stream = db.session.get(Stream, stream_id)
    if not stream or stream.user_id != current_user.id:
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
    _broadcast_state(current_user.id)
    return jsonify(stream.to_dict()), 200


@api_bp.route("/streams/<int:stream_id>", methods=["DELETE"])
@login_required
def delete_stream(stream_id: int) -> Response:
    """Delete a stream (must belong to current user)."""
    stream = db.session.get(Stream, stream_id)
    if not stream or stream.user_id != current_user.id:
        return jsonify({"error": "Not found"}), 404

    state = SwitcherState.get_for_user(current_user.id)
    if state.pgm_stream_id == stream_id:
        state.pgm_stream_id = None
    if state.pvw_stream_id == stream_id:
        state.pvw_stream_id = None

    db.session.delete(stream)
    db.session.commit()
    _broadcast_state(current_user.id, state)
    return jsonify({"status": "deleted"}), 200


# ── Switcher Control (per-user) ──────────────────────────────────

@api_bp.route("/switcher/state", methods=["GET"])
@login_required
def switcher_state() -> Response:
    """Get current user's PGM/PVW state."""
    state = SwitcherState.get_for_user(current_user.id)
    return jsonify(state.to_dict()), 200


def _set_bus(bus: str, stream_id: int | None) -> Response:
    """Set a switcher bus (pgm or pvw) to the given stream."""
    state = SwitcherState.get_for_user(current_user.id)
    resolved_id = None
    if stream_id is not None:
        stream = db.session.get(Stream, int(stream_id))
        if not stream or stream.user_id != current_user.id:
            return jsonify({"error": "Stream not found"}), 404
        resolved_id = stream.id

    if bus == "pgm":
        state.pgm_stream_id = resolved_id
    elif bus == "pvw":
        state.pvw_stream_id = resolved_id
    else:
        return jsonify({"error": "Invalid bus"}), 400

    db.session.commit()
    _broadcast_state(current_user.id, state)
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
    state = SwitcherState.get_for_user(current_user.id)
    state.pgm_stream_id, state.pvw_stream_id = (
        state.pvw_stream_id,
        state.pgm_stream_id,
    )
    db.session.commit()
    _broadcast_state(current_user.id, state)
    return jsonify(state.to_dict()), 200


@api_bp.route("/switcher/auto", methods=["POST"])
@login_required
def switcher_auto() -> Response:
    """AUTO — transition PVW to PGM (client handles visual transition)."""
    state = SwitcherState.get_for_user(current_user.id)
    state.pgm_stream_id, state.pvw_stream_id = (
        state.pvw_stream_id,
        state.pgm_stream_id,
    )
    db.session.commit()
    _broadcast_state(current_user.id, state)
    return jsonify({
        **state.to_dict(),
        "transition": "auto",
        "duration": state.transition_duration,
    }), 200


@api_bp.route("/switcher/settings", methods=["GET"])
@login_required
def get_switcher_settings() -> Response:
    """Get current user's switcher settings."""
    state = SwitcherState.get_for_user(current_user.id)
    return jsonify({
        "grid_size": state.grid_size,
        "transition_type": state.transition_type,
        "transition_duration": state.transition_duration,
    }), 200


@api_bp.route("/switcher/settings", methods=["PUT"])
@login_required
def update_switcher_settings() -> Response:
    """Update current user's switcher settings."""
    data = request.get_json(silent=True) or {}
    state = SwitcherState.get_for_user(current_user.id)

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
    _broadcast_state(current_user.id, state)
    return jsonify(state.to_dict()), 200


# ── Presets (per-user) ────────────────────────────────────────────

@api_bp.route("/presets", methods=["GET"])
@login_required
def list_presets() -> Response:
    """List current user's presets."""
    presets = Preset.query.filter_by(user_id=current_user.id).order_by(Preset.name).all()
    return jsonify({"presets": [p.to_dict() for p in presets]}), 200


@api_bp.route("/presets", methods=["POST"])
@login_required
def create_preset() -> Response:
    """Create a new preset from current stream assignments."""
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    if not name:
        return jsonify({"error": "name is required"}), 400

    if Preset.query.filter_by(user_id=current_user.id, name=name).first():
        return jsonify({"error": "Preset already exists"}), 409

    state = SwitcherState.get_for_user(current_user.id)
    preset = Preset(
        user_id=current_user.id,
        name=name,
        description=str(data.get("description", "")),
        grid_size=state.grid_size,
    )
    db.session.add(preset)
    db.session.flush()

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
    """Delete a preset (must belong to current user)."""
    preset = db.session.get(Preset, preset_id)
    if not preset or preset.user_id != current_user.id:
        return jsonify({"error": "Not found"}), 404
    db.session.delete(preset)
    db.session.commit()
    return jsonify({"status": "deleted"}), 200


@api_bp.route("/presets/<int:preset_id>/load", methods=["POST"])
@login_required
def load_preset(preset_id: int) -> Response:
    """Load a preset into the current multiview."""
    preset = db.session.get(Preset, preset_id)
    if not preset or preset.user_id != current_user.id:
        return jsonify({"error": "Not found"}), 404

    state = SwitcherState.get_for_user(current_user.id)
    state.grid_size = preset.grid_size
    db.session.commit()
    _broadcast_state(current_user.id, state)

    return jsonify(preset.to_dict()), 200


# ── Helpers ────────────────────────────────────────────────────────

def _is_youtube(url: str) -> bool:
    """Check if a URL is a YouTube link."""
    return any(
        domain in url.lower()
        for domain in ("youtube.com", "youtu.be")
    )
