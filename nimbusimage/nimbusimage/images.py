"""ImageAccessor — image retrieval, stacking, compositing."""

from __future__ import annotations

import json
import math
import pickle
from typing import TYPE_CHECKING, Iterator, NamedTuple, Sequence

import numpy as np

from nimbusimage.models import FrameInfo

if TYPE_CHECKING:
    from nimbusimage.dataset import Dataset


class LineScanResult(NamedTuple):
    """Intensity profile along a polyline.

    Attributes:
        distances: (N,) distances of each sample from the start of the
            line, in pixels.
        values: (N,) float64 intensities, bilinearly interpolated.
            NaN for samples outside the image.
        points: (N, 2) x, y image coordinates of each sample.
    """

    distances: np.ndarray
    values: np.ndarray
    points: np.ndarray


class ImageAccessor:
    """Access images for a dataset."""

    def __init__(self, dataset: Dataset):
        self._dataset = dataset
        self._frame_map: dict | None = None
        # Histograms by frame: get_composite and composite_style both
        # need them.
        self._histograms: dict[int, list] = {}

    def _ensure_frame_map(self):
        """Build channel→time→z→xy→frame_index map lazily."""
        if self._frame_map is not None:
            return
        self._dataset._ensure_metadata()
        frames = self._dataset._tiles.get("frames", None)
        if not frames:
            self._frame_map = {0: {0: {0: {0: 0}}}}
            return
        m: dict = {}
        for f in frames:
            ch = f.get("IndexC", 0)
            t = f.get("IndexT", 0)
            z = f.get("IndexZ", 0)
            xy = f.get("IndexXY", 0)
            idx = f["Frame"]
            m.setdefault(ch, {}).setdefault(t, {}).setdefault(
                z, {}
            ).setdefault(xy, idx)
        self._frame_map = m

    def frame_index(
        self, channel: int = 0, time: int = 0, z: int = 0, xy: int = 0
    ) -> int:
        """The large-image frame number of one channel at one location
        (the ``frame`` parameter of tiles endpoints and styles)."""
        self._ensure_frame_map()
        return self._frame_map[channel][time][z][xy]

    _frame_index = frame_index

    def _get_region(self, frame: int, **kwargs) -> np.ndarray:
        """Fetch a region as a numpy array via pickle protocol."""
        params = {"frame": frame, "encoding": "pickle:5"}
        params.update(kwargs)
        response = self._dataset._gc.get(
            f"item/{self._dataset._item_id}/tiles/region",
            parameters=params,
            jsonResp=False,
        )
        return pickle.loads(response.content)

    def get(
        self,
        xy: int = 0,
        z: int = 0,
        time: int = 0,
        channel: int = 0,
        crop: tuple[float, float, float, float] | None = None,
        max_size: int | None = None,
    ) -> np.ndarray:
        """Get a single image frame as a 2D numpy array.

        Always returns a 2D (height, width) array for a single-band image,
        including for a one-pixel-high or -wide crop.

        Args:
            xy, z, time, channel: Coordinates.
            crop: Optional (left, top, right, bottom) crop region.
            max_size: Optional longest side of the result, in pixels.
                The server downsamples (from the image pyramid), so a
                large slide is never transferred at full resolution.
                Never upsamples.

        Returns:
            2D numpy array.
        """
        frame = self._frame_index(channel, time, z, xy)
        return _drop_single_band(self._get_region(
            frame, **self._region_params(crop, max_size)
        ))

    def get_all_channels(
        self,
        xy: int = 0,
        z: int = 0,
        time: int = 0,
        max_size: int | None = None,
    ) -> list[np.ndarray]:
        """Get all channels at one location as a list of 2D arrays.
        max_size: see get()."""
        self._dataset._ensure_metadata()
        n_ch = self._dataset.num_channels
        return [
            self.get(xy=xy, z=z, time=time, channel=ch, max_size=max_size)
            for ch in range(n_ch)
        ]

    def get_stack(
        self,
        xy: int = 0,
        z: int = 0,
        time: int = 0,
        channel: int = 0,
        axis: str = "z",
        max_size: int | None = None,
    ) -> np.ndarray:
        """Get a stack along one axis as a 3D array.

        Args:
            axis: 'z' or 'time'. The other coordinates are fixed.
            max_size: Optional longest side of each plane; see get().

        Returns:
            3D numpy array: (N, H, W) where N is the axis size.
        """
        self._dataset._ensure_metadata()
        if axis == "z":
            n = self._dataset.num_z
            images = [
                self.get(xy=xy, z=i, time=time, channel=channel,
                         max_size=max_size)
                for i in range(n)
            ]
        elif axis == "time":
            n = self._dataset.num_time
            images = [
                self.get(xy=xy, z=z, time=i, channel=channel,
                         max_size=max_size)
                for i in range(n)
            ]
        else:
            raise ValueError(f"axis must be 'z' or 'time', got '{axis}'")
        return np.stack(images, axis=0)

    def get_composite(
        self,
        xy: int = 0,
        z: int = 0,
        time: int = 0,
        mode: str = "lighten",
        dtype: str | None = None,
        max_size: int | None = None,
        crop: tuple[float, float, float, float] | None = None,
    ) -> np.ndarray:
        """Get an RGB composite of the visible layers, as the app draws it.

        Follows the caller's layer settings (``ds.collections``): color,
        visibility, contrast with their per-view overrides, and each
        layer's XY/Z/time slice setting (``current``, ``constant``,
        ``offset``, or ``max-merge``, a maximum projection along the
        axis). A layer whose slice falls outside the dataset, or whose
        channel has no frame here, is left out, as in the app.

        Contrast follows the app (``toStyle`` in src/store/images.ts):
        ``absolute`` black/white points are raw intensities; ``percentile``
        points are percents of the frame histogram's min..max range (the
        same histogram request the app makes), not quantiles.

        Args:
            mode: 'lighten' (default, per-channel maximum, as in the app)
                or 'add'.
            dtype: Output dtype. None = match source. 'float64' = [0,1].
                'uint8' = [0,255].
            max_size: Optional longest side of the result, in pixels; the
                server downsamples. See get().
            crop: Optional (left, top, right, bottom) region, in full
                resolution pixels.

        Returns:
            (H, W, 3) numpy array.
        """
        self._dataset._ensure_metadata()
        self._ensure_frame_map()
        source_dtype = self._dataset.dtype
        target_dtype = dtype or source_dtype
        region = self._region_params(crop, max_size)

        composite = None
        for layer, frames, contrast_range in self._drawn_layers(xy, z, time):
            if len(frames) > 1 or "width" in region:
                # Drawn by the server's band styling, as the app's tiles
                # are: a max-merge projection in one request (not one fetch
                # per frame), and a downsampled layer windowed before the
                # final resample, so saturated spots are not averaged
                # with dark neighbors before clipping.
                img = self._styled(frames, contrast_range, region)
            else:
                # Full resolution, one frame: exact, in float.
                img = _drop_single_band(
                    self._get_region(frames[0], **region)
                ).astype(np.float64)
                cmin, cmax = contrast_range or (img.min(), img.max())
                # large_image's band styling (what the app renders through):
                # equal bounds scale by 1, so a flat frame comes out black.
                img = (img - cmin) / ((cmax - cmin) if cmax != cmin else 1)
                img = np.clip(img, 0.0, 1.0)

            r, g, b = _parse_color(layer.get("color", "white"))
            channel_rgb = np.stack([img * r, img * g, img * b], axis=-1)

            if composite is None:
                composite = channel_rgb
            elif mode == "lighten":
                composite = np.maximum(composite, channel_rgb)
            else:
                composite += channel_rgb

        if composite is None:
            # Nothing drawn: a black image of the size a fetch would have.
            composite = np.zeros(
                (*self._output_shape(crop, max_size), 3), dtype=np.float64
            )
        composite = np.clip(composite, 0.0, 1.0)

        # Convert to target dtype
        if target_dtype in ("float32", "float64"):
            return composite.astype(target_dtype)
        elif target_dtype == "uint8":
            return (composite * 255).astype(np.uint8)
        elif target_dtype == "uint16":
            return (composite * 65535).astype(np.uint16)
        else:
            dt = np.dtype(target_dtype)
            if np.issubdtype(dt, np.floating):
                return composite.astype(dt)
            max_val = np.iinfo(dt).max
            return (composite * max_val).astype(dt)

    def _drawn_layers(self, xy: int, z: int, time: int):
        """(layer, frames, contrast_range) for each layer the app draws at
        this location, in drawing order."""
        self._dataset._ensure_metadata()
        self._ensure_frame_map()
        collections = self._dataset.collections
        overrides = collections.layer_contrasts
        sizes = {
            "xy": self._dataset.num_xy,
            "z": self._dataset.num_z,
            "time": self._dataset.num_time,
        }
        current = {"xy": xy, "z": z, "time": time}
        for layer in collections.layers:
            if not layer.get("visible", True):
                continue
            frames = self._layer_frames(layer, current, sizes)
            if not frames:
                continue
            # The app's histogram is of the layer's image at the current
            # location (resolveSlice maps max-merge to the current index),
            # even when the drawn tile is a projection over many frames.
            histogram_frames = self._layer_frames(
                layer, current, sizes, project=False
            )
            if not histogram_frames:
                # No image of this channel at the current location: the
                # app draws nothing for the layer (getLayerImages is empty).
                continue
            contrast = (
                overrides.get(layer.get("id")) or layer.get("contrast", {})
            )
            yield layer, frames, self._contrast_range(
                contrast, histogram_frames
            )

    def composite_style(
        self, xy: int = 0, z: int = 0, time: int = 0
    ) -> dict | None:
        """The composite as one large_image ``style``: a band per drawn
        frame, windowed to its layer's contrast and colored with its
        layer's color, combined with "lighten" (get_composite's default
        mode). Pass it to tiles/region to have the server render the
        composite, e.g. for a download link; None when nothing draws.
        """
        bands = []
        for layer, frames, contrast_range in self._drawn_layers(xy, z, time):
            low, high = contrast_range or ("min", "max")
            r, g, b = _parse_color(layer.get("color", "white"))
            color = "#{:02x}{:02x}{:02x}".format(
                *(round(c * 255) for c in (r, g, b))
            )
            bands += [
                {"frame": frame, "min": low, "max": high,
                 "palette": ["#000000", color]}
                for frame in frames
            ]
        return {"bands": bands} if bands else None

    def _layer_frames(
        self, layer: dict, current: dict, sizes: dict, project: bool = True
    ) -> list[int]:
        """Frame indexes a layer draws at `current`; [] when it draws
        nothing there (mirrors getLayerSliceIndexes in the frontend).
        With project=False a max-merge axis resolves to the current index,
        as the frontend's resolveSlice does for the layer's histogram."""
        indexes = {}
        for axis, size in sizes.items():
            setting = layer.get(axis)
            if not project and (setting or {}).get("type") == "max-merge":
                setting = {"type": "current"}
            resolved = _slice_indexes(setting, current[axis], size)
            if resolved is None:
                return []
            indexes[axis] = resolved
        by_time = self._frame_map.get(layer.get("channel", 0), {})
        return [
            by_time[t][zi][xyi]
            for t in indexes["time"]
            for zi in indexes["z"]
            for xyi in indexes["xy"]
            if xyi in by_time.get(t, {}).get(zi, {})
        ]

    def _histogram(self, frame: int):
        """A frame's histogram, fetched once per accessor."""
        if frame not in self._histograms:
            self._histograms[frame] = self._dataset._gc.get(
                f"item/{self._dataset._item_id}/tiles/histogram",
                parameters={**_HISTOGRAM_PARAMS, "frame": frame},
            )
        return self._histograms[frame]

    def _contrast_range(
        self, contrast: dict, frames: list[int]
    ) -> tuple[float, float] | None:
        """The layer's (black, white) intensities, or None when there is
        no histogram: the app then styles with the image's own min/max."""
        black = contrast.get("blackPoint", 0)
        white = contrast.get("whitePoint", 100)
        if contrast.get("mode") == "absolute":
            return float(black), float(white)
        # Percentile mode: a linear percent of the histogram's range,
        # rounded like the app's scaleLinear().rangeRound().
        histograms = [self._histogram(frame) for frame in frames]
        if not all(histograms):
            return None
        lo = min(h[0]["min"] for h in histograms)
        hi = max(h[0]["max"] for h in histograms)
        return (
            _round_half_up(lo + black / 100 * (hi - lo)),
            _round_half_up(lo + white / 100 * (hi - lo)),
        )

    def _styled(
        self,
        frames: list[int],
        contrast_range: tuple[float, float] | None,
        region: dict,
    ) -> np.ndarray:
        """A layer drawn by large_image's band styling, in [0, 1].

        The style is the app's (toStyle): each frame a band windowed to
        the contrast range, several frames composited with "lighten" (a
        per-pixel maximum, i.e. a max-merge projection). The server
        styles before its final resample, as for the app's tiles. The
        result is 8-bit; at full resolution a projection equals the
        per-frame maximum exactly.
        """
        low, high = contrast_range or ("min", "max")
        style = {"bands": [
            {"frame": frame, "min": low, "max": high,
             "palette": ["#000000", "#ffffff"]}
            for frame in frames
        ]}
        styled = self._get_region(
            frames[0], style=json.dumps(style), **region
        )
        # Grayscale palette: every color band holds the intensity. At full
        # resolution large_image leaves values past the white point above
        # 255 (a display clamps them), so clamp here too.
        gray = styled[..., 0] if styled.ndim == 3 else styled
        return np.clip(gray.astype(np.float64) / 255.0, 0.0, 1.0)

    def _region_size(self, crop) -> tuple[int, int]:
        """(height, width) of the requested region at full resolution, as
        large_image resolves it (_getRegionBounds): a negative edge counts
        from the right/bottom, then edges are rounded and clamped."""
        height, width = self._dataset.shape
        if crop is None:
            return height, width
        left, top, right, bottom = crop

        def resolve(low, high, size):
            low, high = (v + size if v < 0 else v for v in (low, high))
            low = min(size, max(0, round(low)))
            high = min(size, max(low, round(high)))
            return high - low

        return resolve(top, bottom, height), resolve(left, right, width)

    def _region_params(
        self,
        crop: tuple[float, float, float, float] | None,
        max_size: int | None,
    ) -> dict:
        """tiles/region parameters for an optional crop and size cap.

        large_image scales the region to fit width x height, upsampling
        too, so the cap is only sent when it is smaller than the region.
        """
        params = {}
        if crop is not None:
            left, top, right, bottom = crop
            params.update(left=left, top=top, right=right, bottom=bottom)
        if max_size is not None:
            if max_size < 1:
                raise ValueError(
                    f"max_size must be positive, got {max_size}"
                )
            if max_size < max(self._region_size(crop)):
                params.update(width=max_size, height=max_size)
        return params

    def _output_shape(self, crop, max_size) -> tuple[int, int]:
        height, width = self._region_size(crop)
        scale = 1.0
        if max_size is not None:
            scale = min(1.0, max_size / max(width, height))
        return max(1, round(height * scale)), max(1, round(width * scale))

    def line_scan(
        self,
        points: Sequence[tuple[float, float]] | np.ndarray,
        xy: int = 0,
        z: int = 0,
        time: int = 0,
        channel: int = 0,
        max_samples: int = 2000,
        max_region_dim: int = 2048,
    ) -> LineScanResult:
        """Measure the intensity profile along a polyline.

        Matches the frontend line scan tool: the polyline is resampled at
        roughly one sample per pixel of arc length and intensities are
        bilinearly interpolated from the pixels around each sample.

        Args:
            points: Polyline vertices as (x, y) pairs in image pixel
                coordinates. Two points measure a straight segment; more
                points a freehand path.
            xy, z, time, channel: Frame coordinates.
            max_samples: Cap on the number of samples along the line.
            max_region_dim: Pixel regions larger than this per side are
                downsampled by the server before sampling. Bounds the
                transfer size for lines spanning huge images.

        Returns:
            LineScanResult with distances (px), values (NaN outside the
            image), and the sampled (x, y) points. Convert distances to
            physical units with ds.pixel_size.

        Raises:
            ValueError: For fewer than 2 vertices or a zero-length line.
        """
        vertices = np.asarray(points, dtype=np.float64)
        if vertices.ndim != 2 or vertices.shape[0] < 2 or (
            vertices.shape[1] != 2
        ):
            raise ValueError(
                "points must be at least 2 (x, y) pairs, "
                f"got array of shape {vertices.shape}"
            )
        segment_lengths = np.hypot(
            *np.diff(vertices, axis=0).T
        )
        cumulative = np.concatenate([[0.0], np.cumsum(segment_lengths)])
        total_length = cumulative[-1]
        if total_length <= 0:
            raise ValueError("line has zero length")

        num_samples = min(
            max_samples, max(2, int(np.ceil(total_length)) + 1)
        )
        distances = np.linspace(0.0, total_length, num_samples)
        sample_points = np.column_stack([
            np.interp(distances, cumulative, vertices[:, 0]),
            np.interp(distances, cumulative, vertices[:, 1]),
        ])

        region, left, top, scale_x, scale_y = self._get_scaled_region(
            frame=self._frame_index(channel, time, z, xy),
            bounds=(
                np.floor(sample_points.min(axis=0)) - 1,
                np.ceil(sample_points.max(axis=0)) + 2,
            ),
            max_region_dim=max_region_dim,
        )

        values = _bilinear_sample(
            region,
            (sample_points[:, 0] - left) * scale_x - 0.5,
            (sample_points[:, 1] - top) * scale_y - 0.5,
        )
        return LineScanResult(
            distances=distances, values=values, points=sample_points
        )

    def _get_scaled_region(
        self,
        frame: int,
        bounds: tuple[np.ndarray, np.ndarray],
        max_region_dim: int,
    ) -> tuple[np.ndarray, float, float, float, float]:
        """Fetch a region clamped to the image, downsampled to fit
        max_region_dim per side.

        Args:
            frame: Frame index.
            bounds: ((min_x, min_y), (max_x, max_y)) region corners in
                image pixel coordinates; clamped to the image size.
            max_region_dim: Maximum output size per side.

        Returns:
            (region, left, top, scale_x, scale_y) where
            region_x = (image_x - left) * scale_x.
        """
        self._dataset._ensure_metadata()
        left = max(0.0, float(bounds[0][0]))
        top = max(0.0, float(bounds[0][1]))
        right = min(float(self._dataset._tiles["sizeX"]), float(bounds[1][0]))
        bottom = min(
            float(self._dataset._tiles["sizeY"]), float(bounds[1][1])
        )
        if right <= left or bottom <= top:
            raise ValueError("line is entirely outside the image")
        kwargs: dict = {
            "left": left, "top": top, "right": right, "bottom": bottom,
        }
        region_width = right - left
        region_height = bottom - top
        scale = min(1.0, max_region_dim / max(region_width, region_height))
        if scale < 1.0:
            kwargs["width"] = round(region_width * scale)
            kwargs["height"] = round(region_height * scale)
        region = _drop_single_band(self._get_region(frame, **kwargs))
        # The server preserves the aspect ratio, so the effective scale can
        # differ slightly from the requested one — use the returned size
        return (
            region,
            left,
            top,
            region.shape[1] / region_width,
            region.shape[0] / region_height,
        )

    def iter_frames(self) -> Iterator[tuple[FrameInfo, np.ndarray]]:
        """Iterate over all frames in the dataset.

        Yields:
            (FrameInfo, 2D numpy array) tuples.
        """
        for fi in self._dataset.frames:
            img = self.get(
                xy=fi.xy, z=fi.z, time=fi.time, channel=fi.channel
            )
            yield fi, img

    def new_writer(self, copy_metadata: bool = True):
        """Create an ImageWriter for writing processed images.

        Requires the [worker] extra (large_image).
        """
        try:
            import large_image  # noqa: F401
        except ImportError:
            raise ImportError(
                "ImageWriter requires large_image. "
                "Install with: pip install nimbusimage[worker]"
            )
        return ImageWriter(self._dataset, copy_metadata=copy_metadata)


