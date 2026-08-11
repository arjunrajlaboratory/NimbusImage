"""Tests for the ported default-configuration builder.

The colour tables are transcribed from ``src/store/model.ts``. Rather than
trusting the transcription, ``TestColourTableParity`` re-parses that file
and compares -- so a palette edit on the frontend fails here instead of
silently giving API-created datasets different layer colours from
UI-created ones. It skips when the frontend tree is not reachable (e.g. an
installed-package test run) rather than failing for the wrong reason.
"""

import os
import re
import sys

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVER = os.path.abspath(os.path.join(_HERE, "..", "server"))
if _SERVER not in sys.path:
    sys.path.insert(0, _SERVER)

from helpers.default_configuration import (  # noqa: E402
    CHANNEL_COLORS,
    COLORS,
    build_compatibility,
    build_default_configuration,
    build_default_layers,
    build_scales,
    infer_z_step_um,
    parse_length_label_um,
    resolve_channel_colors,
)

_MODEL_TS = os.path.abspath(os.path.join(
    _HERE, "..", "..", "..", "..", "..", "..", "src", "store", "model.ts",
))


def _ids():
    """Deterministic layer ids so assertions can name them."""
    counter = iter(range(100))
    return lambda: "id-%d" % next(counter)


class TestDefaultLayers:
    def testOneLayerPerChannelCappedAtSix(self):
        layers = build_default_layers(
            ["a", "b", "c", "d", "e", "f", "g"], id_factory=_ids(),
        )
        assert len(layers) == 6
        assert [layer["channel"] for layer in layers] == [0, 1, 2, 3, 4, 5]

    def testKnownChannelNamesGetTheirColour(self):
        layers = build_default_layers(
            ["DAPI", "GFP", "CY5"], id_factory=_ids(),
        )
        assert [layer["color"] for layer in layers] == [
            CHANNEL_COLORS["DAPI"],
            CHANNEL_COLORS["GFP"],
            CHANNEL_COLORS["CY5"],
        ]
        assert [layer["name"] for layer in layers] == ["DAPI", "GFP", "CY5"]

    def testChannelNameMatchIsCaseInsensitive(self):
        layers = build_default_layers(["dapi"], id_factory=_ids())
        assert layers[0]["color"] == CHANNEL_COLORS["DAPI"]

    def testUnknownChannelsFallBackToThePalette(self):
        layers = build_default_layers(["foo", "bar"], id_factory=_ids())
        assert [layer["color"] for layer in layers] == COLORS[:2]

    def testDuplicateChannelColourFallsBackToThePalette(self):
        """CY5 and ATTO647 share a colour; the second layer must not
        reuse it (mirrors newLayer's `usedColors` check)."""
        layers = build_default_layers(
            ["CY5", "ATTO647"], id_factory=_ids(),
        )
        assert layers[0]["color"] == CHANNEL_COLORS["CY5"]
        assert layers[1]["color"] != layers[0]["color"]
        assert layers[1]["color"] in COLORS

    def testDuplicateChannelNamesGetPositionalLayerNames(self):
        layers = build_default_layers(["GFP", "GFP"], id_factory=_ids())
        assert [layer["name"] for layer in layers] == ["GFP", "Layer 2"]

    def testEmptyChannelNameFallsBackToItsIndex(self):
        """`channelName || \'Channel N\'` runs before the layer-name
        check, so an empty channel name becomes "Channel 0" and never
        reaches newLayer's `layerName === ""` branch (which is dead in the
        frontend for the same reason). Pinned so the port keeps the same
        dead branch rather than "fixing" it into a divergence."""
        layers = build_default_layers(["", "GFP"], id_factory=_ids())
        assert layers[0]["name"] == "Channel 0"
        assert layers[1]["name"] == "GFP"

    def testLayerShapeMatchesTheFrontend(self):
        layer = build_default_layers(["GFP"], id_factory=_ids())[0]
        assert layer == {
            "id": "id-0",
            "name": "GFP",
            "visible": True,
            "channel": 0,
            "time": {"type": "current", "value": None},
            "xy": {"type": "current", "value": None},
            "z": {"type": "current", "value": None},
            "color": CHANNEL_COLORS["GFP"],
            "contrast": {
                "mode": "percentile", "blackPoint": 0, "whitePoint": 100,
            },
            "layerGroup": None,
        }

    def testIdsAreUniqueByDefault(self):
        layers = build_default_layers(["a", "b", "c"])
        assert len({layer["id"] for layer in layers}) == 3


