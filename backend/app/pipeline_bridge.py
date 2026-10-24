"""Make the pipeline package (`rastro`) importable. The API reuses its logic instead of copying it."""
import sys

from app.config import get_settings


def ensure_pipeline_on_path() -> None:
    p = str(get_settings().pipeline_dir)
    if p not in sys.path:
        sys.path.insert(0, p)


ensure_pipeline_on_path()
