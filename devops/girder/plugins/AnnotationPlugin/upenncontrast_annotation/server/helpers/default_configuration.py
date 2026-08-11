"""Pure-Python port of the default *configuration* the frontend creates
for a new dataset (``defaultConfigurationBase`` in
``src/store/GirderAPI.ts``, plus ``newLayer`` / ``getDatasetCompatibility``
/ ``getDatasetScales`` in ``src/store/model.ts`` and
``inferZStepFromDimensionLabelsUm`` in ``src/utils/dimensionLabels.ts``).

The multi-source endpoint uses this to create a collection and dataset view
alongside the configured dataset, so an API-created dataset is listable and
openable in the web UI exactly like one made through it.

Only the *fresh* case is ported -- layers built from an empty list, in
channel order -- which is the only case this endpoint has. That collapses
``newLayer``'s "next unused channel / next unused colour" searches into an
index walk; ``test_default_configuration.py`` pins the equivalence.

Like the other helpers here, everything is a pure function over plain
JSON-compatible values and raises ``ValueError`` at most, never
``RestException``.
"""

import re
import uuid

# Transcribed from `colors` in src/store/model.ts. test_default_configuration
# re-parses that file and fails if these drift, so do not hand-edit either
# side without running the backend tests.
COLORS = [
    "#FF0000", "#00FF00", "#0000FF", "#FFFF00",
    "#FF00FF", "#00FFFF", "#FF8000", "#FF0080",
    "#00FF80", "#80FF00", "#8000FF", "#0080FF",
    "#FF8080", "#80FF80", "#8080FF", "#FFFF80",
    "#80FFFF", "#FF80FF", "#FF4000", "#FF0040",
    "#00FF40", "#40FF00", "#4000FF", "#0040FF",
    "#FF4040", "#40FF40", "#4040FF", "#FFFF40",
    "#40FFFF", "#FF40FF", "#FFC000", "#FF00C0",
    "#00FFC0", "#C0FF00", "#C000FF", "#00C0FF",
    "#FFC0C0", "#C0FFC0", "#C0C0FF", "#FFFFC0",
    "#C0FFFF", "#FFC0FF", "#FF8040", "#FF4080",
    "#40FF80", "#80FF40", "#8040FF", "#4080FF",
    "#FF80C0", "#FFC080", "#C0FF80", "#80FFC0",
    "#80C0FF", "#C080FF", "#FFC040", "#FF40C0",
    "#40FFC0", "#C0FF40", "#C040FF", "#40C0FF",
]

# Transcribed from `channelColors` in src/store/model.ts, with the COLOR.*
# enum resolved. Keys are upper-case channel names.
CHANNEL_COLORS = {
    "BRIGHTFIELD": "#FFFFFF",
    "DIC": "#FFFFFF",
    "PHASE": "#FFFFFF",
    "TRANSMISSION": "#FFFFFF",
    "TRANS": "#FFFFFF",
    "DAPI": "#007FFF",
    "CY3": "#FFEE00",
    "TMR": "#FFEE00",
    "TAMRA": "#FFEE00",
    "A594": "#FF9933",
    "ALEXA594": "#FF9933",
    "CY5": "#FF0000",
    "ATTO647": "#FF0000",
    "ATTO647N": "#FF0000",
    "CY7": "#FF33CC",
    "ATTO700": "#FF33CC",
    "A700": "#FF33CC",
    "YFP": "#52FF00",
    "GFP": "#00FF28",
    "DEFAULT": "#FFFFFF",
    "MCHERRY": "#FFAD00",
    "CHERRY": "#FFAD00",
    "A488": "#4AFF00",
    "ATTO488": "#4AFF00",
    "ALEXA488": "#4AFF00",
    "FITC": "#4AFF00",
    "TRITC": "#FFFF00",
    "BFP": "#0000FF",
    "MORANGE": "#C9FF00",
    "MKATE": "#FF3900",
    "CFP": "#00C0FF",
    "RED": "#FF0000",
    "GREEN": "#00FF00",
    "BLUE": "#0000FF",
}

_DEFAULT_SCALES = {
    "pixelSize": {"value": 1, "unit": "m"},
    "zStep": {"value": 1, "unit": "m"},
    "tStep": {"value": 1, "unit": "s"},
}

# Port of normalizeLengthUnit: every spelling the frontend accepts, mapped
# to its factor in microns. GREEK SMALL LETTER MU (U+03BC) is normalized to
# MICRO SIGN (U+00B5) first, exactly as the frontend does.
_LENGTH_UNITS_TO_UM = {
    "nm": 1e-3, "nanometer": 1e-3, "nanometers": 1e-3,
    "\u00b5m": 1.0, "um": 1.0, "micron": 1.0, "microns": 1.0,
    "micrometer": 1.0, "micrometers": 1.0,
    "mm": 1e3, "millimeter": 1e3, "millimeters": 1e3,
    "m": 1e6, "meter": 1e6, "meters": 1e6,
}
# Mirrors /^([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-zA-Z\u00b5\u03bc]+)$/ applied to
# the trimmed label.
_LENGTH_LABEL = re.compile(
    r"^([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-zA-Z\u00b5\u03bc]+)$"
)


