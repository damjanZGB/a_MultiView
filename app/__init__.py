"""Application factory."""

from __future__ import annotations

from flask import Flask

from app.config import BASE_DIR, Config
from app.extensions import db, login_manager, sock


def create_app(config: type = Config) -> Flask:
    """Create and configure the Flask application."""
    app = Flask(
        __name__,
        template_folder="../templates",
        static_folder="../static",
    )
    app.config.from_object(config)

    # Ensure instance dir exists
    app.config["PRESETS_DIR"].mkdir(parents=True, exist_ok=True)
    (BASE_DIR / "instance").mkdir(parents=True, exist_ok=True)

    # Init extensions
    db.init_app(app)
    login_manager.init_app(app)
    login_manager.login_view = "auth.login"
    sock.init_app(app)

    # User loader
    from app.models import User

    @login_manager.user_loader
    def load_user(user_id: str) -> User | None:
        return db.session.get(User, int(user_id))

    # Register blueprints
    from app.auth import auth_bp
    from app.api import api_bp
    from app.views import views_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(api_bp, url_prefix="/api")
    app.register_blueprint(views_bp)

    # Create tables & seed data
    with app.app_context():
        db.create_all()
        _seed_admin(app)
        _seed_switcher_state()

    # L1 — warn on default SECRET_KEY
    if app.config["SECRET_KEY"] == "change-me-in-production":
        app.logger.warning("SECRET_KEY is set to the default value — change it in production!")

    return app


def _seed_admin(app: Flask) -> None:
    """Create default admin user if none exists."""
    from app.models import User

    if User.query.filter_by(role="admin").first() is None:
        admin = User(
            username=app.config["DEFAULT_ADMIN_USER"],
            role="admin",
        )
        admin.set_password(app.config["DEFAULT_ADMIN_PASS"])
        db.session.add(admin)
        db.session.commit()


def _seed_switcher_state() -> None:
    """Ensure the singleton SwitcherState row exists (H1)."""
    from app.models import SwitcherState

    if SwitcherState.query.first() is None:
        db.session.add(SwitcherState(id=1, grid_size=4))
        db.session.commit()
