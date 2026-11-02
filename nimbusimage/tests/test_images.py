"""Tests for ImageAccessor."""

import json
import pickle
from unittest.mock import MagicMock

import numpy as np
import pytest
from nimbusimage.images import ImageAccessor, _parse_color
from nimbusimage.models import FrameInfo


def _make_dataset(mock_gc, tiles_meta):
    """Create a mock Dataset with tiles metadata."""
    from nimbusimage.dataset import Dataset
    ds = Dataset.__new__(Dataset)
    ds._gc = mock_gc
    ds._id = "folder_001"
    ds._item_id = "item_001"
    ds._tiles = tiles_meta
    ds._folder_data = {"_id": "folder_001", "name": "Test"}
    ds.images = ImageAccessor(ds)
    return ds


class TestFrameIndexResolution:
    def test_build_frame_map(self, mock_gc, sample_tiles_metadata):
        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        accessor = ds.images
        accessor._ensure_frame_map()

        # channel=0, time=0, z=0, xy=0 -> frame 0
        assert accessor._frame_index(channel=0, time=0, z=0, xy=0) == 0
        # channel=1, time=0, z=0, xy=0 -> frame 1
        assert accessor._frame_index(channel=1, time=0, z=0, xy=0) == 1
        # channel=0, time=0, z=1, xy=0 -> frame 2
        assert accessor._frame_index(channel=0, time=0, z=1, xy=0) == 2

    def test_no_frames_defaults(self, mock_gc):
        tiles = {"sizeX": 100, "sizeY": 100, "dtype": "uint8"}
        ds = _make_dataset(mock_gc, tiles)
        accessor = ds.images
        accessor._ensure_frame_map()
        assert accessor._frame_index(channel=0, time=0, z=0, xy=0) == 0


class TestImageGet:
    def test_get_returns_squeezed_2d(self, mock_gc, sample_tiles_metadata):
        # large_image returns single-band regions as (H, W, 1)
        # (utilities._imageToNumpy reshapes 2D images that way).
        img_3d = np.random.randint(0, 1000, (768, 1024, 1), dtype=np.uint16)
        mock_response = MagicMock()
        mock_response.content = pickle.dumps(img_3d)
        mock_gc.get.return_value = mock_response

        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        result = ds.images.get(xy=0, z=0, time=0, channel=0)

        assert result.ndim == 2
        assert result.shape == (768, 1024)

    def test_get_all_channels(self, mock_gc, sample_tiles_metadata):
        img = np.zeros((768, 1024), dtype=np.uint16)
        mock_response = MagicMock()
        mock_response.content = pickle.dumps(img)
        mock_gc.get.return_value = mock_response

        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        result = ds.images.get_all_channels(xy=0, z=0, time=0)

        # 2 channels in sample metadata
        assert len(result) == 2
        assert all(r.shape == (768, 1024) for r in result)

    def test_get_stack_z(self, mock_gc, sample_tiles_metadata):
        img = np.zeros((768, 1024), dtype=np.uint16)
        mock_response = MagicMock()
        mock_response.content = pickle.dumps(img)
        mock_gc.get.return_value = mock_response

        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        result = ds.images.get_stack(xy=0, time=0, channel=0, axis="z")

        # 2 z-slices in sample metadata
        assert result.shape == (2, 768, 1024)


def _composite_dataset(mock_gc, tiles, layers, images, overrides=None):
    """A dataset whose fake server returns `images[frame]` for tiles/region
    and that image's min/max for tiles/histogram. Returns the dataset and
    the list of region requests' parameters."""
    from nimbusimage.collections import CollectionAccessor

    ds = _make_dataset(mock_gc, tiles)
    ds.collections = CollectionAccessor(mock_gc, "folder_001")
    ds.collections._cache = {"meta": {"layers": layers}}
    ds.collections._view = {"layerContrasts": overrides or {}}
    regions = []

    def get(path, parameters=None, jsonResp=True):
        if path.endswith("/tiles/region"):
            regions.append(parameters)
            response = MagicMock()
            if "style" in parameters:
                response.content = pickle.dumps(_styled(
                    json.loads(parameters["style"]), images
                ))
            else:
                response.content = pickle.dumps(images[parameters["frame"]])
            return response
        if path.endswith("/tiles/histogram"):
            img = images[parameters["frame"]]
            return [{"min": float(img.min()), "max": float(img.max())}]
        raise AssertionError(f"unexpected GET {path}")

    mock_gc.get.side_effect = get
    return ds, regions


