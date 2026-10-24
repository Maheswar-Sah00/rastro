"""Geospatial evidence record, one per ranch (rastro.geospatial). Versioned separately."""
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

GEO_SCHEMA_VERSION = "geo-evidence/1.0.0"

Ha = Annotated[float, Field(ge=0)]
Share = Annotated[float, Field(ge=0, le=1.0001)]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class GeometryQuality(Strict):
    status: Literal["valid", "repaired", "missing", "empty", "rejected"]
    area_ha: Ha | None
    source_crs: str | None
    data_status: str


class PolygonIds(Strict):
    pre_cutoff: list[str]
    straddles_cutoff: list[str]
    post_cutoff: list[str]
    unknown_date: list[str]


class Deforestation(Strict):
    coverage: Literal["full", "partial", "none", "undeclared"]
    post_cutoff_ha: Ha | None
    straddles_cutoff_ha: Ha | None
    pre_cutoff_ha: Ha | None
    unknown_date_ha: Ha | None
    pre_cutoff_undated_ha: Ha | None
    intersecting_polygon_ids: PolygonIds | None
    nearest_post_cutoff_km: Ha | None
    post_cutoff_nearby_not_intersecting: Annotated[int, Field(ge=0)] | None
    proximity_km: float


class AreaOverlap(Strict):
    feature_id: str
    name: str
    legal_context: str
    overlap_ha: Ha
    overlap_share: Share
    phase: str | None = None
    recognised: bool | None = None
    category: str | None = None
    strict_protection: bool | None = None


class Overlap(Strict):
    overlap_ha: Ha
    overlap_share: Share
    areas: list[AreaOverlap]


class EmbargoStatus(Strict):
    status: Literal["none", "active", "historical", "unverified"]
    embargo_ids: list[str]
    sources: list[str]
    simulated: bool
    since: str | None


class Legal(Strict):
    eudr_cutoff_indicator: Literal["post_cutoff_clearing_detected", "no_post_cutoff_clearing_detected", "undetermined"]
    recognised_indigenous_land_overlap: bool | None
    strict_protection_overlap: bool | None
    embargo_status: str
    embargo_simulated: bool
    note: str


class ScientificRisk(Strict):
    class_: Literal["low", "watch", "high", "unknown"] = Field(alias="class")
    reasons: list[str]


class GeoEvidence(Strict):
    schema_version: Literal["geo-evidence/1.0.0"]
    ranch_id: str
    cutoff_date: str
    as_of: str
    geometry: GeometryQuality
    post_cutoff_deforestation_area_hectares: Ha | None
    intersecting_deforestation_polygon_ids: list[str] | None
    deforestation: Deforestation
    indigenous_territory: Overlap | None
    protected_area: Overlap | None
    embargo: EmbargoStatus
    nearest_slaughterhouse_km: Ha | None
    legal: Legal
    scientific_risk: ScientificRisk
    dataset_versions: dict[str, str]
    data_status: dict[str, str]
    warnings: list[str]