class TestCompatibilityAndScales:
    @pytest.mark.parametrize("count,expected", [
        (1, "one"), (0, "one"), (2, "multiple"), (38, "multiple"),
    ])
    def testDimensionCounts(self, count, expected):
        compat = build_compatibility(["a"], count, count, count)
        assert compat["xyDimensions"] == expected
        assert compat["zDimensions"] == expected
        assert compat["tDimensions"] == expected

    def testChannelsAreIndexedByPosition(self):
        compat = build_compatibility(["DAPI", ""], 1, 1, 1)
        assert compat["channels"] == {"0": "DAPI", "1": "Unnamed channel"}

    def testPixelSizeAveragesTheTwoAxes(self):
        scales = build_scales(0.0002, 0.0004, None)
        assert scales["pixelSize"]["unit"] == "mm"
        assert scales["pixelSize"]["value"] == pytest.approx(0.0003)

    def testMissingPhysicalSizeRecordsZeroMillimetres(self):
        """Matches the UI byte for byte: it stores {0, "mm"} for a source
        with no mm_x/mm_y, and renders no distance scale bar from it.
        Keeping the 1 m/pixel default made the viewer draw a 1.5 km bar
        across a 7920 px image."""
        assert build_scales(None, None, None)["pixelSize"] == {
            "value": 0, "unit": "mm",
        }

    def testNoTileMetadataAtAllKeepsTheDefault(self):
        """The frontend's `if (tileInfo)` guard: with no tile info the
        example default survives untouched."""
        assert build_scales(
            None, None, None, has_tile_metadata=False,
        )["pixelSize"] == {"value": 1, "unit": "m"}

    def testZStepInferredFromDimensionLabels(self):
        scales = build_scales(None, None, {
            "z": ["-2.7 µm", "-2.55 µm", "-2.4 µm"],
        })
        assert scales["zStep"]["unit"] == "µm"
        assert scales["zStep"]["value"] == pytest.approx(0.15)

    def testZStepIgnoredWhenLabelsAreNotLengths(self):
        scales = build_scales(None, None, {"z": ["1", "2", "3"]})
        assert scales["zStep"] == {"value": 1, "unit": "m"}

    def testMutatingScalesDoesNotLeakIntoTheNextCall(self):
        first = build_scales(None, None, None)
        first["zStep"]["value"] = 999
        assert build_scales(None, None, None)["zStep"]["value"] == 1


class TestLengthLabelParsing:
    @pytest.mark.parametrize("label,expected", [
        ("-2.7 µm", -2.7),
        ("2.85 µm", 2.85),
        ("+1.5um", 1.5),
        ("900 nm", 0.9),
        ("1.05 mm", 1050.0),
        (".5 mm", 500.0),
        ("2 microns", 2.0),
        ("3 micrometers", 3.0),
        ("1 m", 1e6),
        # GREEK SMALL LETTER MU normalizes to MICRO SIGN.
        ("4 μm", 4.0),
    ])
    def testParses(self, label, expected):
        assert parse_length_label_um(label) == pytest.approx(expected)

    @pytest.mark.parametrize("label", [
        "1", "abc", "1 parsec", "", "1 2 um", None, 5,
    ])
    def testRejects(self, label):
        assert parse_length_label_um(label) is None

    def testUpperMedianNotMeanOfMiddlePair(self):
        """The frontend's `median` indexes sorted[floor(n/2)]; on an even
        count that is the UPPER of the two middle values, not their
        average. Spacings here are 1, 2, 3, 10 -> upper median 3."""
        labels = ["0 um", "1 um", "3 um", "6 um", "16 um"]
        assert infer_z_step_um({"z": labels}) == pytest.approx(3.0)

    def testNoStepFromFewerThanTwoLabels(self):
        assert infer_z_step_um({"z": ["1 um"]}) is None
        assert infer_z_step_um({}) is None
        assert infer_z_step_um(None) is None

    def testIdenticalLabelsHaveNoPositiveSpacing(self):
        assert infer_z_step_um({"z": ["1 um", "1 um"]}) is None