def _styled(style, images):
    """What large_image returns for a band style with a black-to-white
    palette: the per-pixel max ("lighten") of the windowed bands, 8-bit,
    as RGBA."""
    windowed = []
    for band in style["bands"]:
        img = images[band["frame"]].astype(np.float64)
        low = img.min() if band["min"] == "min" else band["min"]
        high = img.max() if band["max"] == "max" else band["max"]
        windowed.append(np.clip((img - low) / (high - low), 0, 1))
    gray = np.round(np.max(windowed, axis=0) * 255).astype(np.uint8)
    return np.stack([gray, gray, gray, np.full_like(gray, 255)], axis=-1)


def _layer(channel=0, color="#FF0000", contrast=None, **extra):
    return {
        "id": f"layer_{channel}",
        "channel": channel,
        "color": color,
        "visible": True,
        "contrast": contrast or {
            "mode": "percentile", "blackPoint": 0, "whitePoint": 100,
        },
        **extra,
    }


def _skewed():
    """Mostly 100, with one 0 and one 1000: a quantile reading of the
    contrast points and the app's linear reading disagree sharply."""
    img = np.full((4, 4), 100, dtype=np.uint16)
    img[0, 0] = 0
    img[3, 3] = 1000
    return img


class TestGetComposite:
    def test_percentile_is_a_percent_of_the_histogram_range(
        self, mock_gc, sample_tiles_metadata,
    ):
        """whitePoint=50 means halfway between the histogram's min and max
        (0..1000 -> 500), as in the app; not the 50th-percentile value
        (100), which would saturate every ordinary pixel."""
        ds, _ = _composite_dataset(
            mock_gc, sample_tiles_metadata,
            [_layer(contrast={
                "mode": "percentile", "blackPoint": 0, "whitePoint": 50,
            })],
            {0: _skewed()},
        )
        result = ds.images.get_composite(dtype="float64")
        assert result[1, 1, 0] == pytest.approx(100 / 500)
        assert result[3, 3, 0] == 1.0

    def test_view_contrast_override_wins(
        self, mock_gc, sample_tiles_metadata,
    ):
        ds, _ = _composite_dataset(
            mock_gc, sample_tiles_metadata,
            [_layer()],
            {0: _skewed()},
            overrides={"layer_0": {
                "mode": "percentile", "blackPoint": 0, "whitePoint": 50,
            }},
        )
        result = ds.images.get_composite(dtype="float64")
        assert result[1, 1, 0] == pytest.approx(100 / 500)

    def test_absolute_contrast_uses_raw_values(
        self, mock_gc, sample_tiles_metadata,
    ):
        """Including a white point at or below 1 on float data, which the
        old code replaced with the image maximum."""
        img = np.full((4, 4), 0.25, dtype=np.float32)
        ds, _ = _composite_dataset(
            mock_gc, sample_tiles_metadata,
            [_layer(contrast={
                "mode": "absolute", "blackPoint": 0, "whitePoint": 0.5,
            })],
            {0: img},
        )
        result = ds.images.get_composite(dtype="float64")
        assert result[0, 0, 0] == pytest.approx(0.5)

    def test_hidden_layer_excluded(self, mock_gc, sample_tiles_metadata):
        img = np.arange(16, dtype=np.uint16).reshape(4, 4)
        ds, regions = _composite_dataset(
            mock_gc, sample_tiles_metadata,
            [_layer(0), _layer(1, color="#00FF00", visible=False)],
            {0: img, 1: img},
        )
        result = ds.images.get_composite(dtype="float64")
        assert result[:, :, 1].max() == 0.0
        assert result[:, :, 0].max() > 0.0
        assert [r["frame"] for r in regions] == [0]

    def test_offset_layer_reads_the_offset_slice(
        self, mock_gc, sample_tiles_metadata,
    ):
        img = np.arange(16, dtype=np.uint16).reshape(4, 4)
        ds, regions = _composite_dataset(
            mock_gc, sample_tiles_metadata,
            [_layer(0, z={"type": "offset", "value": 1})],
            {2: img},  # channel 0 at z=1
        )
        ds.images.get_composite(z=0)
        assert [r["frame"] for r in regions] == [2]

    def test_constant_layer_ignores_the_current_slice(
        self, mock_gc, sample_tiles_metadata,
    ):
        img = np.arange(16, dtype=np.uint16).reshape(4, 4)
        ds, regions = _composite_dataset(
            mock_gc, sample_tiles_metadata,
            [_layer(0, z={"type": "constant", "value": 0})],
            {0: img},
        )
        ds.images.get_composite(z=1)
        assert [r["frame"] for r in regions] == [0]

    def test_layer_offset_out_of_range_is_not_drawn(
        self, mock_gc, sample_tiles_metadata,
    ):
        ds, regions = _composite_dataset(
            mock_gc, sample_tiles_metadata,
            [_layer(0, z={"type": "offset", "value": 1})],
            {},
        )
        result = ds.images.get_composite(z=1, dtype="float64")
        assert regions == []
        assert result.shape == (768, 1024, 3)
        assert result.max() == 0.0

    def test_max_merge_is_one_server_side_projection(
        self, mock_gc, sample_tiles_metadata,
    ):
        """One styled region request composites every projected frame on
        the server (as the app's banded tiles do), instead of fetching and
        holding each frame; contrast comes from the current frame's
        histogram (resolveSlice maps max-merge to the current index)."""
        low = np.zeros((2, 2), dtype=np.uint16)
        low[0, 0] = 400
        high = np.zeros((2, 2), dtype=np.uint16)
        high[1, 1] = 800
        ds, regions = _composite_dataset(
            mock_gc, sample_tiles_metadata,
            [_layer(0, z={"type": "max-merge", "value": None})],
            {0: low, 2: high},
        )
        result = ds.images.get_composite(z=0, dtype="float64", max_size=64)
        assert len(regions) == 1
        style = json.loads(regions[0]["style"])
        assert [band["frame"] for band in style["bands"]] == [0, 2]
        # Range 0..400 from the z=0 frame's histogram only.
        assert {(b["min"], b["max"]) for b in style["bands"]} == {(0, 400)}
        histogram_frames = [
            c.kwargs["parameters"]["frame"]
            for c in mock_gc.get.call_args_list
            if c.args[0].endswith("/tiles/histogram")
        ]
        assert histogram_frames == [0]
        assert result[0, 0, 0] == 1.0  # 400 of 0..400
        assert result[1, 1, 0] == 1.0  # 800 clips
        assert result[0, 1, 0] == 0.0

    def test_max_merge_layer_without_a_current_frame_is_not_drawn(
        self, mock_gc, sample_tiles_metadata,
    ):
        """Sparse data: the channel exists at z=1 only. At z=0 the app has
        no image for the layer (getLayerImages is empty), so it draws
        nothing rather than failing on an empty histogram."""
        tiles = {**sample_tiles_metadata, "frames": [
            f for f in sample_tiles_metadata["frames"] if f["Frame"] != 0
        ]}
        img = np.arange(4, dtype=np.uint16).reshape(2, 2)
        ds, regions = _composite_dataset(
            mock_gc, tiles,
            [_layer(0, z={"type": "max-merge", "value": None})],
            {2: img},
        )
        result = ds.images.get_composite(z=0, dtype="float64")
        assert regions == []
        assert result.max() == 0.0

    def test_missing_histogram_falls_back_to_the_image_range(
        self, mock_gc, sample_tiles_metadata,
    ):
        """The app styles a tile with min/max auto when it has no
        histogram; an empty histogram response must not raise."""
        img = np.array([[100, 200], [300, 500]], dtype=np.uint16)
        ds, _ = _composite_dataset(
            mock_gc, sample_tiles_metadata, [_layer(0)], {0: img},
        )
        region_get = mock_gc.get.side_effect

        def get(path, parameters=None, jsonResp=True):
            if path.endswith("/tiles/histogram"):
                return []
            return region_get(path, parameters, jsonResp)

        mock_gc.get.side_effect = get
        result = ds.images.get_composite(dtype="float64")
        assert result[0, 0, 0] == 0.0
        assert result[1, 1, 0] == 1.0

    def test_crop_past_the_image_does_not_upsample(
        self, mock_gc, sample_tiles_metadata,
    ):
        """large_image clips the crop to the 1024x768 image; a cap above
        that clipped size must not be sent."""
        img = np.arange(16, dtype=np.uint16).reshape(4, 4)
        ds, regions = _composite_dataset(
            mock_gc, sample_tiles_metadata, [_layer(0)], {0: img},
        )
        ds.images.get_composite(max_size=2000, crop=(0, 0, 5000, 5000))
        assert "width" not in regions[0]

    def test_equal_contrast_bounds_scale_by_one_like_large_image(
        self, mock_gc, sample_tiles_metadata,
    ):
        """large_image styles min == max with a delta of 1, so a flat frame
        renders black (not raw values clipped to white), and one count
        above it renders full."""
        img = np.array([[100, 100], [100, 101]], dtype=np.uint16)
        ds, _ = _composite_dataset(
            mock_gc, sample_tiles_metadata,
            [_layer(contrast={
                "mode": "absolute", "blackPoint": 100, "whitePoint": 100,
            })],
            {0: img},
        )
        result = ds.images.get_composite(dtype="float64")
        assert result[0, 0, 0] == 0.0
        assert result[1, 1, 0] == 1.0

    def test_negative_crop_edges_count_from_the_far_edge(
        self, mock_gc, sample_tiles_metadata,
    ):
        """large_image reads a negative edge as an offset from the right or
        bottom: (-1000, 0, -1, 10) on a 1024-wide image is 999 x 10, so a
        64 px cap is sent and an empty composite has that aspect."""
        img = np.arange(16, dtype=np.uint16).reshape(4, 4)
        ds, regions = _composite_dataset(
            mock_gc, sample_tiles_metadata, [_layer(0)], {0: img},
        )
        ds.images.get_composite(max_size=64, crop=(-1000, 0, -1, 10))
        assert regions[0]["width"] == 64
        empty, _ = _composite_dataset(
            mock_gc, sample_tiles_metadata, [], {},
        )
        shape = empty.images.get_composite(
            max_size=64, crop=(-1000, 0, -1, 10)
        ).shape
        assert shape == (1, 64, 3)  # 10 x 999 scaled to fit 64

    def test_one_pixel_crop_composite_keeps_its_shape(
        self, mock_gc, sample_tiles_metadata,
    ):
        """Full-resolution (exact) path: (1, 100) and 1x1 crops stay
        (1, 100, 3) and (1, 1, 3)."""
        for shape in ((1, 100, 1), (1, 1, 1)):
            ds, _ = _composite_dataset(
                mock_gc, sample_tiles_metadata, [_layer(0)],
                {0: np.arange(np.prod(shape), dtype=np.uint16).reshape(shape)},
            )
            result = ds.images.get_composite(
                dtype="float64", crop=(0, 0, shape[1], 1)
            )
            assert result.shape == (*shape[:2], 3)

    def test_percentile_bounds_round_like_the_app(
        self, mock_gc, sample_tiles_metadata,
    ):
        """d3's rangeRound rounds the bounds to integers: on a 0..1 float
        image a 50% white point becomes 1, not 0.5."""
        img = np.array([[0.0, 0.25], [0.5, 1.0]], dtype=np.float32)
        ds, _ = _composite_dataset(
            mock_gc, sample_tiles_metadata,
            [_layer(contrast={
                "mode": "percentile", "blackPoint": 0, "whitePoint": 50,
            })],
            {0: img},
        )
        result = ds.images.get_composite(dtype="float64")
        assert result[0, 1, 0] == pytest.approx(0.25)

    def test_max_size_and_crop_reach_the_region_request(
        self, mock_gc, sample_tiles_metadata,
    ):
        img = np.arange(16, dtype=np.uint16).reshape(4, 4)
        ds, regions = _composite_dataset(
            mock_gc, sample_tiles_metadata, [_layer(0)], {0: img},
        )
        ds.images.get_composite(max_size=64, crop=(10, 20, 110, 220))
        request = dict(regions[0])
        style = json.loads(request.pop("style"))
        assert request == {
            "frame": 0, "encoding": "pickle:5",
            "left": 10, "top": 20, "right": 110, "bottom": 220,
            "width": 64, "height": 64,
        }
        assert [band["frame"] for band in style["bands"]] == [0]

    def test_downsampled_layer_is_windowed_by_the_server_like_the_app(
        self, mock_gc, sample_tiles_metadata,
    ):
        """When downsampling, the layer is drawn with the app's style (the
        server windows before its final resample, as for the app's tiles);
        at full resolution it is computed exactly in float, no style."""
        img = np.array([[0, 400], [800, 1000]], dtype=np.uint16)
        ds, regions = _composite_dataset(
            mock_gc, sample_tiles_metadata,
            [_layer(contrast={
                "mode": "percentile", "blackPoint": 0, "whitePoint": 50,
            })],
            {0: img},
        )
        downsampled = ds.images.get_composite(max_size=64, dtype="float64")
        style = json.loads(regions[-1]["style"])
        assert style["bands"] == [{
            "frame": 0, "min": 0, "max": 500,
            "palette": ["#000000", "#ffffff"],
        }]
        assert downsampled[0, 1, 0] == pytest.approx(204 / 255)  # 400/500

        full = ds.images.get_composite(dtype="float64")
        assert "style" not in regions[-1]
        assert full[0, 1, 0] == pytest.approx(0.8)

    def test_max_size_above_the_region_does_not_upsample(
        self, mock_gc, sample_tiles_metadata,
    ):
        """large_image scales to fit width x height, upsampling too, so a
        cap at or above the region size must not be sent (live: a 2048^2
        frame came back 4096^2)."""
        img = np.arange(16, dtype=np.uint16).reshape(4, 4)
        ds, regions = _composite_dataset(
            mock_gc, sample_tiles_metadata, [_layer(0)], {0: img},
        )
        ds.images.get_composite(max_size=256, crop=(10, 20, 110, 220))
        ds.images.get_composite(max_size=1024)  # the full 1024x768 image
        for region in regions:
            assert "width" not in region and "height" not in region

    def test_empty_composite_has_the_downsampled_shape(
        self, mock_gc, sample_tiles_metadata,
    ):
        ds, _ = _composite_dataset(mock_gc, sample_tiles_metadata, [], {})
        result = ds.images.get_composite(max_size=256)
        assert result.shape == (192, 256, 3)  # 1024x768 scaled to fit


