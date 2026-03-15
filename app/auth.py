"""Authentication blueprint."""

from __future__ import annotations

import secrets
import time
import threading

from flask import Blueprint, Response, flash, redirect, render_template, request, session, url_for
from flask_login import current_user, login_required, login_user, logout_user

from app.models import User

auth_bp = Blueprint("auth", __name__)

# ── Rate limiting (H2) ───────────────────────────────────────────
_login_attempts: dict[str, tuple[int, float]] = {}
_login_lock = threading.Lock()
_MAX_ATTEMPTS = 5
_LOCKOUT_SECONDS = 60


def _is_rate_limited(ip: str) -> bool:
    """Return True if the IP has exceeded the login attempt threshold."""
    with _login_lock:
        attempts, last_time = _login_attempts.get(ip, (0, 0.0))
        if attempts >= _MAX_ATTEMPTS and (time.monotonic() - last_time) < _LOCKOUT_SECONDS:
            return True
        if (time.monotonic() - last_time) >= _LOCKOUT_SECONDS:
            _login_attempts.pop(ip, None)
        return False


def _record_failed_attempt(ip: str) -> None:
    with _login_lock:
        attempts, _ = _login_attempts.get(ip, (0, 0.0))
        _login_attempts[ip] = (attempts + 1, time.monotonic())


def _clear_attempts(ip: str) -> None:
    with _login_lock:
        _login_attempts.pop(ip, None)


@auth_bp.route("/login", methods=["GET", "POST"])
def login() -> Response:
    """Handle login page and form submission."""
    if current_user.is_authenticated:
        return redirect(url_for("views.director"))

    if request.method == "GET":
        # M5 — generate CSRF token for the form
        session["csrf_token"] = secrets.token_hex(32)

    if request.method == "POST":
        # M5 — validate CSRF token
        token = request.form.get("csrf_token", "")
        if not token or token != session.pop("csrf_token", None):
            flash("Invalid form submission", "error")
            session["csrf_token"] = secrets.token_hex(32)
            return render_template("login.html")

        # H2 — rate limiting
        client_ip = request.remote_addr or "unknown"
        if _is_rate_limited(client_ip):
            flash("Too many failed attempts. Please wait and try again.", "error")
            session["csrf_token"] = secrets.token_hex(32)
            return render_template("login.html")

        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        user = User.query.filter_by(username=username).first()

        if user and user.check_password(password):
            _clear_attempts(client_ip)
            login_user(user, remember=True)
            # C1 — validate next param is a safe relative URL
            next_page = request.args.get("next", "")
            if not next_page or not next_page.startswith("/") or next_page.startswith("//"):
                next_page = url_for("views.director")
            return redirect(next_page)

        _record_failed_attempt(client_ip)
        flash("Invalid username or password", "error")
        session["csrf_token"] = secrets.token_hex(32)

    return render_template("login.html")


@auth_bp.route("/logout")
@login_required
def logout() -> Response:
    """Log out the current user."""
    logout_user()
    return redirect(url_for("auth.login"))
