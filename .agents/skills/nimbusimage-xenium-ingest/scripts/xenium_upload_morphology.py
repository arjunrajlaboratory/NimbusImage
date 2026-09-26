#!/usr/bin/env python3
"""Create a NimbusImage dataset from a Xenium bundle's morphology images,
with channels named after their stains.

`morphology_focus/` holds one logical multi-channel image split across one
OME-TIFF per channel. Their file names do not carry usable channel names:
XOA 1-3 ships `morphology_focus_000{0..3}.ome.tif`, and XOA 4 ships
`ch0000_dapi.ome.tif`, `ch0001_atp1a1_cd45_e-cadherin.ome.tif`, ..., which
NimbusImage's filename parser splits on `_` into `ch0000`, `ch0001`, .... The
stain names are in every file's OME metadata (`<Channel Name="DAPI">`, with
the file each channel lives in), so this uploads copies named
`c00-DAPI.ome.tif`, `c01-ATP1A1+CD45+E-Cadherin.ome.tif`, ... and pins the
channel dimension to that name. The two-digit prefix keeps channel order
(values are sorted as text; the protein panel has 12 channels); `/` and `_`
would split a name into tokens, so they become `+` and `-`.

    python xenium_upload_morphology.py --bundle-dir extracted/ --name "Lymph node"
    python xenium_upload_morphology.py --bundle-dir extracted/ --name "Lymph node" \\
        --parent-folder <folderId>

Prints the dataset (folder) id the other scripts take as --dataset. Waits for
the transcode job unless --no-wait.
"""
from __future__ import annotations

import argparse
import re
import sys
import tempfile
from pathlib import Path

import tifffile

from xenium_common import connect, log

_CHANNEL = re.compile(r"<Channel\b[^>]*>", re.S)
_ATTRIBUTE = re.compile(r'(\w+)="([^"]*)"')
_TIFF_DATA = re.compile(
    r"<TiffData\b([^>]*)>\s*<UUID\b([^>]*)>", re.S
)


def channel_names(files: list[Path]) -> dict[Path, str]:
    """Stain name per file, from the first file's OME metadata (every file of
    the set carries the whole multi-file description)."""
    xml = tifffile.TiffFile(files[0]).ome_metadata or ""
    names = [
        dict(_ATTRIBUTE.findall(match.group(0))).get("Name")
        for match in _CHANNEL.finditer(xml)
    ]
    # Which file holds which channel: TiffData FirstC -> UUID FileName.
    byFile = {}
    for tiffData, uuid in _TIFF_DATA.findall(xml):
        first = dict(_ATTRIBUTE.findall(tiffData)).get("FirstC")
        fileName = dict(_ATTRIBUTE.findall(uuid)).get("FileName")
        if first is not None and fileName:
            byFile[fileName] = int(first)
    result = {}
    for order, path in enumerate(files):
        index = byFile.get(path.name, order)
        name = names[index] if index < len(names) and names[index] else None
        result[path] = name or path.name.split(".")[0]
    return result


def staged_name(index: int, stain: str) -> str:
    safe = re.sub(r"[/\\]", "+", stain)
    safe = re.sub(r"[\s_]+", "-", safe).strip("-")
    return f"c{index:02d}-{safe}.ome.tif"


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--bundle-dir", type=Path, required=True)
    parser.add_argument("--name", required=True, help="dataset name")
    parser.add_argument("--parent-folder", default=None,
                        help="folder to create the dataset in (default: "
                        "the caller's Private folder)")
    parser.add_argument("--no-wait", action="store_true",
                        help="return once the transcode job is queued")
    args = parser.parse_args()

    files = sorted((args.bundle_dir / "morphology_focus").glob("*.ome.tif"))
    if not files:
        raise SystemExit(f"no morphology_focus/*.ome.tif in {args.bundle_dir}")
    names = channel_names(files)
    for path in files:
        log(f"  {path.name} -> {names[path]}")

    client = connect()
    dataset = client.create_dataset(
        args.name, parent_folder_id=args.parent_folder
    )
    with tempfile.TemporaryDirectory() as stage:
        for index, path in enumerate(files):
            (Path(stage) / staged_name(index, names[path])).symlink_to(
                path.resolve()
            )
        dataset.upload(stage)

    # The staged names have one varying token; make it the channel axis
    # whatever the filename heuristics guessed for it.
    dry = dataset.configure(dry_run=True)
    variable = next(
        (v for v in dry.variables
         if v.get("source") == "filename" and v.get("size") == len(files)),
        None,
    )
    if variable is None:
        raise SystemExit(f"no filename variable of size {len(files)}: "
                         f"{dry.variables}")
    result = dataset.configure(assignments={
        "C": {"source": variable["source"], "guess": variable["guess"]},
    })
    log(f"  channels: {result.config['channels']}")
    if result.job_id and not args.no_wait:
        log("  waiting for the transcode job")
        if not client.job(result.job_id).wait():
            raise SystemExit("transcode job failed")
    print(dataset.id)
    return 0


if __name__ == "__main__":
    sys.exit(main())
