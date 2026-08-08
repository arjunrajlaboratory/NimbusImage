"""Unit tests for the pure-Python ports of filename parsing and the JS
number-formatting helpers.

These tests do NOT require a running Girder server: the helper modules
only depend on the standard library, so they are imported directly from
the ``server`` directory (added to ``sys.path`` below).

The expected values were verified against Node.js (V8) so they match the
real frontend behaviour exactly.
"""

import os
import sys

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVER = os.path.abspath(os.path.join(_HERE, "..", "server"))
if _SERVER not in sys.path:
    sys.path.insert(0, _SERVER)

from helpers.filename_parsing import collect_filename_metadata  # noqa: E402
from helpers.multi_source import (  # noqa: E402
    format_distance_short,
    format_duration_short,
    int32,
    js_math_round,
    js_to_fixed,
    trim_float,
)


# ---------------------------------------------------------------------------
# Filename parsing
# ---------------------------------------------------------------------------

class TestCollectFilenameMetadata:
    def test_empty(self):
        assert collect_filename_metadata([]) == []

    def test_wells(self):
        names = ["A1.tif", "A2.tif", "B1.tif", "B2.tif"]
        variables = collect_filename_metadata(names)
        assert len(variables) == 1
        var = variables[0]
        assert var["guess"] == "XY"
        assert var["values"] == ["A1", "A2", "B1", "B2"]
        assert var["valueIdxPerFilename"] == {
            "A1.tif": 0, "A2.tif": 1, "B1.tif": 2, "B2.tif": 3,
        }

    def test_zstack_looks_like_well(self):
        # "z01" matches ^[A-Za-z]\d{1,2}$ so it is guessed XY, not Z.
        names = ["s_z01.tif", "s_z02.tif", "s_z03.tif"]
        variables = collect_filename_metadata(names)
        assert len(variables) == 1
        assert variables[0]["guess"] == "XY"
        assert variables[0]["values"] == ["z01", "z02", "z03"]

    def test_times_default_to_channel(self):
        # Common substring "___" matches no trigger -> default "chan" -> C.
        names = ["a_5s.tif", "a_10s.tif", "a_15s.tif"]
        variables = collect_filename_metadata(names)
        assert len(variables) == 1
        assert variables[0]["guess"] == "C"
        # JS default sort is code-unit order: "10s" < "15s" < "5s".
        assert variables[0]["values"] == ["10s", "15s", "5s"]

    def test_slide_digit_maps_to_time(self):
        # "slide_" contains "d" -> the T triggers include "d".
        names = ["slide1.tif", "slide2.tif"]
        variables = collect_filename_metadata(names)
        assert len(variables) == 1
        assert variables[0]["guess"] == "T"
        assert variables[0]["values"] == ["slide1", "slide2"]

    def test_ragged_tokens(self):
        # One row has fewer tokens; the missing token behaves like JS
        # undefined (None) and sorts last.
        names = ["a_b_c.tif", "a_b.tif", "a_d_e.tif"]
        variables = collect_filename_metadata(names)
        assert len(variables) == 1
        assert variables[0]["guess"] == "C"
        assert variables[0]["values"] == ["c", "e", "tif"]
        assert variables[0]["valueIdxPerFilename"] == {
            "a_b_c.tif": 0, "a_d_e.tif": 1, "a_b.tif": 2,
        }

    def test_no_variance_returns_empty(self):
        # Two identical filenames: no spanning column -> [].
        assert collect_filename_metadata(["a_b.tif", "a_b.tif"]) == []

    def test_conflict_resolution(self):
        # Both columns look like wells (xy); the second is bumped to the
        # next free category "chan" -> C.
        names = ["A1_B1.tif", "A1_B2.tif", "A2_B1.tif", "A2_B2.tif"]
        variables = collect_filename_metadata(names)
        assert [v["guess"] for v in variables] == ["XY", "C"]
        assert variables[0]["values"] == ["A1", "A2"]
        assert variables[1]["values"] == ["B1", "B2"]

    def test_three_way_grid_channels(self):
        names = [
            "img000_000.ome.tif", "img000_001.ome.tif",
            "img000_002.ome.tif", "img001_000.ome.tif",
            "img001_001.ome.tif", "img001_002.ome.tif",
        ]
        variables = collect_filename_metadata(names)
        # First column common substring "img00_" contains "m" -> T.
        # Second column "00_" matches no trigger -> chan -> C.
        assert [v["guess"] for v in variables] == ["T", "C"]


# ---------------------------------------------------------------------------
# js_to_fixed (Number.prototype.toFixed)
# ---------------------------------------------------------------------------

