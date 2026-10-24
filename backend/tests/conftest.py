import pytest
from fastapi.testclient import TestClient

from app.api.routes import get_repo
from app.config import get_settings
from app.main import app
from app.repositories.files import FileRepository


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def client_for():
    """Client whose data repository points at a given directory."""

    def make(data_dir, allow_mock=True):
        app.dependency_overrides[get_repo] = lambda: FileRepository(data_dir, allow_mock)
        return TestClient(app)

    yield make
    app.dependency_overrides.clear()


@pytest.fixture
def data_dir():
    return get_settings().data_dir