class TestCompositeStyle:
    def test_matches_get_composite(self, mock_gc, sample_tiles_metadata):
        """The style get_composite's server path would send, one band per
        drawn frame, colored by layer, windowed to the same contrast."""
        ds, _ = _composite_dataset(
            mock_gc, sample_tiles_metadata,
            [_layer(contrast={
                "mode": "percentile", "blackPoint": 0, "whitePoint": 50,
            }), _layer(channel=1, color="rgb(0, 255, 0)")],
            {0: _skewed(), 1: _skewed()},
        )
        style = ds.images.composite_style()
        assert style == {"bands": [
            {"frame": 0, "min": 0.0, "max": 500.0,
             "palette": ["#000000", "#ff0000"]},
            {"frame": 1, "min": 0.0, "max": 1000.0,
             "palette": ["#000000", "#00ff00"]},
        ]}

    def test_hidden_layers_and_nothing_drawn(
        self, mock_gc, sample_tiles_metadata,
    ):
        ds, _ = _composite_dataset(
            mock_gc, sample_tiles_metadata,
            [_layer(visible=False)], {0: _skewed()},
        )
        assert ds.images.composite_style() is None


class TestSliceIndexes:
    """Mirrors resolveSlice / getLayerSliceIndexes in src/store/images.ts."""

    def test_current_constant_offset_max_merge(self):
        from nimbusimage.images import _slice_indexes

        assert _slice_indexes({"type": "current"}, 3, 11) == [3]
        assert _slice_indexes(None, 3, 11) == [3]
        assert _slice_indexes({"type": "constant", "value": 7}, 3, 11) == [7]
        assert _slice_indexes(
            {"type": "constant", "value": None}, 3, 11
        ) == [0]
        assert _slice_indexes({"type": "offset", "value": -1}, 3, 11) == [2]
        assert _slice_indexes({"type": "max-merge"}, 3, 4) == [0, 1, 2, 3]

    def test_out_of_range_is_none_and_single_entry_axis_is_zero(self):
        from nimbusimage.images import _slice_indexes

        assert _slice_indexes({"type": "offset", "value": 1}, 10, 11) is None
        assert _slice_indexes({"type": "offset", "value": 5}, 0, 1) == [0]


