"""Every published file, real and mock, must satisfy the v1 contract."""
import json

import pytest

from app.repositories.files import DATASETS
from app.services.datasets import validate


@pytest.mark.parametrize("bundle", ["", "mock"])
@pytest.mark.parametrize("name", sorted(DATASETS))
def test_published_file_matches_v1(data_dir, bundle, name):
    path = data_dir / bundle / DATASETS[name]
    if not path.is_file():
        pytest.skip(f"{bundle or 'real'}/{DATASETS[name]} not generated")
    validate(name, json.loads(path.read_text(encoding="utf-8")))
