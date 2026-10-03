"""ImageAccessor — image retrieval, stacking, compositing."""

from __future__ import annotations

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

    def _frame_index(
        self, channel: int = 0, time: int = 0, z: int = 0, xy: int = 0
    ) -> int:
        self._ensure_frame_map()
        return self._frame_map[channel][time][z][xy]

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
    ) -> np.ndarray:
        """Get a single image frame as a 2D numpy array.

        Always returns a squeezed 2D array.

        Args:
            xy, z, time, channel: Coordinates.
            crop: Optional (left, top, right, bottom) crop region.

        Returns:
            2D numpy array.
        """
        frame = self._frame_index(channel, time, z, xy)
        kwargs = {}
        if crop is not None:
            left, top, right, bottom = crop
            kwargs.update({
                "left": left, "top": top,
                "right": right, "bottom": bottom,
            })
        img = self._get_region(frame, **kwargs)
        return img.squeeze()

    def get_all_channels(
        self, xy: int = 0, z: int = 0, time: int = 0
    ) -> list[np.ndarray]:
        """Get all channels at one location as a list of 2D arrays."""
        self._dataset._ensure_metadata()
        n_ch = self._dataset.num_channels
        return [
            self.get(xy=xy, z=z, time=time, channel=ch)
            for ch in range(n_ch)
        ]

    def get_stack(
        self,
        xy: int = 0,
        z: int = 0,
        time: int = 0,
        channel: int = 0,
        axis: str = "z",
    ) -> np.ndarray:
        """Get a stack along one axis as a 3D array.

        Args:
            axis: 'z' or 'time'. The other coordinates are fixed.

        Returns:
            3D numpy array: (N, H, W) where N is the axis size.
        """
        self._dataset._ensure_metadata()
        if axis == "z":
            n = self._dataset.num_z
            images = [
                self.get(xy=xy, z=i, time=time, channel=channel)
                for i in range(n)
            ]
        elif axis == "time":
            n = self._dataset.num_time
            images = [
                self.get(xy=xy, z=z, time=i, channel=channel)
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
    ) -> np.ndarray:
        """Get a composite RGB image merging visible channels.

        Uses layer settings from ds.collections.layers for contrast and color.

        Args:
            mode: Blend mode ('lighten' default).
            dtype: Output dtype. None = match source. 'float64' = [0,1].
                'uint8' = [0,255].

        Returns:
            (H, W, 3) numpy array.
        """
        self._dataset._ensure_metadata()
        source_dtype = self._dataset.dtype
        target_dtype = dtype or source_dtype

        layers = self._dataset.collections.layers
        h, w = self._dataset.shape
        composite = np.zeros((h, w, 3), dtype=np.float64)

        for layer in layers:
            ch = layer.get("channel", 0)
            if not layer.get("visible", True):
                continue

            img = self.get(xy=xy, z=z, time=time, channel=ch).astype(
                np.float64
            )

            # Apply contrast — percentile-based blackPoint/whitePoint
            contrast = layer.get("contrast", {})
            bp = contrast.get("blackPoint", 0)
            wp = contrast.get("whitePoint", 100)
            if contrast.get("mode") == "percentile":
                cmin = float(np.percentile(img, bp))
                cmax = float(np.percentile(img, wp))
            else:
                # Absolute values or fallback
                cmin = float(bp)
                cmax = float(wp) if wp > 1 else float(img.max() or 1)
            if cmax > cmin:
                img = (img - cmin) / (cmax - cmin)
            img = np.clip(img, 0.0, 1.0)

            # Apply pseudocolor
            color = layer.get("color", "white")
            r, g, b = _parse_color(color)

            channel_rgb = np.stack([img * r, img * g, img * b], axis=-1)

            if mode == "lighten":
                composite = np.maximum(composite, channel_rgb)
            else:
                composite += channel_rgb

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
        region = self._get_region(frame, **kwargs).squeeze()
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
