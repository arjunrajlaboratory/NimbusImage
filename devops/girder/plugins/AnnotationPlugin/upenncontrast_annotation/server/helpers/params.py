"""Shared helpers for request parameter handling."""

TRUTHY_PARAM_VALUES = {"true", "1", "yes", "on"}


def getBooleanParam(params, key, default=False):
    """Parse a boolean-ish request parameter.

    describeRoute does not always coerce query params, so public endpoints may
    see strings even when the route declares dataType="boolean".
    """
    value = params.get(key, default)
    if isinstance(value, bool):
        return value
    return str(value).lower() in TRUTHY_PARAM_VALUES