class TestJsToFixed:
    # These expected values were verified against Node/V8. The real JS
    # toFixed rounds the *magnitude* half-up and reapplies the sign, i.e.
    # half away from zero. (An early spec draft claimed "-0"/"-2" for the
    # negative ties; that is incorrect and the frontend source wins.)
    @pytest.mark.parametrize("value,digits,expected", [
        (0.5, 0, "1"),
        (-0.5, 0, "-1"),
        (2.5, 0, "3"),
        (-2.5, 0, "-3"),
        (1.005, 2, "1.00"),   # binary 1.005 < exact 1.005
        (-0.4, 0, "-0"),      # rounds to zero but keeps the sign
        (-1.5, 0, "-2"),
        (0.05, 1, "0.1"),
        (2.675, 2, "2.67"),
        (-2.675, 2, "-2.67"),
        (1.35, 1, "1.4"),
        (-1.35, 1, "-1.4"),
        (0.0, 0, "0"),
        (10.25, 1, "10.3"),
        (100.9, 0, "101"),
        (999.9, 0, "1000"),
        (123.456, 2, "123.46"),
    ])
    def test_to_fixed(self, value, digits, expected):
        assert js_to_fixed(value, digits) == expected


# ---------------------------------------------------------------------------
# js_math_round (Math.round -- half toward +infinity)
# ---------------------------------------------------------------------------

class TestJsMathRound:
    @pytest.mark.parametrize("value,expected", [
        (0.5, 1),
        (-0.5, 0),      # Math.round(-0.5) === -0 -> 0
        (2.5, 3),
        (-2.5, -2),
        (2.4, 2),
        (-2.6, -3),
        (0.0, 0),
        (10.5, 11),
    ])
    def test_math_round(self, value, expected):
        assert js_math_round(value) == expected


# ---------------------------------------------------------------------------
# int32 (JS `x | 0`)
# ---------------------------------------------------------------------------

class TestInt32:
    @pytest.mark.parametrize("value,expected", [
        (3, 3),
        (3.9, 3),
        (-3.9, -3),
        (2 ** 31, -(2 ** 31)),
        (2 ** 32, 0),
        (float("nan"), 0),
        (float("inf"), 0),
    ])
    def test_int32(self, value, expected):
        assert int32(value) == expected


# ---------------------------------------------------------------------------
# trim_float (trailing-zero stripping)
# ---------------------------------------------------------------------------

class TestTrimFloat:
    @pytest.mark.parametrize("value,expected", [
        (0, "0"),
        (1, "1"),
        (1.5, "1.5"),
        (2.5, "2.5"),
        (1.2000, "1.2"),        # trailing zeros stripped
        (10.25, "10.3"),        # >=10 -> toFixed(1)
        (100.9, "101"),         # >=100 -> toFixed(0)
        (0.1234, "0.123"),      # >=0.1 -> toFixed(3)
        (0.0123, "0.0123"),     # >=0.01 -> toFixed(4)
        (0.00123, "0.00123"),   # <0.01 -> toFixed(5)
        (-1, "-1"),
        (-0.5, "-0.5"),
        (123.456, "123"),       # >=100 -> toFixed(0)
    ])
    def test_trim_float(self, value, expected):
        assert trim_float(value) == expected


# ---------------------------------------------------------------------------
# format_duration_short (unit boundaries)
# ---------------------------------------------------------------------------

class TestFormatDurationShort:
    @pytest.mark.parametrize("ms,expected", [
        (0, "0 ms"),
        (0.5, "1 ms"),          # ms<1 -> toFixed(0) rounds up
        (999, "999 ms"),
        (1000, "1 s"),
        (59000, "59 s"),
        (60000, "1 min"),
        (150000, "2.5 min"),
        (300000, "5 min"),
        (450000, "7.5 min"),
        (3600000, "1 h"),
        (86400000, "1 d"),
        (90000000, "1.04 d"),
    ])
    def test_duration(self, ms, expected):
        assert format_duration_short(ms) == expected

    def test_non_finite(self):
        assert format_duration_short(float("inf")) == ""
        assert format_duration_short(float("nan")) == ""


# ---------------------------------------------------------------------------
# format_distance_short (nm / µm / mm boundaries, negatives)
# ---------------------------------------------------------------------------

class TestFormatDistanceShort:
    @pytest.mark.parametrize("um,expected", [
        (0, "0 nm"),
        (0.005, "5 nm"),
        (0.01, "10 nm"),
        (0.5, "500 nm"),
        (1, "1 µm"),            # boundary into µm
        (999.9, "1000 µm"),
        (1000, "1 mm"),         # boundary into mm
        (1500, "1.5 mm"),
        (-1, "-1 µm"),
        (-0.5, "-500 nm"),
        (-2500, "-2.5 mm"),
    ])
    def test_distance(self, um, expected):
        assert format_distance_short(um) == expected

    def test_micro_sign_is_u00b5(self):
        # The micron label must use MICRO SIGN U+00B5, not GREEK MU U+03BC.
        assert format_distance_short(1) == "1 µm"
        assert "μ" not in format_distance_short(1)

    def test_non_finite(self):
        assert format_distance_short(float("inf")) == ""
        assert format_distance_short(float("nan")) == ""
