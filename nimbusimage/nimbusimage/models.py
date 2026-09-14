"""Data models for the nimbusimage package."""

from pydantic import BaseModel, ConfigDict, Field, field_validator

# Unit conversion factors to meters
_TO_METERS = {
    "m": 1.0,
    "mm": 1e-3,
    "um": 1e-6,
    "nm": 1e-9,
}

# Aliases that map to canonical unit names
_UNIT_ALIASES = {
    "µm": "um",
    "micron": "um",
    "microns": "um",
}


def _canonical_unit(unit: str) -> str:
    return _UNIT_ALIASES.get(unit, unit)


class Location(BaseModel):
    """A position in the dataset coordinate space."""

    model_config = ConfigDict(populate_by_name=True)

    xy: int = Field(0, alias="XY")
    z: int = Field(0, alias="Z")
    time: int = Field(0, alias="Time")

    def to_dict(self) -> dict:
        """Serialize to the server's location format."""
        return self.model_dump(by_alias=True)

    @classmethod
    def from_dict(cls, data: dict) -> "Location":
        """Deserialize from the server's location format."""
        return cls.model_validate(data)


class Annotation(BaseModel):
    """A NimbusImage annotation.

    Stores raw coordinates as the server provides them.
    Geometry conversion methods (polygon, point, get_mask, etc.)
    are in the coordinates module and called via convenience methods here.
    """

    model_config = ConfigDict(populate_by_name=True)

    id: str | None = Field(None, alias="_id")
    shape: str
    tags: list[str] = []
    channel: int = 0
    location: Location = Field(default_factory=Location)
    coordinates: list[dict] = []
    dataset_id: str = Field("", alias="datasetId")
    color: str | None = None

    def to_dict(self) -> dict:
        """Serialize to the server's annotation format."""
        d = self.model_dump(by_alias=True, exclude_none=True)
        return d

    @classmethod
    def from_dict(cls, data: dict) -> "Annotation":
        """Deserialize from the server's annotation format."""
        return cls.model_validate(data)

    @classmethod
    def from_point(
        cls,
        x: float,
        y: float,
        channel: int,
        tags: list[str],
        dataset_id: str,
        location: "Location | None" = None,
        color: str | None = None,
    ) -> "Annotation":
        """Create a point annotation from image-space coordinates."""
        return cls(
            id=None,
            shape="point",
            tags=tags,
            channel=channel,
            location=location or Location(),
            coordinates=[{"x": x, "y": y}],
            dataset_id=dataset_id,
            color=color,
        )

    # Geometry methods are added by coordinates.py (polygon, point,
    # centroid, get_mask, get_pixels, from_polygon, from_mask)
    # to avoid circular imports. They are attached in __init__.py.


class Connection(BaseModel):
    """A connection between two annotations."""

    model_config = ConfigDict(populate_by_name=True)

    id: str | None = Field(None, alias="_id")
    parent_id: str = Field(..., alias="parentId")
    child_id: str = Field(..., alias="childId")
    dataset_id: str = Field("", alias="datasetId")
    tags: list[str] = []

    def to_dict(self) -> dict:
        """Serialize to the server's connection format."""
        return self.model_dump(by_alias=True, exclude_none=True)

    @classmethod
    def from_dict(cls, data: dict) -> "Connection":
        """Deserialize from the server's connection format."""
        return cls.model_validate(data)


class Property(BaseModel):
    """A property definition (schema, not values)."""

    model_config = ConfigDict(populate_by_name=True)

    id: str | None = Field(None, alias="_id")
    name: str = ""
    shape: str = ""
    image: str = ""
    tags: dict = Field(default_factory=dict)
    worker_interface: dict = Field(
        default_factory=dict, alias="workerInterface",
    )

    def to_dict(self) -> dict:
        """Serialize to the server's property format."""
        return self.model_dump(by_alias=True, exclude_none=True)

    @classmethod
    def from_dict(cls, data: dict) -> "Property":
        """Deserialize from the server's property format."""
        return cls.model_validate(data)


