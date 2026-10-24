from fastapi import APIRouter, Depends, HTTPException
from pydantic import ValidationError

from app.config import API_VERSION, APP_VERSION, get_settings
from app.repositories.files import DATASETS, DatasetNotFound, FileRepository
from app.schemas import v1
from app.services.datasets import load_validated

router = APIRouter()


def get_repo() -> FileRepository:
    s = get_settings()
    return FileRepository(s.data_dir, s.allow_mock)


@router.get("/health", response_model=v1.Health, tags=["system"])
@router.get(f"/api/{API_VERSION}/health", response_model=v1.Health, tags=["system"])
def health(repo: FileRepository = Depends(get_repo)) -> v1.Health:
    inventory = repo.inventory()
    found = repo.data_dir.is_dir()
    return v1.Health(
        status="ok" if found and all(inventory.values()) else "degraded",
        version=APP_VERSION,
        api_version=API_VERSION,
        schema_version=v1.SCHEMA_VERSION,
        data_dir_found=found,
        datasets=inventory,
    )


@router.get(f"/api/{API_VERSION}/datasets/{{name}}", response_model=v1.Envelope, tags=["data"])
def dataset(name: str, repo: FileRepository = Depends(get_repo)) -> v1.Envelope:
    if name not in DATASETS:
        raise HTTPException(404, f"unknown dataset '{name}'; known: {sorted(DATASETS)}")
    try:
        loaded = load_validated(repo, name)
    except DatasetNotFound:
        raise HTTPException(404, f"dataset '{name}' has not been generated yet") from None
    except ValidationError as e:
        # A producer broke the contract: fail loudly instead of serving bad data to the UI.
        raise HTTPException(500, f"dataset '{name}' does not match schema v{v1.SCHEMA_VERSION}: {e.error_count()} errors") from None
    return v1.Envelope(schema=f"rastro.{name}/v{v1.SCHEMA_VERSION}", source=loaded.source, data=loaded.data)
