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

# Output pixels per request. Every sample is held in memory twice (array and
# TIFF buffer), and this is a public route. 4096^2 is 4x the client's snapshot
# limit and above the line scan's 2048^2.
MAX_RAW_REGION_PIXELS = 4096 * 4096


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


def _requireOutputWithinLimit(region, width, height):
    """Refuse before reading pixels when the (never upsampled) output would
    exceed MAX_RAW_REGION_PIXELS."""
    regionWidth = region["right"] - region["left"]
    regionHeight = region["bottom"] - region["top"]
    scale = min(
        1,
        width / regionWidth if width is not None else 1,
        height / regionHeight if height is not None else 1,
    )
    pixels = math.ceil(regionWidth * scale) * math.ceil(regionHeight * scale)
    if pixels > MAX_RAW_REGION_PIXELS:
        raise RestException(
            "The region would return %d pixels; the maximum is %d. Request a "
            "smaller region or pass width/height to downsample it."
            % (pixels, MAX_RAW_REGION_PIXELS)
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
        "downsampled (nearest neighbour, aspect ratio preserved) to fit; it "
        "is never upsampled. At most %d output pixels per request."
        % MAX_RAW_REGION_PIXELS
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
    # A 0 size makes large_image raise a TypeError, which would be a 500
    output = {}
    for name, key, size in (
        ("width", "maxWidth", width), ("height", "maxHeight", height)
    ):
        if size is not None:
            if size < 1:
                raise RestException("%s must be at least 1." % name)
            output[key] = size
    try:
        metadata = ImageItem().getMetadata(item)
        region = _clampRegion(
            metadata, left=left, top=top, right=right, bottom=bottom
        )
        _requireOutputWithinLimit(region, width, height)
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
        raise RestException(e.args[0])
    except ValueError as e:
        raise RestException("Value Error: %s" % e.args[0])
    data = encodeRawTiff(image)
    setResponseHeader("Content-Type", "image/tiff")
    setRawResponse()
    return data
