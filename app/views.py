"""Page view routes."""

from __future__ import annotations

import secrets

from flask import Blueprint, Response, render_template, session
from flask_login import login_required

views_bp = Blueprint("views", __name__)


@views_bp.before_request
def _ensure_csrf_token() -> None:
    """Ensure a CSRF token exists in the session for every page view."""
    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_hex(32)


@views_bp.route("/")
@login_required
def director() -> Response:
    """Main director monitor page."""
    return render_template("director.html")


@views_bp.route("/settings")
@login_required
def settings() -> Response:
    """Settings page."""
    return render_template("settings.html")
