"""Page view routes."""

from __future__ import annotations

from flask import Blueprint, Response, render_template
from flask_login import login_required

views_bp = Blueprint("views", __name__)


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