def _bilinear_sample(
    region: np.ndarray, x: np.ndarray, y: np.ndarray
) -> np.ndarray:
    """Bilinearly interpolate region values at fractional pixel coordinates.

    Args:
        region: (H, W) or (H, W, bands) array. Multi-band pixels (e.g. RGB
            sources) are averaged over the first three bands, ignoring a
            potential alpha band.
        x, y: (N,) fractional pixel coordinates into region.

    Returns:
        (N,) float64 values, NaN where (x, y) is outside the region.
    """
    if region.ndim == 3:
        region = region[:, :, : min(region.shape[2], 3)].mean(axis=2)
    region = region.astype(np.float64)
    height, width = region.shape

    inside = (x >= 0) & (y >= 0) & (x <= width - 1) & (y <= height - 1)
    # Clamp so indexing is valid everywhere; outside samples become NaN below
    x = np.clip(x, 0, width - 1)
    y = np.clip(y, 0, height - 1)
    x0 = np.floor(x).astype(np.intp)
    y0 = np.floor(y).astype(np.intp)
    x1 = np.minimum(x0 + 1, width - 1)
    y1 = np.minimum(y0 + 1, height - 1)
    fx = x - x0
    fy = y - y0

    values = (
        region[y0, x0] * (1 - fx) * (1 - fy)
        + region[y0, x1] * fx * (1 - fy)
        + region[y1, x0] * (1 - fx) * fy
        + region[y1, x1] * fx * fy
    )
    values[~inside] = np.nan
    return values