class PixelSize(BaseModel):
    """Physical pixel size with unit conversion."""

    value: float
    unit: str

    @field_validator("unit")
    @classmethod
    def _canonicalize_unit(cls, v: str) -> str:
        return _canonical_unit(v)

    def to(self, unit: str) -> "PixelSize":
        """Convert to a different unit."""
        target = _canonical_unit(unit)
        if self.unit == target:
            return PixelSize(value=self.value, unit=target)
        meters = self.value * _TO_METERS[self.unit]
        return PixelSize(value=meters / _TO_METERS[target], unit=target)

    def __float__(self) -> float:
        return self.value

    def __mul__(self, other) -> float:
        return self.value * other

    def __rmul__(self, other) -> float:
        return other * self.value


class MultiSourceConfiguration(BaseModel):
    """Result of configuring a folder of image files as a dataset.

    Returned by ``Dataset.configure()``. On a dry run ``item_id`` and
    ``job_id`` are ``None`` and nothing was written.

    ``validation_error`` is the whole point of a dry run: it is ``None``
    when the configuration is usable, and otherwise carries the same
    message the web UI would show (e.g. "Not all variables are assigned").
    A non-dry run raises on that condition instead, so inspect it here —
    alongside ``variables`` — to work out which ``assignments`` override
    to pass.
    """

    model_config = ConfigDict(populate_by_name=True)

    item_id: str | None = Field(None, alias="itemId")
    job_id: str | None = Field(None, alias="jobId")
    collection_id: str | None = Field(None, alias="collectionId")
    view_id: str | None = Field(None, alias="viewId")
    config: dict = Field(default_factory=dict)
    dimension_labels: dict = Field(
        default_factory=dict, alias="dimensionLabels"
    )
    variables: list[dict] = Field(default_factory=list)
    assignments: dict = Field(default_factory=dict)
    transcode: bool = False
    transcode_default: bool = Field(False, alias="transcodeDefault")
    # Whether compositing was actually applied. Not the same as asking for
    # it: enable_compositing only takes effect for a single source with ND2
    # frame metadata, and when it does, XY collapses to one position.
    compositing: bool = False
    is_rgb_file: bool = Field(False, alias="isRGBFile")
    rgb_band_count: int = Field(0, alias="rgbBandCount")
    validation_error: str | None = Field(None, alias="validationError")

    @property
    def is_valid(self) -> bool:
        """Whether this configuration would be accepted by a real run."""
        return self.validation_error is None

    @property
    def unassigned_variables(self) -> list[dict]:
        """Variables no dimension is currently using.

        These are what an ``assignments`` override has to account for when
        ``validation_error`` is "Not all variables are assigned"; pass a
        variable's ``source``/``guess`` under the dimension you want it on.
        """
        # Match on `name`, which the server generates unique per variable
        # ("Filename variable 2", "Metadata 1 (Z)"), rather than on
        # (source, guess) -- that pair is unique today only because of an
        # invariant on the other side of the wire.
        used = {a["name"] for a in self.assignments.values() if a}
        return [v for v in self.variables if v["name"] not in used]

    def to_dict(self) -> dict:
        return self.model_dump(by_alias=True)


class FrameInfo(BaseModel):
    """Metadata for a single image frame."""

    index: int
    xy: int
    z: int
    time: int
    channel: int
    channel_name: str | None

    def to_dict(self) -> dict:
        """Dict of coordinate keys for use as **kwargs."""
        return {
            "xy": self.xy,
            "z": self.z,
            "time": self.time,
            "channel": self.channel,
        }

    def to_large_image_params(self) -> dict:
        """Dict for large_image addTile parameters."""
        return {
            "c": self.channel,
            "z": self.z,
            "t": self.time,
            "xy": self.xy,
        }
