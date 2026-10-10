"""
Full-bit-depth TIFF of an image region.

large_image's own ``item/{id}/tiles/region?encoding=TIFF`` passes every image
through PIL, which floor-divides uint16 samples by 256 and returns uint8: a
dim 16-bit plane (say 59-733) arrives as 0-2 and looks blank. Its
``encoding=TILED`` keeps the dtype but returns a pyramidal, LZW-compressed
BigTIFF. This endpoint reads the region as a numpy array and writes it as a
single-page, uncompressed TIFF in the source's own dtype, which is what the
raw-channel snapshot download and the line scan need.
"""

import io
import math

import numpy as np
import tifffile
from girder.api import access
from girder.api.describe import Description, autoDescribeRoute
from girder.api.rest import boundHandler, setRawResponse, setResponseHeader
from girder.constants import AccessType, TokenScope
from girder.exceptions import RestException
from girder.models.item import Item
from girder_large_image.models.image_item import ImageItem
from large_image.constants import TILE_FORMAT_NUMPY
from large_image.exceptions import TileGeneralError

from ..helpers.validation import requireFloat

# Output sample bytes per request. The samples are held in memory more than
# once (array, TIFF buffer, response bytes), and this is a public route. Fits
# the client's 4M-pixel snapshot limit at up to 16 bytes per pixel (RGBA
# float32), and the line scan's 2048^2 single-band reads with room to spare.
MAX_RAW_REGION_BYTES = 64 * 1024 * 1024


def encodeRawTiff(image):
    """Encode a numpy region (height x width [x bands]) as an uncompressed,
    single-page TIFF in its own dtype."""
    if image.ndim == 3 and image.shape[2] == 1:
        image = image[:, :, 0]
    photometric = (
        "rgb" if image.ndim == 3 and image.shape[2] in (3, 4)
        else "minisblack"
    )
    buffer = io.BytesIO()
    tifffile.imwrite(
        buffer, image, photometric=photometric, metadata=None,
        compression=None,
        # Without it, tifffile writes an H x W x 2 (or 5+) minisblack array
        # as H pages of W x bands instead of one page of interleaved bands
        planarconfig="contig" if image.ndim == 3 else None,
    )
    return buffer.getvalue()


def _clampRegion(metadata, **bounds):
    """Validate and clamp region bounds to the image; 400 if empty."""
    region = {}
    for name, value in bounds.items():
        # autoDescribeRoute accepts nan/inf, which large_image turns into a
        # 500 (OverflowError)
        size = metadata["sizeX" if name in ("left", "right") else "sizeY"]
        region[name] = min(max(requireFloat(value, name), 0), size)
    if (
        region["right"] - region["left"] < 1
        or region["bottom"] - region["top"] < 1
    ):
        raise RestException("The region contains no image pixels.")
    return region


def _outputLimits(region, width, height):
    """large_image output limits, clamped to the region: output is never
    upsampled, and an unbounded integer (say 10**309) would otherwise
    overflow float arithmetic into a 500."""
    output = {}
    for name, key, size, regionSize in (
        ("width", "maxWidth", width, region["right"] - region["left"]),
        ("height", "maxHeight", height, region["bottom"] - region["top"]),
    ):
        if size is not None:
            # A 0 size makes large_image raise a TypeError (a 500)
            if size < 1:
                raise RestException("%s must be at least 1." % name)
            output[key] = min(size, math.ceil(regionSize))
    return output


def _requireOutputWithinLimit(metadata, region, output):
    """Refuse before reading pixels when the (never upsampled) output would
    exceed MAX_RAW_REGION_BYTES. Without dtype or band metadata, assume the
    widest case (four float64 bands) rather than under-count."""
    regionWidth = region["right"] - region["left"]
    regionHeight = region["bottom"] - region["top"]
    scale = min(
        1,
        output.get("maxWidth", regionWidth) / regionWidth,
        output.get("maxHeight", regionHeight) / regionHeight,
    )
    pixels = math.ceil(regionWidth * scale) * math.ceil(regionHeight * scale)
    # large_image always sets these keys, but before a tile has been read
    # dtype can be None or the string "None", and np.dtype("None") raises
    try:
        sampleBytes = np.dtype(metadata.get("dtype")).itemsize
    except TypeError:
        sampleBytes = np.dtype("float64").itemsize
    bytesPerPixel = sampleBytes * (metadata.get("bandCount") or 4)
    if pixels * bytesPerPixel > MAX_RAW_REGION_BYTES:
        raise RestException(
            "The region would return %d bytes of samples; the maximum is %d. "
            "Request a smaller region or pass width/height to downsample it."
            % (pixels * bytesPerPixel, MAX_RAW_REGION_BYTES)
        )


@access.public(scope=TokenScope.DATA_READ)
@autoDescribeRoute(
    Description(
        "Get a region of one frame of a large image as an uncompressed TIFF "
        "that keeps the source's bit depth."
    )
    .notes(
        "Unlike tiles/region with encoding=TIFF, which converts 16-bit data "
        "to 8 bits, the samples are returned unscaled in the image's own "
        "dtype. Coordinates are in base pixels and are clamped to the "
        "image (negative values are not offsets from the far edge, unlike "
        "tiles/region). If width or height is given, the region is "
        "downsampled to fit (aspect ratio preserved; nearest neighbour from "
        "the level read, which may be a lower, averaged pyramid level); it "
        "is never upsampled. At most %d bytes of output samples per request."
        % MAX_RAW_REGION_BYTES
    )
    .modelParam("itemId", model=Item, level=AccessType.READ)
    .param("left", "Left column (0-based) of the region.", dataType="float")
    .param("top", "Top row (0-based) of the region.", dataType="float")
    .param(
        "right", "Right column of the region (exclusive).", dataType="float"
    )
    .param(
        "bottom", "Bottom row of the region (exclusive).", dataType="float"
    )
    .param(
        "frame", "The 0-based frame number.", required=False,
        dataType="integer", default=0,
    )
    .param(
        "width", "Maximum output width in pixels.", required=False,
        dataType="integer",
    )
    .param(
        "height", "Maximum output height in pixels.", required=False,
        dataType="integer",
    )
    .produces("image/tiff")
    .errorResponse("ID was invalid.")
    .errorResponse("Read access was denied for the item.", 403)
)
@boundHandler()
def getRawRegion(self, item, left, top, right, bottom, frame, width, height):
    try:
        metadata = ImageItem().getMetadata(item)
        region = _clampRegion(
            metadata, left=left, top=top, right=right, bottom=bottom
        )
        output = _outputLimits(region, width, height)
        _requireOutputWithinLimit(metadata, region, output)
        image, _ = ImageItem().getRegion(
            item,
            region={**region, "units": "base_pixels"},
            output=output,
            frame=frame,
            format=TILE_FORMAT_NUMPY,
            # The default (True) downsamples every array other than
            # single-band uint16 through 8-bit PIL; None keeps samples
            resample=None,
        )
    except TileGeneralError as e:
        raise RestException(str(e))
    except ValueError as e:
        raise RestException("Value Error: %s" % e)
    data = encodeRawTiff(image)
    setResponseHeader("Content-Type", "image/tiff")
    setRawResponse()
    return data