class TestGetMaxSize:
    def test_get_passes_max_size_as_width_and_height(
        self, mock_gc, sample_tiles_metadata,
    ):
        img = np.arange(16, dtype=np.uint16).reshape(4, 4)
        response = MagicMock()
        response.content = pickle.dumps(img)
        mock_gc.get.return_value = response
        ds = _make_dataset(mock_gc, sample_tiles_metadata)

        ds.images.get(channel=1, max_size=512)
        params = mock_gc.get.call_args.kwargs["parameters"]
        assert (params["frame"], params["width"], params["height"]) == (
            1, 512, 512,
        )

    def test_stack_and_all_channels_pass_max_size(
        self, mock_gc, sample_tiles_metadata,
    ):
        img = np.zeros((4, 4), dtype=np.uint16)
        response = MagicMock()
        response.content = pickle.dumps(img)
        mock_gc.get.return_value = response
        ds = _make_dataset(mock_gc, sample_tiles_metadata)

        ds.images.get_stack(axis="z", max_size=100)
        ds.images.get_all_channels(max_size=100)
        widths = [
            c.kwargs["parameters"].get("width")
            for c in mock_gc.get.call_args_list
        ]
        assert widths == [100] * 4  # 2 z-planes, then 2 channels

    def test_one_pixel_crops_keep_both_spatial_axes(
        self, mock_gc, sample_tiles_metadata,
    ):
        """A 1-pixel-high or 1x1 crop stays 2D (squeeze() dropped the
        spatial axis: (1, 100, 1) became (100,))."""
        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        for shape in ((1, 100, 1), (1, 1, 1)):
            response = MagicMock()
            response.content = pickle.dumps(np.ones(shape, dtype=np.uint16))
            mock_gc.get.return_value = response
            assert ds.images.get(crop=(0, 0, shape[1], 1)).shape == shape[:2]

    def test_rejects_non_positive_max_size(
        self, mock_gc, sample_tiles_metadata,
    ):
        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        with pytest.raises(ValueError, match="max_size"):
            ds.images.get(max_size=0)