# The app's histogram request (GirderAPI.baseHistogramOptions). Its min..max
# is what percentile contrast is a percentage of.
_HISTOGRAM_PARAMS = {
    "bins": 4096,
    "width": 2048,
    "height": 2048,
    "resample": "false",
    "cache": "none",
}


def _drop_single_band(region: np.ndarray) -> np.ndarray:
    """(H, W) from a region of shape (H, W, 1). Unlike squeeze(), never
    drops a spatial axis: a 1-pixel-high crop stays (1, W). Multi-band
    regions keep their band axis."""
    if region.ndim == 3 and region.shape[-1] == 1:
        return region[..., 0]
    return region


def _round_half_up(value: float) -> float:
    """Math.round, as d3's rangeRound uses (Python's round() is half-even)."""
    return float(math.floor(value + 0.5))


def _slice_indexes(
    slice_setting: dict | None, current: int, size: int
) -> list[int] | None:
    """Indexes a layer reads on one axis, as the frontend's resolveSlice /
    getLayerSliceIndexes resolve them: every index for max-merge, else
    one; None when the layer resolves outside the axis (it is not drawn).
    A single-entry axis always reads index 0."""
    kind = (slice_setting or {}).get("type", "current")
    value = (slice_setting or {}).get("value") or 0
    if size <= 1:
        return [0]
    if kind == "max-merge":
        return list(range(size))
    index = {"constant": value, "offset": current + value}.get(kind, current)
    return [index] if 0 <= index < size else None


