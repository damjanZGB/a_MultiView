"""Authentication blueprint."""

from __future__ import annotations

import secrets
import time

from flask import Blueprint, Response, flash, redirect, render_template, request, session, url_for
from flask_login import current_user, login_required, login_user, logout_user

from app.extensions import db
from app.models import LoginAttempt, User

auth_bp = Blueprint("auth", __name__)

_MAX_ATTEMPTS = 5
_LOCKOUT_SECONDS = 60


def _is_rate_limited(ip: str) -> bool:
    """Return True if the IP has exceeded the login attempt threshold."""
    cutoff = time.time() - _LOCKOUT_SECONDS
    # Clean up old entries
    LoginAttempt.query.filter(LoginAttempt.timestamp < cutoff).delete()
    db.session.commit()
    count = LoginAttempt.query.filter_by(ip=ip).filter(
        LoginAttempt.timestamp >= cutoff
    ).count()
    return count >= _MAX_ATTEMPTS


def _record_failed_attempt(ip: str) -> None:
    db.session.add(LoginAttempt(ip=ip, timestamp=time.time()))
    db.session.commit()


def _clear_attempts(ip: str) -> None:
    LoginAttempt.query.filter_by(ip=ip).delete()
    db.session.commit()


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
            # Regenerate CSRF token for API calls in the authenticated session
            session["csrf_token"] = secrets.token_hex(32)
            # C1 — validate next param is a safe relative URL
            next_page = request.args.get("next", "")
            if not next_page or not next_page.startswith("/") or next_page.startswith("//"):
                next_page = url_for("views.director")
            return redirect(next_page)

        _record_failed_attempt(client_ip)
        flash("Invalid username or password", "error")
        session["csrf_token"] = secrets.token_hex(32)

    return render_template("login.html")


@auth_bp.route("/logout", methods=["GET", "POST"])
def logout() -> Response:
    """Log out the current user."""
    logout_user()
    session.clear()
    return redirect(url_for("auth.login"))