class TestIterFrames:
    def test_iter_frames(self, mock_gc, sample_tiles_metadata):
        img = np.zeros((768, 1024), dtype=np.uint16)
        mock_response = MagicMock()
        mock_response.content = pickle.dumps(img)
        mock_gc.get.return_value = mock_response

        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        frames = list(ds.images.iter_frames())

        assert len(frames) == 4  # 2 channels x 2 z-slices
        assert isinstance(frames[0][0], FrameInfo)
        assert frames[0][1].shape == (768, 1024)


def _mock_gradient_region_endpoint(mock_gc):
    """Serve tiles/region requests from a synthetic linear gradient.

    The master image has pixel values master[r, c] = 2*c + 3*r, i.e. the
    continuous field g(x, y) = 2*(x - 0.5) + 3*(y - 0.5) at pixel centers.
    Linear fields are reproduced exactly by bilinear interpolation and by
    center-aligned downsampling, so tests can assert exact values.

    Returns the list of captured request parameter dicts.
    """
    captured = []

    def side_effect(path, parameters=None, jsonResp=True):
        captured.append(parameters)
        p = parameters
        left, top = p["left"], p["top"]
        width = p.get("width", int(round(p["right"] - left)))
        height = p.get("height", int(round(p["bottom"] - top)))
        scale_x = width / (p["right"] - left)
        scale_y = height / (p["bottom"] - top)
        cols, rows = np.meshgrid(np.arange(width), np.arange(height))
        x = left + (cols + 0.5) / scale_x
        y = top + (rows + 0.5) / scale_y
        arr = 2.0 * (x - 0.5) + 3.0 * (y - 0.5)
        response = MagicMock()
        response.content = pickle.dumps(arr)
        return response

    mock_gc.get.side_effect = side_effect
    return captured


