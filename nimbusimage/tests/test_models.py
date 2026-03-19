"""Tests for nimbusimage data models."""

from nimbusimage.models import (
    Annotation,
    Connection,
    FrameInfo,
    Location,
    PixelSize,
    Property,
)


class TestLocation:
    def test_defaults(self):
        loc = Location()
        assert loc.xy == 0
        assert loc.z == 0
        assert loc.time == 0

    def test_to_dict(self):
        loc = Location(xy=1, z=2, time=3)
        assert loc.to_dict() == {"XY": 1, "Z": 2, "Time": 3}

    def test_from_dict(self):
        loc = Location.from_dict({"XY": 1, "Z": 2, "Time": 3})
        assert loc == Location(xy=1, z=2, time=3)

    def test_from_dict_missing_keys_default_zero(self):
        loc = Location.from_dict({"XY": 5})
        assert loc == Location(xy=5, z=0, time=0)


class TestAnnotation:
    def test_from_dict(self, sample_annotation_dict):
        ann = Annotation.from_dict(sample_annotation_dict)
        assert ann.id == "ann_001"
        assert ann.shape == "polygon"
        assert ann.tags == ["nucleus"]
        assert ann.channel == 0
        assert ann.location == Location(xy=0, z=0, time=0)
        assert len(ann.coordinates) == 4
        assert ann.dataset_id == "dataset_001"
        assert ann.color is None

    def test_to_dict_round_trip(self, sample_annotation_dict):
        ann = Annotation.from_dict(sample_annotation_dict)
        result = ann.to_dict()
        assert result["shape"] == "polygon"
        assert result["tags"] == ["nucleus"]
        assert result["channel"] == 0
        assert result["location"] == {"Time": 0, "XY": 0, "Z": 0}
        assert result["coordinates"] == sample_annotation_dict["coordinates"]
        assert result["datasetId"] == "dataset_001"

    def test_to_dict_omits_none_id(self):
        ann = Annotation(
            id=None,
            shape="point",
            tags=["spot"],
            channel=1,
            location=Location(xy=0, z=0, time=0),
            coordinates=[{"x": 50.5, "y": 60.5}],
            dataset_id="ds_001",
        )
        result = ann.to_dict()
        assert "_id" not in result

    def test_to_dict_includes_id_when_set(self, sample_annotation_dict):
        ann = Annotation.from_dict(sample_annotation_dict)
        result = ann.to_dict()
        assert result["_id"] == "ann_001"

    def test_to_dict_includes_color_when_set(self):
        ann = Annotation(
            id=None,
            shape="point",
            tags=[],
            channel=0,
            location=Location(),
            coordinates=[{"x": 10.0, "y": 20.0}],
            dataset_id="ds_001",
            color="rgb(255,0,0)",
        )
        result = ann.to_dict()
        assert result["color"] == "rgb(255,0,0)"

    def test_empty_tags(self):
        ann = Annotation(
            id=None,
            shape="polygon",
            tags=[],
            channel=0,
            location=Location(),
            coordinates=[],
            dataset_id="ds_001",
        )
        assert ann.tags == []

    def test_from_point_classmethod(self):
        ann = Annotation.from_point(
            x=100.0, y=200.0, channel=0, tags=["spot"],
            dataset_id="ds_001", location=Location(xy=0, z=1, time=2),
        )
        assert ann.shape == "point"
        assert len(ann.coordinates) == 1
        # from_point takes image-space x,y and stores directly
        assert ann.coordinates[0]["x"] == 100.0
        assert ann.coordinates[0]["y"] == 200.0


class TestConnection:
    def test_from_dict(self, sample_connection_dict):
        conn = Connection.from_dict(sample_connection_dict)
        assert conn.id == "conn_001"
        assert conn.parent_id == "ann_001"
        assert conn.child_id == "ann_002"
        assert conn.dataset_id == "dataset_001"
        assert conn.tags == ["parent-child"]

    def test_to_dict_round_trip(self, sample_connection_dict):
        conn = Connection.from_dict(sample_connection_dict)
        result = conn.to_dict()
        assert result["parentId"] == "ann_001"
        assert result["childId"] == "ann_002"
        assert result["datasetId"] == "dataset_001"
        assert result["tags"] == ["parent-child"]

    def test_to_dict_omits_none_id(self):
        conn = Connection(
            id=None,
            parent_id="p1",
            child_id="c1",
            dataset_id="ds_001",
            tags=[],
        )
        result = conn.to_dict()
        assert "_id" not in result

    def test_default_empty_tags(self):
        conn = Connection(
            id=None, parent_id="p1", child_id="c1", dataset_id="ds_001"
        )
        assert conn.tags == []


class TestProperty:
    def test_from_dict(self, sample_property_dict):
        prop = Property.from_dict(sample_property_dict)
        assert prop.id == "prop_001"
        assert prop.name == "Blob Intensity"
        assert prop.shape == "polygon"
        assert prop.image == "properties/blob_intensity:latest"
        assert prop.tags == {"exclusive": False, "tags": ["nucleus"]}
        assert prop.worker_interface == {"Channel": 1}


class TestPixelSize:
    def test_to_conversion(self):
        ps = PixelSize(value=0.000219, unit="mm")
        result = ps.to("um")
        assert result.unit == "um"
        assert abs(result.value - 0.219) < 1e-9

    def test_to_nm(self):
        ps = PixelSize(value=0.000219, unit="mm")
        result = ps.to("nm")
        assert result.unit == "nm"
        assert abs(result.value - 219.0) < 1e-6

    def test_float(self):
        ps = PixelSize(value=0.5, unit="mm")
        assert float(ps) == 0.5

    def test_mul(self):
        ps = PixelSize(value=0.5, unit="mm")
        assert ps * 10 == 5.0

    def test_alias_micron(self):
        ps = PixelSize(value=219.0, unit="nm")
        result = ps.to("micron")
        assert result.unit == "um"  # canonical form
        assert abs(result.value - 0.219) < 1e-6

    def test_identity_conversion(self):
        ps = PixelSize(value=42.0, unit="um")
        result = ps.to("um")
        assert result.value == 42.0


class TestFrameInfo:
    def test_to_dict(self):
        fi = FrameInfo(
            index=0, xy=0, z=1, time=2, channel=0, channel_name="DAPI"
        )
        d = fi.to_dict()
        assert d == {"xy": 0, "z": 1, "time": 2, "channel": 0}

    def test_to_large_image_params(self):
        fi = FrameInfo(
            index=5, xy=1, z=2, time=3, channel=0, channel_name="GFP"
        )
        params = fi.to_large_image_params()
        assert params == {"c": 0, "z": 2, "t": 3, "xy": 1}