def _parse_color(color: str) -> tuple[float, float, float]:
    """Parse a color string to (r, g, b) floats in [0, 1].

    Supports 'white', 'rgb(r,g,b)', and '#RRGGBB' formats.
    Warns and returns white for unrecognized formats.
    """
    import warnings

    if color == "white":
        return (1.0, 1.0, 1.0)
    if color.startswith("rgb("):
        parts = color[4:-1].split(",")
        return (
            int(parts[0].strip()) / 255.0,
            int(parts[1].strip()) / 255.0,
            int(parts[2].strip()) / 255.0,
        )
    if color.startswith("#") and len(color) == 7:
        return (
            int(color[1:3], 16) / 255.0,
            int(color[3:5], 16) / 255.0,
            int(color[5:7], 16) / 255.0,
        )
    warnings.warn(
        f"Unrecognized color format '{color}', defaulting to white. "
        f"Supported formats: 'white', 'rgb(r,g,b)', '#RRGGBB'.",
        stacklevel=2,
    )
    return (1.0, 1.0, 1.0)


class ImageWriter:
    """Write processed images back to the dataset.

    Requires the [worker] extra (large_image package).
    Can be used as a context manager or explicitly.
    """

    def __init__(self, dataset: Dataset, copy_metadata: bool = True):
        import large_image

        self._dataset = dataset
        self._sink = large_image.new()
        self._metadata: dict = {}
        self._filename = "output.tiff"
        self._written = False

        if copy_metadata:
            dataset._ensure_metadata()
            tiles = dataset._tiles
            if tiles:
                self._sink.channelNames = tiles.get("channels", [])
                if tiles.get("mm_x"):
                    self._sink.mm_x = tiles["mm_x"]
                if tiles.get("mm_y"):
                    self._sink.mm_y = tiles["mm_y"]
                if tiles.get("magnification"):
                    self._sink.magnification = tiles["magnification"]

    def add_frame(self, image: np.ndarray, **kwargs) -> None:
        """Add a frame to the output.

        kwargs should include c, z, t, xy for frame positioning.
        """
        self._sink.addTile(image, 0, 0, **kwargs)

    def set_metadata(self, **kwargs) -> None:
        """Set metadata that will be added to the uploaded item."""
        self._metadata.update(kwargs)

    def write(self, filename: str = "output.tiff") -> None:
        """Write the TIFF and upload to the dataset folder."""
        if self._written:
            return
        import os
        import tempfile

        self._filename = filename
        path = os.path.join(tempfile.gettempdir(), filename)
        self._sink.write(path)

        gc = self._dataset._gc
        item = gc.uploadFileToFolder(self._dataset._id, path)
        if self._metadata and item:
            item_id = item.get("itemId", item.get("_id"))
            if item_id:
                gc.addMetadataToItem(item_id, self._metadata)

        os.remove(path)
        self._written = True

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type is None:
            self.write(self._filename)
        return False
