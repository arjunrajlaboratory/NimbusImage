class OAuthError(Exception):
    """An OAuth error response (RFC 6749 section 5.2 / 4.1.2.1).

    ``error`` is the registered error code sent to the client; the
    description is for people and never contains secrets.
    """

    def __init__(self, error, description, status=400):
        super().__init__(description)
        self.error = error
        self.description = description
        self.status = status


class RedirectableError(OAuthError):
    """An authorize error that is reported to the client by redirecting to
    its (already validated) redirect URI. ``echoState`` False leaves the
    client's state out of that redirect (when the state itself is the
    error)."""

    def __init__(self, error, description, status=400, echoState=True):
        super().__init__(error, description, status)
        self.echoState = echoState
