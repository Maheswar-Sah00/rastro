"""Read-only access to the published data bundle (web/public/data).

Same resolution rule as the web loader (web/src/lib/data.ts): `<file>` first, then
`mock/<file>` when mocks are allowed. Every read reports which one it served, so the API can
label mock data the way the UI does.
"""
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

Source = Literal["real", "mock"]

# Logical dataset name -> file path inside the bundle (SPEC §6).
DATASETS = {
    "meta": "meta.json",
    "metrics": "metrics.json",
    "ranches": "ranches.geojson",
    "movements": "movements.json",
    "shipments": "shipments.json",
    "destinations": "destinations.json",
    "onchain": "onchain.json",
}


class DatasetNotFound(LookupError):
    pass


@dataclass(frozen=True)
class Loaded:
    name: str
    source: Source
    path: Path
    data: Any


class FileRepository:
    def __init__(self, data_dir: Path, allow_mock: bool = True):
        self.data_dir = data_dir
        self.allow_mock = allow_mock

    def locate(self, name: str) -> tuple[Source, Path] | None:
        rel = DATASETS[name]
        real = self.data_dir / rel
        if real.is_file():
            return "real", real
        mock = self.data_dir / "mock" / rel
        if self.allow_mock and mock.is_file():
            return "mock", mock
        return None

    def load(self, name: str) -> Loaded:
        if name not in DATASETS:
            raise DatasetNotFound(name)
        found = self.locate(name)
        if found is None:
            raise DatasetNotFound(name)
        source, path = found
        return Loaded(name, source, path, json.loads(path.read_text(encoding="utf-8")))

    def inventory(self) -> dict[str, Source | None]:
        return {name: (found[0] if (found := self.locate(name)) else None) for name in DATASETS}
