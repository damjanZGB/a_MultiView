"""Flask extensions — instantiated here, initialized in create_app."""

from __future__ import annotations

from flask_login import LoginManager
from flask_sqlalchemy import SQLAlchemy
from flask_sock import Sock

db = SQLAlchemy()
login_manager = LoginManager()
sock = Sock()