def _gradient(x, y):
    """The continuous field matching _mock_gradient_region_endpoint."""
    return 2.0 * (np.asarray(x) - 0.5) + 3.0 * (np.asarray(y) - 0.5)


class TestLineScan:
    def test_straight_line_values_and_distances(
        self, mock_gc, sample_tiles_metadata,
    ):
        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        _mock_gradient_region_endpoint(mock_gc)

        result = ds.images.line_scan([(5, 10), (15, 10)])

        # ~1 sample per pixel of length: 10 px -> 11 samples
        assert len(result.distances) == 11
        np.testing.assert_allclose(result.distances, np.arange(11.0))
        np.testing.assert_allclose(
            result.values, _gradient(np.linspace(5, 15, 11), 10)
        )
        np.testing.assert_allclose(result.points[:, 1], 10.0)

    def test_polyline_distances_and_corner(
        self, mock_gc, sample_tiles_metadata,
    ):
        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        _mock_gradient_region_endpoint(mock_gc)

        result = ds.images.line_scan([(10, 10), (20, 10), (20, 20)])

        assert result.distances[-1] == 20.0
        assert np.all(np.diff(result.distances) > 0)
        # Sample at distance 10 is the corner vertex (20, 10)
        corner = np.argmin(np.abs(result.distances - 10.0))
        np.testing.assert_allclose(result.points[corner], [20.0, 10.0])
        np.testing.assert_allclose(
            result.values[corner], _gradient(20.0, 10.0)
        )

    def test_outside_image_is_nan(self, mock_gc, sample_tiles_metadata):
        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        _mock_gradient_region_endpoint(mock_gc)

        result = ds.images.line_scan([(-20, 5), (10, 5)])

        outside = result.points[:, 0] < 0
        assert outside.any()
        assert np.isnan(result.values[outside]).all()
        inside = result.points[:, 0] >= 1
        assert np.isfinite(result.values[inside]).all()
        np.testing.assert_allclose(
            result.values[inside],
            _gradient(result.points[inside, 0], 5),
        )

    def test_large_region_downsampled(self, mock_gc):
        tiles = {
            "sizeX": 5000, "sizeY": 4000, "dtype": "uint16",
            "frames": [],
        }
        ds = _make_dataset(mock_gc, tiles)
        captured = _mock_gradient_region_endpoint(mock_gc)

        result = ds.images.line_scan([(0, 0), (4000, 3000)])

        # 5000 px long line, capped at 2000 samples
        assert len(result.distances) == 2000
        # The region request must be capped to max_region_dim per side
        params = captured[0]
        assert params["width"] == 2048
        assert max(params["width"], params["height"]) == 2048
        # Values still map back to image coordinates exactly
        finite = np.isfinite(result.values)
        np.testing.assert_allclose(
            result.values[finite],
            _gradient(
                result.points[finite, 0], result.points[finite, 1]
            ),
        )

    def test_short_line_sample_count(self, mock_gc, sample_tiles_metadata):
        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        _mock_gradient_region_endpoint(mock_gc)

        result = ds.images.line_scan([(10, 10), (14.2, 10)])
        # ceil(4.2) + 1 = 6 samples
        assert len(result.distances) == 6

    def test_frame_selection(self, mock_gc, sample_tiles_metadata):
        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        captured = _mock_gradient_region_endpoint(mock_gc)

        ds.images.line_scan([(5, 10), (15, 10)], channel=1, z=1)

        # channel=1, z=1 -> frame 3 in sample metadata
        assert captured[0]["frame"] == 3

    def test_multiband_region_averaged(
        self, mock_gc, sample_tiles_metadata,
    ):
        ds = _make_dataset(mock_gc, sample_tiles_metadata)

        def side_effect(path, parameters=None, jsonResp=True):
            p = parameters
            width = int(round(p["right"] - p["left"]))
            height = int(round(p["bottom"] - p["top"]))
            cols, rows = np.meshgrid(np.arange(width), np.arange(height))
            band = _gradient(p["left"] + cols + 0.5, p["top"] + rows + 0.5)
            # Three bands offset by 0, 3, 6 -> mean is band + 3
            arr = np.stack([band, band + 3, band + 6], axis=-1)
            response = MagicMock()
            response.content = pickle.dumps(arr)
            return response

        mock_gc.get.side_effect = side_effect
        result = ds.images.line_scan([(5, 10), (15, 10)])
        np.testing.assert_allclose(
            result.values, _gradient(result.points[:, 0], 10) + 3
        )

    def test_invalid_inputs_raise(self, mock_gc, sample_tiles_metadata):
        import pytest

        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        with pytest.raises(ValueError, match="at least 2"):
            ds.images.line_scan([(5, 10)])
        with pytest.raises(ValueError, match="zero length"):
            ds.images.line_scan([(5, 10), (5, 10)])
        with pytest.raises(ValueError, match="at least 2"):
            ds.images.line_scan([5, 10])
        with pytest.raises(ValueError, match="outside the image"):
            ds.images.line_scan([(-50, -50), (-10, -10)])


