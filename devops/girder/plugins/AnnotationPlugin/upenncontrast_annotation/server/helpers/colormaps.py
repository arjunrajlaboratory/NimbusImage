"""Colormap tables for the color-by-property endpoint.

Continuous colormaps are stored as evenly-spaced hex anchor tables (33
anchors, generated from matplotlib 3.11) and sampled with piecewise-linear
interpolation. The anchor tables double as the legend's gradient stops: the
frontend renders them with a CSS linear-gradient, which interpolates the same
way, so the legend shows exactly the gradient that was applied. No runtime
dependency on matplotlib.
"""

CONTINUOUS_COLORMAPS = {
    "viridis": [
        "#440154", "#470d60", "#48186a", "#482374", "#472d7b", "#453781",
        "#424086", "#3e4989", "#3b528b", "#375b8d", "#33638d", "#2f6b8e",
        "#2c728e", "#297a8e", "#26828e", "#23898e", "#21918c", "#1f988b",
        "#1fa088", "#22a785", "#28ae80", "#32b67a", "#3fbc73", "#4ec36b",
        "#5ec962", "#70cf57", "#84d44b", "#98d83e", "#addc30", "#c2df23",
        "#d8e219", "#ece51b", "#fde725",
    ],
    "plasma": [
        "#0d0887", "#220690", "#310597", "#3f049c", "#4c02a1", "#5901a5",
        "#6600a7", "#7201a8", "#7e03a8", "#8a09a5", "#9511a1", "#a01a9c",
        "#aa2395", "#b32c8e", "#bc3587", "#c43e7f", "#cc4778", "#d35171",
        "#da5a6a", "#e06363", "#e66c5c", "#eb7655", "#f0804e", "#f58b47",
        "#f89540", "#fba139", "#fdac33", "#feb82c", "#fdc527", "#fcd225",
        "#f8df25", "#f4ed27", "#f0f921",
    ],
    "inferno": [
        "#000004", "#040312", "#0b0724", "#150b37", "#210c4a", "#2f0a5b",
        "#3d0965", "#4a0c6b", "#57106e", "#64156e", "#71196e", "#7d1e6d",
        "#8a226a", "#972766", "#a32c61", "#b0315b", "#bc3754", "#c73e4c",
        "#d24644", "#db503b", "#e45a31", "#eb6628", "#f1731d", "#f68013",
        "#f98e09", "#fb9d07", "#fcac11", "#fbbc21", "#f9cb35", "#f5db4c",
        "#f2ea69", "#f3f68a", "#fcffa4",
    ],
    "magma": [
        "#000004", "#030312", "#0a0822", "#130d34", "#1d1147", "#29115a",
        "#36106b", "#440f76", "#51127c", "#5d177f", "#6a1c81", "#762181",
        "#832681", "#902a81", "#9c2e7f", "#aa337d", "#b73779", "#c43c75",
        "#d0416f", "#dc4869", "#e75263", "#ef5d5e", "#f56b5c", "#f9795d",
        "#fc8961", "#fd9869", "#fea772", "#feb67c", "#fec488", "#fed395",
        "#fde2a3", "#fcf0b2", "#fcfdbf",
    ],
    "cividis": [
        "#00224e", "#00285b", "#002e6a", "#053371", "#1a386f", "#273e6e",
        "#32436d", "#3b496c", "#434e6c", "#4b546c", "#535a6d", "#5a5f6e",
        "#61656f", "#686a71", "#6f7073", "#767676", "#7d7c78", "#848279",
        "#8c8878", "#938e78", "#9b9476", "#a39a74", "#aba072", "#b4a76f",
        "#bcae6c", "#c4b468", "#cdbb63", "#d5c25e", "#dec958", "#e7d150",
        "#f0d846", "#f9e03a", "#fee838",
    ],
    "turbo": [
        "#30123b", "#392a73", "#4040a2", "#4456c7", "#466be3", "#4680f6",
        "#4294ff", "#37a8fa", "#28bceb", "#1ccdd8", "#18ddc2", "#1fe9af",
        "#32f298", "#4ef97d", "#6dfe62", "#8bff4b", "#a4fc3c", "#b9f635",
        "#cdec34", "#dfdf37", "#eecf3a", "#f8be39", "#fdac34", "#fe962b",
        "#fb7e21", "#f46617", "#eb500e", "#df3f08", "#d02f05", "#be2102",
        "#a91601", "#920b01", "#7a0403",
    ],
    "coolwarm": [
        "#3b4cc0", "#445acc", "#4e68d8", "#5875e1", "#6282ea", "#6c8ff1",
        "#779af7", "#82a6fb", "#8db0fe", "#98b9ff", "#a3c2fe", "#aec9fc",
        "#b9d0f9", "#c3d5f4", "#ccd9ed", "#d5dbe5", "#dddcdc", "#e5d8d1",
        "#ecd3c5", "#f1ccb8", "#f5c4ac", "#f7ba9f", "#f7b093", "#f6a586",
        "#f4987a", "#f08b6e", "#eb7d62", "#e46e56", "#dd5f4b", "#d44e41",
        "#ca3b37", "#be242e", "#b40426",
    ],
    "gray": [
        "#000000", "#080808", "#101010", "#181818", "#202020", "#282828",
        "#303030", "#383838", "#404040", "#484848", "#505050", "#585858",
        "#606060", "#686868", "#707070", "#787878", "#808080", "#888888",
        "#909090", "#989898", "#a0a0a0", "#a8a8a8", "#b0b0b0", "#b8b8b8",
        "#c0c0c0", "#c8c8c8", "#d0d0d0", "#d8d8d8", "#e0e0e0", "#e8e8e8",
        "#f0f0f0", "#f8f8f8", "#ffffff",
    ],
    "white-red": ["#ffffff", "#d62728"],
    "white-green": ["#ffffff", "#2ca02c"],
    "white-blue": ["#ffffff", "#1f77b4"],
}

