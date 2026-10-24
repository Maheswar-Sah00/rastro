"""Load a published dataset and validate it against its v1 schema before it leaves the API."""
from pathlib import Path
from typing import Any

from pydantic import TypeAdapter

from app.repositories.files import FileRepository, Loaded
from app.schemas import v1

# (dataset, file, mtime) already validated: a pipeline re-run changes the mtime and forces a
# re-check, repeated requests for an unchanged file don't pay for validation again.
_validated: set[tuple[str, Path, int]] = set()


def validate(name: str, data: Any) -> None:
    model, is_list = v1.DATASET_MODELS[name]
    if is_list:
        TypeAdapter(list[model]).validate_python(data)
    else:
        model.model_validate(data)


def load_validated(repo: FileRepository, name: str) -> Loaded:
    loaded = repo.load(name)
    key = (name, loaded.path, loaded.path.stat().st_mtime_ns)
    if key not in _validated:
        validate(name, loaded.data)
        _validated.add(key)
    return loaded