class TestParseColor:
    def test_white(self):
        assert _parse_color("white") == (1.0, 1.0, 1.0)

    def test_rgb(self):
        assert _parse_color("rgb(255,0,0)") == (1.0, 0.0, 0.0)

    def test_rgb_with_spaces(self):
        assert _parse_color("rgb(0, 255, 0)") == (0.0, 1.0, 0.0)

    def test_hex(self):
        assert _parse_color("#FF0000") == (1.0, 0.0, 0.0)

    def test_hex_lowercase(self):
        r, g, b = _parse_color("#00ff00")
        assert r == 0.0
        assert g == 1.0
        assert b == 0.0

    def test_unknown_warns(self):
        import warnings
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            result = _parse_color("red")
            assert result == (1.0, 1.0, 1.0)
            assert len(w) == 1
            assert "Unrecognized color format" in str(w[0].message)

    def test_short_hex_warns(self):
        import warnings
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            _parse_color("#F00")
            assert len(w) == 1


class TestImageWriterGuard:
    """Test that ImageWriter prevents double-write."""

    def test_write_sets_written_flag(self):
        """Verify that write() sets _written to prevent double-write."""
        from nimbusimage.images import ImageWriter

        writer = ImageWriter.__new__(ImageWriter)
        writer._written = False
        writer._filename = "test.tiff"
        writer._metadata = {}

        # Mock the internals
        writer._sink = MagicMock()
        writer._dataset = MagicMock()
        writer._dataset._gc = MagicMock()
        writer._dataset._id = "ds_001"

        import tempfile
        import os
        path = os.path.join(tempfile.gettempdir(), "test.tiff")
        # Create a dummy file so os.remove doesn't fail
        with open(path, "w") as f:
            f.write("dummy")

        writer.write("test.tiff")
        assert writer._written is True

        # Second call should be a no-op
        writer._sink.write.reset_mock()
        writer.write("test.tiff")
        writer._sink.write.assert_not_called()

    def test_context_manager_no_double_write(self):
        """Verify __exit__ doesn't write again after explicit write()."""
        from nimbusimage.images import ImageWriter

        writer = ImageWriter.__new__(ImageWriter)
        writer._written = True  # simulate already written
        writer._filename = "test.tiff"
        writer._sink = MagicMock()
        writer._dataset = MagicMock()

        writer.__exit__(None, None, None)
        # write() should not be called on the sink since _written is True
        writer._sink.write.assert_not_called()
