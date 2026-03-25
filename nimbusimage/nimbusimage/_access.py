"""Shared access level constants and helpers."""

ACCESS_MAP = {"read": 0, "write": 1, "admin": 2, "remove": -1}


def resolve_access(access: str) -> int:
    """Convert a human-readable access level to its integer code.

    Args:
        access: One of 'read', 'write', 'admin', 'remove'.

    Raises:
        ValueError: If the access level is not recognized.
    """
    if access not in ACCESS_MAP:
        raise ValueError(
            f"Invalid access level '{access}'. "
            f"Must be one of: {', '.join(ACCESS_MAP.keys())}"
        )
    return ACCESS_MAP[access]