class TestDefaultConfiguration:
    def testShapeMatchesTheFrontendConfigurationBase(self):
        config = build_default_configuration(
            ["DAPI"], xy_count=1, z_count=7, t_count=1,
            mm_x=0.001, mm_y=0.001, dimension_labels={"z": []},
            id_factory=_ids(),
        )
        assert config["subtype"] == "contrastConfiguration"
        assert sorted(config) == [
            "compatibility", "layers", "pipelines", "propertyIds",
            "scales", "snapshots", "subtype", "tools",
        ]
        assert config["tools"] == []
        assert config["propertyIds"] == []
        assert config["snapshots"] == []
        assert config["pipelines"] == []
        assert config["compatibility"]["zDimensions"] == "multiple"
        assert len(config["layers"]) == 1


@pytest.mark.skipif(
    not os.path.isfile(_MODEL_TS),
    reason="frontend src/store/model.ts not reachable from this checkout",
)
class TestColourTableParity:
    """The Python tables must equal the frontend's, parsed from source."""

    @staticmethod
    def _frontendTables():
        with open(_MODEL_TS, encoding="utf-8") as handle:
            source = handle.read()
        enum = dict(re.findall(
            r'\s+([A-Z_]+):\s*"(#[0-9A-Fa-f]{6})"',
            re.search(
                r"export const COLOR = \{(.*?)\} as const;", source, re.S,
            ).group(1),
        ))
        palette = re.findall(
            r'"(#[0-9A-Fa-f]{6})"',
            re.search(r"const colors = \[(.*?)\];", source, re.S).group(1),
        )
        body = re.search(
            r"const channelColors: \{ \[key: string\]: string \} = "
            r"\{(.*?)\n\};",
            source, re.S,
        ).group(1)
        channels = {}
        for key, value in re.findall(
            r'\n\s*([A-Z0-9_]+):\s*(COLOR\.[A-Z_]+|"#[0-9A-Fa-f]{6}")', body,
        ):
            channels[key] = (
                enum[value.split(".")[1]] if value.startswith("COLOR.")
                else value.strip('"')
            )
        return palette, channels

    def testParsingFoundSomething(self):
        """Guards the regexes: if they stopped matching, the two
        assertions below would compare against empty tables and pass."""
        palette, channels = self._frontendTables()
        assert len(palette) > 20
        assert len(channels) > 20

    def testPaletteMatches(self):
        palette, _ = self._frontendTables()
        assert COLORS == palette

    def testChannelColoursMatch(self):
        _, channels = self._frontendTables()
        assert CHANNEL_COLORS == channels


class TestUserColorOverrides:
    """The frontend threads the configuring user's saved palette into
    newLayer; an API-created collection must do the same or it silently
    differs from a UI-created one."""

    def testUserOverrideWinsOverTheDefaultTable(self):
        layers = build_default_layers(
            ["GFP"], id_factory=_ids(), user_colors={"GFP": "#123456"},
        )
        assert layers[0]["color"] == "#123456"

    def testUnrelatedDefaultsSurviveTheMerge(self):
        layers = build_default_layers(
            ["GFP", "DAPI"], id_factory=_ids(),
            user_colors={"GFP": "#123456"},
        )
        assert [layer["color"] for layer in layers] == [
            "#123456", CHANNEL_COLORS["DAPI"],
        ]

    def testOverrideCanIntroduceAClashHandledLikeAnyOther(self):
        layers = build_default_layers(
            ["GFP", "DAPI"], id_factory=_ids(),
            user_colors={"DAPI": CHANNEL_COLORS["GFP"]},
        )
        assert layers[0]["color"] == CHANNEL_COLORS["GFP"]
        assert layers[1]["color"] != layers[0]["color"]

    def testNoOverridesIsTheDefaultTable(self):
        assert resolve_channel_colors() == CHANNEL_COLORS
        assert resolve_channel_colors({}) == CHANNEL_COLORS

    def testMergeDoesNotMutateTheSharedTable(self):
        before = dict(CHANNEL_COLORS)
        resolve_channel_colors({"GFP": "#123456"})
        assert CHANNEL_COLORS == before
