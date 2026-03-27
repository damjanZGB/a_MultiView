"""Authentication blueprint."""

from __future__ import annotations

import secrets
import time

from flask import Blueprint, Response, flash, redirect, render_template, request, session, url_for
from flask_login import current_user, login_required, login_user, logout_user

from app.extensions import db
from app.models import LoginAttempt, SwitcherState, User

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
        session["csrf_token"] = secrets.token_hex(32)

    if request.method == "POST":
        # Validate CSRF token
        token = request.form.get("csrf_token", "")
        if not token or token != session.pop("csrf_token", None):
            flash("Invalid form submission", "error")
            session["csrf_token"] = secrets.token_hex(32)
            return render_template("login.html")

        # Rate limiting
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
            # Ensure user has a switcher state row
            SwitcherState.get_for_user(user.id)
            # Validate next param is a safe relative URL
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
    resp = redirect(url_for("auth.login"))
    resp.delete_cookie("session", path="/")
    return resp


@auth_bp.route("/register", methods=["GET", "POST"])
def register() -> Response:
    """Handle user registration."""
    if current_user.is_authenticated:
        return redirect(url_for("views.director"))

    if request.method == "GET":
        session["csrf_token"] = secrets.token_hex(32)

    if request.method == "POST":
        token = request.form.get("csrf_token", "")
        if not token or token != session.pop("csrf_token", None):
            flash("Invalid form submission", "error")
            session["csrf_token"] = secrets.token_hex(32)
            return render_template("register.html")

        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        password_confirm = request.form.get("password_confirm", "")

        if not username or not password:
            flash("Username and password are required", "error")
            session["csrf_token"] = secrets.token_hex(32)
            return render_template("register.html")

        if len(username) < 3 or len(username) > 30:
            flash("Username must be 3-30 characters", "error")
            session["csrf_token"] = secrets.token_hex(32)
            return render_template("register.html")

        if len(password) < 4:
            flash("Password must be at least 4 characters", "error")
            session["csrf_token"] = secrets.token_hex(32)
            return render_template("register.html")

        if password != password_confirm:
            flash("Passwords do not match", "error")
            session["csrf_token"] = secrets.token_hex(32)
            return render_template("register.html")

        if User.query.filter_by(username=username).first():
            flash("Username already taken", "error")
            session["csrf_token"] = secrets.token_hex(32)
            return render_template("register.html")

        user = User(username=username, role="operator")
        user.set_password(password)
        db.session.add(user)
        db.session.commit()

        # Create switcher state for the new user
        SwitcherState.get_for_user(user.id)

        login_user(user, remember=True)
        session["csrf_token"] = secrets.token_hex(32)
        return redirect(url_for("views.director"))

    return render_template("register.html")
