"""Entry point for the a_MultiView application."""

from __future__ import annotations

import os

from app import create_app

# Module-level so `flask run` can discover the app object (L4).
app = create_app()

if __name__ == "__main__":
    app.run(
        debug=os.environ.get("FLASK_DEBUG", "0") == "1",
        host="0.0.0.0",
        port=5030,
    )