def parse_length_label_um(label):
    """Port of ``parseLengthLabelUm``: "-2.7 \u00b5m" -> -2.7 (microns)."""
    if not isinstance(label, str):
        return None
    match = _LENGTH_LABEL.match(label.strip())
    if not match:
        return None
    unit = match.group(2).strip().lower().replace("\u03bc", "\u00b5")
    if unit not in _LENGTH_UNITS_TO_UM:
        return None
    return float(match.group(1)) * _LENGTH_UNITS_TO_UM[unit]


def _median_positive_spacing(positions):
    """Port of ``medianPositiveSpacing`` + ``median``.

    NOTE the frontend's ``median`` is the UPPER median -- it indexes
    ``sorted[floor(n / 2)]`` and does not average the middle pair on an
    even count. Reproduce that, not the textbook median.
    """
    spacings = sorted(
        abs(b - a) for a, b in zip(positions, positions[1:])
        if abs(b - a) > 0 and abs(b - a) != float("inf")
    )
    if not spacings:
        return None
    return spacings[len(spacings) // 2]


def infer_z_step_um(dimension_labels):
    """Port of ``inferZStepFromDimensionLabelsUm``."""
    labels = (dimension_labels or {}).get("z")
    if not labels or len(labels) < 2:
        return None
    positions = [parse_length_label_um(label) for label in labels]
    if any(position is None for position in positions):
        return None
    return _median_positive_spacing(positions)


def build_default_layers(channel_names, id_factory=None):
    """Port of ``getDefaultLayers`` (at most six layers, one per channel).

    ``id_factory`` exists so tests can pin ids; production uses uuid4 like
    the frontend.
    """
    new_id = id_factory or (lambda: str(uuid.uuid4()))
    layers = []
    for index in range(min(6, len(channel_names))):
        # newLayer picks the first unused channel and, for a fresh
        # configuration, that is always this index.
        name = channel_names[index] or "Channel %d" % index
        used_colors = {layer["color"] for layer in layers}

        color = CHANNEL_COLORS.get(name.upper())
        if not color or color in used_colors:
            unused = [c for c in COLORS if c not in used_colors]
            color = unused[0] if unused else COLORS[len(layers) % len(COLORS)]

        layer_name = name
        if layer_name == "" or any(
            layer["name"] == layer_name for layer in layers
        ):
            layer_name = "Layer %d" % (len(layers) + 1)

        layers.append({
            "id": new_id(),
            "name": layer_name,
            "visible": True,
            "channel": index,
            "time": {"type": "current", "value": None},
            "xy": {"type": "current", "value": None},
            "z": {"type": "current", "value": None},
            "color": color,
            "contrast": {
                "mode": "percentile", "blackPoint": 0, "whitePoint": 100,
            },
            "layerGroup": None,
        })
    return layers


def build_compatibility(channel_names, xy_count, z_count, t_count):
    """Port of ``getDatasetCompatibility``."""
    return {
        "xyDimensions": "multiple" if xy_count > 1 else "one",
        "zDimensions": "multiple" if z_count > 1 else "one",
        "tDimensions": "multiple" if t_count > 1 else "one",
        "channels": {
            str(index): name or "Unnamed channel"
            for index, name in enumerate(channel_names)
        },
    }


def build_scales(mm_x, mm_y, dimension_labels, has_tile_metadata=True):
    """Port of ``getDatasetScales``.

    The frontend gates only on *having* tile info -- ``if (tileInfo)`` --
    and then takes ``(mm_x + mm_y) / 2`` unconditionally, so a source with
    no physical pixel size records ``{value: 0, unit: "mm"}``. Keeping the
    1 m/pixel default instead would be a visible divergence: the viewer
    renders a distance scale bar from it and claims a 7920 px image is
    kilometres across.
    """
    scales = {key: value.copy() for key, value in _DEFAULT_SCALES.items()}
    if has_tile_metadata:
        scales["pixelSize"] = {
            "value": ((mm_x or 0) + (mm_y or 0)) / 2, "unit": "mm",
        }
    z_step_um = infer_z_step_um(dimension_labels)
    if z_step_um is not None and z_step_um > 0:
        scales["zStep"] = {"value": z_step_um, "unit": "\u00b5m"}
    return scales


def build_default_configuration(channel_names, *, xy_count, z_count,
                                t_count, mm_x=None, mm_y=None,
                                dimension_labels=None, id_factory=None):
    """Port of ``defaultConfigurationBase`` + the ``subtype`` the frontend
    adds in ``createConfigurationFromBase``. Returns collection metadata.
    """
    return {
        "subtype": "contrastConfiguration",
        "compatibility": build_compatibility(
            channel_names, xy_count, z_count, t_count,
        ),
        "layers": build_default_layers(channel_names, id_factory=id_factory),
        "tools": [],
        "propertyIds": [],
        "snapshots": [],
        "pipelines": [],
        "scales": build_scales(mm_x, mm_y, dimension_labels),
    }
