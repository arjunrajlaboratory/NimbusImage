"""The port of src/utils/workerInterface.ts normalization."""

from __future__ import annotations

import pytest

from nimbusimage_mcp.worker_values import default_value, normalize, resolve

CHANNELS = ["DAPI", "GFP", "Cy5"]


def test_defaults_follow_get_default():
    assert default_value({"type": "number", "default": 30}) == 30
    assert default_value({"type": "number"}) == 0.0
    assert default_value({"type": "checkbox", "value": True}) is False
    assert default_value({"type": "channelCheckboxes"}) == {}
    # Fresh containers each time: a shared default must not be mutated.
    assert default_value({"type": "tags"}) is not default_value(
        {"type": "tags"})


def test_channel_accepts_index_digit_string_and_name():
    element = {"type": "channel"}
    assert normalize(element, 2, CHANNELS, "c") == 2
    assert normalize(element, "1", CHANNELS, "c") == 1
    assert normalize(element, "gfp", CHANNELS, "c") == 1
    assert normalize(element, None, CHANNELS, "c") is None
    for bad in (3, 1.5, "TRITC", True, [0]):
        with pytest.raises(ValueError):
            normalize(element, bad, CHANNELS, "c")
    with pytest.raises(ValueError, match="required"):
        normalize({"type": "channel", "required": True}, None, CHANNELS, "c")


def test_channel_checkboxes_canonical_map():
    element = {"type": "channelCheckboxes"}
    expected = {"0": True, "1": False, "2": True}
    assert normalize(element, [0, "cy5"], CHANNELS, "s") == expected
    assert normalize(element, {"0": True, "2": True, "1": False},
                     CHANNELS, "s") == expected
    assert normalize(element, [], CHANNELS, "s") == {
        "0": False, "1": False, "2": False}
    with pytest.raises(ValueError, match="map value"):
        normalize(element, {"0": 0}, CHANNELS, "s")


def test_strict_scalars():
    assert normalize({"type": "number"}, "2.5", CHANNELS, "n") == 2.5
    assert normalize({"type": "number"}, 7, CHANNELS, "n") == 7
    for bad in ("", [], True, "nan", float("inf")):
        with pytest.raises(ValueError):
            normalize({"type": "number"}, bad, CHANNELS, "n")
    with pytest.raises(ValueError):
        normalize({"type": "checkbox"}, "false", CHANNELS, "b")
    select = {"type": "select", "items": ["a", "b"], "default": "b"}
    assert normalize(select, None, CHANNELS, "m") == "b"
    with pytest.raises(ValueError, match="Choose one of: a, b"):
        normalize(select, "c", CHANNELS, "m")


def test_resolve_rejects_unknown_parameters():
    interface = {"Size": {"type": "number", "default": 10}}
    assert resolve(interface, {}, CHANNELS) == {"Size": 10}
    assert resolve(interface, {"Size": 3}, CHANNELS) == {"Size": 3}
    with pytest.raises(ValueError, match="Valid parameters: Size"):
        resolve(interface, {"size": 3}, CHANNELS)