DEFAULT_COLORMAP = "viridis"

# Tableau 10 followed by its light variants; categorical assignment cycles
# through these in order of descending category count.
CATEGORICAL_PALETTE = [
    "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f",
    "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac",
    "#a0cbe8", "#ffbe7d", "#ff9d9a", "#86bcb6", "#8cd17d",
    "#f1ce63", "#d4a6c8", "#fabfd2", "#d7b5a6", "#79706e",
]


def _hexToRgb(hexColor):
    return tuple(int(hexColor[i:i + 2], 16) for i in (1, 3, 5))


def _rgbToHex(rgb):
    return "#%02x%02x%02x" % rgb


def _blend(rgb, target, amount):
    return tuple(
        int(round(rgb[i] + (target[i] - rgb[i]) * amount)) for i in range(3)
    )


# Lightness offsets applied to the base palette once it is exhausted. Each
# successive cycle blends toward black or white by a different amount, so
# category 21 is a visibly darker cousin of category 1 rather than its exact
# duplicate. Real datasets need this: a 36-cluster graph clustering rendered
# only 20 distinct colors before it was added.
_CYCLE_ADJUSTMENTS = [
    (None, 0.0),          # cycle 0: the palette as authored
    ((0, 0, 0), 0.45),    # darker
    ((255, 255, 255), 0.45),  # lighter
    ((0, 0, 0), 0.7),     # darkest
    ((255, 255, 255), 0.7),   # lightest
]


# How many categories can get a distinct color: one per palette entry per
# lightness cycle. Annotation.MAX_CATEGORIES is derived from this so the cap
# and the palette cannot drift apart — when they did, categories 100-255
# silently reused cycle 0, duplicating colors 80 categories past the point the
# cycling was added to prevent exactly that.
DISTINCT_CATEGORICAL_COLORS = (
    len(CATEGORICAL_PALETTE) * len(_CYCLE_ADJUSTMENTS)
)


def categoricalColor(index):
    """Color for the index-th category, ordered by descending count.

    Cycles the base palette, shifting lightness on each cycle so colors stay
    distinguishable past the palette's length. Distinct only for
    index < DISTINCT_CATEGORICAL_COLORS; callers must not exceed it (see
    Annotation.MAX_CATEGORIES)."""
    base = CATEGORICAL_PALETTE[index % len(CATEGORICAL_PALETTE)]
    cycle = (index // len(CATEGORICAL_PALETTE)) % len(_CYCLE_ADJUSTMENTS)
    target, amount = _CYCLE_ADJUSTMENTS[cycle]
    if target is None:
        return base
    return _rgbToHex(_blend(_hexToRgb(base), target, amount))


def colormapTable(name, levels):
    """Hex colors for `levels` uniformly spaced samples of the colormap,
    indexable by quantized level.

    Callers quantize to a fixed number of levels anyway, so sampling once per
    level beats sampling once per annotation: on a 708K-annotation dataset the
    per-annotation form spent 3.2s in hex parsing and interpolation against
    0.5s for a table lookup, for identical colors (table[i] is exactly
    sampleColormap(name, i / (levels - 1)))."""
    return [sampleColormap(name, i / (levels - 1)) for i in range(levels)]


def sampleColormap(name, t):
    """Sample the named colormap at t in [0, 1] (clamped) with
    piecewise-linear interpolation between anchors. Returns a hex color."""
    anchors = CONTINUOUS_COLORMAPS[name]
    t = min(max(t, 0.0), 1.0)
    position = t * (len(anchors) - 1)
    lowIndex = int(position)
    highIndex = min(lowIndex + 1, len(anchors) - 1)
    fraction = position - lowIndex
    low = _hexToRgb(anchors[lowIndex])
    high = _hexToRgb(anchors[highIndex])
    return _rgbToHex(tuple(
        int(round(low[i] + (high[i] - low[i]) * fraction)) for i in range(3)
    ))
