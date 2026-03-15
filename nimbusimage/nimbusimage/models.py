"""Data models for the nimbusimage package."""

from __future__ import annotations

from dataclasses import dataclass, field

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


@dataclass
class Location:
    """A position in the dataset coordinate space."""

    xy: int = 0
    z: int = 0
    time: int = 0

    def to_dict(self) -> dict:
        """Serialize to the server's location format."""
        return {"XY": self.xy, "Z": self.z, "Time": self.time}

    @classmethod
    def from_dict(cls, data: dict) -> Location:
        """Deserialize from the server's location format."""
        return cls(
            xy=data.get("XY", 0),
            z=data.get("Z", 0),
            time=data.get("Time", 0),
        )


@dataclass
class Annotation:
    """A NimbusImage annotation.

    Stores raw coordinates as the server provides them.
    Geometry conversion methods (polygon, point, get_mask, etc.)
    are in the coordinates module and called via convenience methods here.
    """

    id: str | None
    shape: str
    tags: list[str]
    channel: int
    location: Location
    coordinates: list[dict]
    dataset_id: str
    color: str | None = None

    def to_dict(self) -> dict:
        """Serialize to the server's annotation format."""
        d: dict = {
            "shape": self.shape,
            "tags": self.tags,
            "channel": self.channel,
            "location": self.location.to_dict(),
            "coordinates": self.coordinates,
            "datasetId": self.dataset_id,
        }
        if self.id is not None:
            d["_id"] = self.id
        if self.color is not None:
            d["color"] = self.color
        return d

    @classmethod
    def from_dict(cls, data: dict) -> Annotation:
        """Deserialize from the server's annotation format."""
        return cls(
            id=data.get("_id"),
            shape=data["shape"],
            tags=data.get("tags", []),
            channel=data.get("channel", 0),
            location=Location.from_dict(data.get("location", {})),
            coordinates=data.get("coordinates", []),
            dataset_id=data.get("datasetId", ""),
            color=data.get("color"),
        )

    @classmethod
    def from_point(
        cls,
        x: float,
        y: float,
        channel: int,
        tags: list[str],
        dataset_id: str,
        location: Location | None = None,
        color: str | None = None,
    ) -> Annotation:
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


@dataclass
class Connection:
    """A connection between two annotations."""

    id: str | None
    parent_id: str
    child_id: str
    dataset_id: str
    tags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        """Serialize to the server's connection format."""
        d: dict = {
            "parentId": self.parent_id,
            "childId": self.child_id,
            "datasetId": self.dataset_id,
            "tags": self.tags,
        }
        if self.id is not None:
            d["_id"] = self.id
        return d

    @classmethod
    def from_dict(cls, data: dict) -> Connection:
        """Deserialize from the server's connection format."""
        return cls(
            id=data.get("_id"),
            parent_id=data["parentId"],
            child_id=data["childId"],
            dataset_id=data.get("datasetId", ""),
            tags=data.get("tags", []),
        )


@dataclass
class Property:
    """A property definition (schema, not values)."""

    id: str | None
    name: str
    shape: str
    image: str
    tags: dict
    worker_interface: dict

    @classmethod
    def from_dict(cls, data: dict) -> Property:
        """Deserialize from the server's property format."""
        return cls(
            id=data.get("_id"),
            name=data.get("name", ""),
            shape=data.get("shape", ""),
            image=data.get("image", ""),
            tags=data.get("tags", {}),
            worker_interface=data.get("workerInterface", {}),
        )

    def to_dict(self) -> dict:
        """Serialize to the server's property format."""
        d: dict = {
            "name": self.name,
            "shape": self.shape,
            "image": self.image,
            "tags": self.tags,
            "workerInterface": self.worker_interface,
        }
        if self.id is not None:
            d["_id"] = self.id
        return d


@dataclass
class PixelSize:
    """Physical pixel size with unit conversion."""

    value: float
    unit: str

    def __post_init__(self):
        self.unit = _canonical_unit(self.unit)

    def to(self, unit: str) -> PixelSize:
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


@dataclass
class FrameInfo:
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
