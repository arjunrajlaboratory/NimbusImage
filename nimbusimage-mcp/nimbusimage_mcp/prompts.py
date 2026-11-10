"""Workflow starters (MCP prompts): clients list them for the user to
pick, and each expands into a request that names the tools to use."""

from __future__ import annotations


def explore_dataset(dataset: str) -> str:
    """Get oriented in a dataset: its channels and dimensions, what has
    been annotated and measured, and a look at the image."""
    return (
        f"Give me an overview of my NimbusImage dataset \"{dataset}\". "
        "Find it with ni_datasets_list, then use ni_dataset_info, "
        "ni_annotations_summary, and ni_properties_list, and show me the "
        "image with ni_image_get_composite. Summarize the channels, "
        "z-slices and time points, what is annotated and measured, and "
        "what I could do next. Include the app link."
    )


def segment_and_count(dataset: str, channel: str = "DAPI",
                      tag: str = "nucleus") -> str:
    """Segment nuclei or cells with a worker and count them, per
    z-slice and, after linking across z, per object."""
    return (
        f"In my NimbusImage dataset \"{dataset}\", segment the {channel} "
        f"channel with a suitable segmentation worker (ni_workers_list, "
        f"ni_worker_interface), tagging the results \"{tag}\". Ask me "
        "before running it. Then count the results per z-slice, show me "
        f"a slice with the \"{tag}\" outlines drawn "
        "(ni_image_get_composite with outline_tags), and give me the app "
        "link. If the dataset has several z-slices, explain that the "
        "count is per slice and offer to link objects across z and count "
        "them with ni_connections_summary."
    )


def spots_per_cell(dataset: str, spot_channel: str,
                   cell_tag: str = "cell") -> str:
    """Detect spots (e.g. HCR or smFISH) in a channel and count them in
    each cell."""
    return (
        f"In my NimbusImage dataset \"{dataset}\", detect spots in the "
        f"{spot_channel} channel with a suitable spot-detection worker, "
        f"then measure how many spots fall in each \"{cell_tag}\" "
        "annotation with a measurement (property) worker. Ask me before "
        "running anything. Show me a maximum projection of the spot "
        "channel (ni_image_get_channel, projection=\"max\") and the "
        "distribution of spots per cell (ni_property_histogram), and "
        "give me the CSV download link (ni_export_links)."
    )


PROMPTS = [explore_dataset, segment_and_count, spots_per_cell]
