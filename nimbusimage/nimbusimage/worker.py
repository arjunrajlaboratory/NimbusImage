"""WorkerContext — helper for Docker worker scripts."""

from __future__ import annotations

import json
import re
import sys
import urllib.parse
from typing import Iterator, TYPE_CHECKING

import numpy as np

from nimbusimage._girder import create_client
from nimbusimage.dataset import Dataset
from nimbusimage.models import Annotation, Location

if TYPE_CHECKING:
    pass


class WorkerContext:
    """Context for a NimbusImage worker execution.

    Parses worker parameters, provides typed access to interface values,
    messaging helpers, and batch processing utilities.
    """

    def __init__(
        self,
        dataset_id: str | None = None,
        api_url: str | None = None,
        token: str | None = None,
        params: dict | None = None,
    ):
        self._gc = create_client(api_url=api_url, token=token)
        self._params = params or {}
        self._dataset_id = dataset_id

        # Parse tags — normalize from either list or dict format
        raw_tags = self._params.get("tags", [])
        if isinstance(raw_tags, dict):
            self._tags = raw_tags.get("tags", [])
            self._exclusive_tags = raw_tags.get("exclusive", False)
        else:
            self._tags = list(raw_tags)
            self._exclusive_tags = False

        # Lazy dataset
        self._dataset: Dataset | None = None

    @property
    def dataset(self) -> Dataset:
        if self._dataset is None:
            if self._dataset_id is None:
                raise ValueError("No dataset_id provided to WorkerContext")
            self._dataset = Dataset(self._gc, self._dataset_id)
        return self._dataset

    @property
    def interface(self) -> dict:
        return self._params.get("workerInterface", {})

    @property
    def tags(self) -> list[str]:
        return self._tags

    @property
    def exclusive_tags(self) -> bool:
        return self._exclusive_tags

    @property
    def tile(self) -> Location:
        return Location.from_dict(self._params.get("tile", {}))

    @property
    def channel(self) -> int:
        return self._params.get("channel", 0)

    @property
    def scales(self) -> dict:
        return self._params.get("scales", {})

    @property
    def connect_to(self) -> dict | None:
        return self._params.get("connectTo")

    @property
    def params(self) -> dict:
        return self._params

    # --- Messaging ---

    def progress(
        self, fraction: float, title: str = "", info: str = ""
    ) -> None:
        print(json.dumps({
            "progress": fraction, "title": title, "info": info
        }))
        sys.stdout.flush()

    def warning(
        self, message: str, title: str = "Warning", info: str | None = None
    ) -> None:
        print(json.dumps({
            "warning": message, "title": title, "info": info,
            "type": "warning",
        }))
        sys.stdout.flush()

    def error(
        self, message: str, title: str = "Error", info: str | None = None
    ) -> None:
        print(json.dumps({
            "error": message, "title": title, "info": info,
            "type": "error",
        }))
        sys.stdout.flush()

    # --- Batch processing ---

    def batch_locations(self) -> Iterator[Location]:
        """Yield Location objects for each position in the assignment ranges.

        Parses range strings like "0-2" or "1-3, 5-8" from the
        assignment dict.
        """
        assignment = self._params.get("assignment", {})
        xy_range = _parse_range(assignment.get("XY", 0))
        z_range = _parse_range(assignment.get("Z", 0))
        time_range = _parse_range(assignment.get("Time", 0))

        for t in time_range:
            for z in z_range:
                for xy in xy_range:
                    yield Location(xy=xy, z=z, time=t)

    def get_filtered_annotations(
        self, shape: str | None = None
    ) -> list[Annotation]:
        """Get annotations filtered by this worker's tag configuration."""
        from nimbusimage.filters import filter_by_tags

        anns = self.dataset.annotations.list(shape=shape)
        if self._tags:
            anns = filter_by_tags(
                anns, self._tags, exclusive=self._exclusive_tags
            )
        return anns

    def submit_property_values(
        self, property_id: str, values: dict[str, dict]
    ) -> None:
        """Submit property values via the dataset's property accessor."""
        self.dataset.properties.submit_values(property_id, values)

    # --- Interface registration ---

    def set_interface(self, image: str, interface: dict) -> None:
        """Register worker interface metadata for a Docker image."""
        encoded_image = urllib.parse.quote(image, safe="")
        self._gc.post(
            f"/worker_interface?image={encoded_image}",
            json=interface,
        )

    def batch_process(
        self,
        process_fn,
        output_shape: str = "polygon",
        channels: list[int] | None = None,
        stack_z: bool = False,
        progress_text: str = "Processing",
    ) -> None:
        """High-level batch processing.

        Iterates batch_locations, loads images (stacking channels/z as
        requested), calls process_fn, creates annotations from results,
        and optionally connects them.

        Args:
            process_fn: Callable that takes ndarray and returns
                annotation coordinate data.
            output_shape: 'polygon' or 'point'.
            channels: Channel indices to stack. None = use self.channel.
            stack_z: Whether to stack all z-planes.
            progress_text: Text shown in progress bar.
        """
        if channels is None:
            channels = [self.channel]

        locations = list(self.batch_locations())
        total = len(locations)

        all_annotations = []

        for i, loc in enumerate(locations):
            self.progress(i / max(total, 1), progress_text,
                          f"{i + 1}/{total}")

            # Load and stack images
            if len(channels) == 1 and not stack_z:
                image = self.dataset.images.get(
                    xy=loc.xy, z=loc.z, time=loc.time, channel=channels[0]
                )
            else:
                imgs = []
                for ch in channels:
                    if stack_z:
                        stack = self.dataset.images.get_stack(
                            xy=loc.xy, time=loc.time, channel=ch, axis="z"
                        )
                        imgs.append(stack)
                    else:
                        imgs.append(self.dataset.images.get(
                            xy=loc.xy, z=loc.z, time=loc.time, channel=ch
                        ))
                image = np.stack(imgs, axis=0) if len(imgs) > 1 else imgs[0]

            # Run model
            result = process_fn(image)

            # Convert result to annotations
            if result is not None:
                for coords in result:
                    ann = Annotation(
                        id=None, shape=output_shape,
                        tags=self._tags, channel=channels[0],
                        location=loc,
                        coordinates=coords if isinstance(coords, list) else [],
                        dataset_id=self._dataset_id,
                    )
                    all_annotations.append(ann)

        # Bulk create
        if all_annotations:
            self.dataset.annotations.create_many(
                all_annotations, connect_to=self.connect_to
            )

        self.progress(1.0, progress_text, "Complete")


def _parse_range(value) -> list[int]:
    """Parse a range value — int, str like "0-2", or "1-3, 5-8"."""
    if isinstance(value, int):
        return [value]
    if isinstance(value, str):
        result = []
        for part in value.split(","):
            part = part.strip()
            if "-" in part:
                start, end = part.split("-", 1)
                result.extend(range(int(start), int(end) + 1))
            else:
                result.append(int(part))
        return result
    return [int(value)]
