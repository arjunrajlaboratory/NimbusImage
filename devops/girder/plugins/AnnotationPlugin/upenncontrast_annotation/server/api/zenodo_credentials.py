"""
REST API endpoints for managing Zenodo API credentials.

Stores the user's Zenodo token encrypted in their user
metadata using Fernet symmetric encryption. The encryption
key is read from the ZENODO_ENCRYPTION_KEY environment
variable.

In production (GIRDER_SETTING_PLUGIN_REGISTRY or no
explicit dev flag), the server refuses to start Zenodo
credential operations without ZENODO_ENCRYPTION_KEY set.
"""

import logging
import os
import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from girder.api import access
from girder.api.describe import Description, autoDescribeRoute
from girder.api.rest import Resource
from girder.exceptions import RestException
from girder.models.user import User

log = logging.getLogger(__name__)

_CACHED_FERNET = None


def _derive_fernet_key(passphrase):
    """Derive a Fernet key from an arbitrary passphrase."""
    return base64.urlsafe_b64encode(
        hashlib.sha256(passphrase.encode()).digest()
    )


def _get_fernet():
    """Get a Fernet instance using the server encryption
    key.

    Uses ZENODO_ENCRYPTION_KEY env var. If not set, raises
    an error in production or uses a dev-only default when
    ZENODO_DEV_MODE=true is set.

    The result is cached after first call.
    """
    global _CACHED_FERNET
    if _CACHED_FERNET is not None:
        return _CACHED_FERNET

    env_key = os.environ.get("ZENODO_ENCRYPTION_KEY")
    if env_key:
        # If it's already a valid Fernet key (44 chars
        # base64), use directly; otherwise derive one.
        try:
            _CACHED_FERNET = Fernet(env_key.encode())
            return _CACHED_FERNET
        except Exception:
            pass
        # Derive a Fernet key from the passphrase.
        key = _derive_fernet_key(env_key)
        _CACHED_FERNET = Fernet(key)
        return _CACHED_FERNET

    # No env var set — only allow in dev mode.
    dev_mode = os.environ.get(
        "ZENODO_DEV_MODE", ""
    ).lower() in ("true", "1", "yes")

    if not dev_mode:
        raise RestException(
            "ZENODO_ENCRYPTION_KEY environment variable "
            "is not set. Set it to a secret passphrase "
            "or Fernet key, or set ZENODO_DEV_MODE=true "
            "for development.",
            code=500,
        )

    log.warning(
        "ZENODO_DEV_MODE is enabled. Using a hardcoded "
        "development key. Do NOT use in production."
    )
    key = _derive_fernet_key(
        "nimbus-zenodo-dev-key-change-in-prod"
    )
    _CACHED_FERNET = Fernet(key)
    return _CACHED_FERNET


def encrypt_token(token):
    """Encrypt a Zenodo API token."""
    return _get_fernet().encrypt(
        token.encode()
    ).decode()


def decrypt_token(encrypted):
    """Decrypt a Zenodo API token."""
    try:
        return _get_fernet().decrypt(
            encrypted.encode()
        ).decode()
    except InvalidToken:
        return None


class ZenodoCredentials(Resource):

    def __init__(self):
        super().__init__()
        self.resourceName = "zenodo_credentials"

        self.route("GET", (), self.getCredentials)
        self.route("PUT", (), self.setCredentials)
        self.route("DELETE", (), self.deleteCredentials)

    @access.user
    @autoDescribeRoute(
        Description(
            "Check if Zenodo credentials are configured"
        )
        .notes(
            "Returns whether the user has a Zenodo token "
            "stored and whether it is for the sandbox."
        )
    )
    def getCredentials(self):
        user = self.getCurrentUser()
        fullUser = User().load(user['_id'], force=True)
        zenodo = fullUser.get('meta', {}).get('zenodo', {})

        has_token = bool(zenodo.get('encryptedToken'))
        sandbox = zenodo.get('sandbox', False)

        return {
            'hasToken': has_token,
            'sandbox': sandbox,
        }

    @access.user
    @autoDescribeRoute(
        Description("Store Zenodo API credentials")
        .notes(
            "Encrypts and stores the Zenodo API token in "
            "the user's metadata."
        )
        .jsonParam(
            'body',
            'Request body with token and sandbox flag',
            paramType='body',
            required=True,
            requireObject=True,
        )
    )
    def setCredentials(self, body):
        user = self.getCurrentUser()
        token = body.get('token', '')
        sandbox = body.get('sandbox', False)

        if not token:
            raise RestException(
                "Token is required", code=400
            )

        if 'meta' not in user:
            user['meta'] = {}

        user['meta']['zenodo'] = {
            'encryptedToken': encrypt_token(token),
            'sandbox': sandbox,
        }
        User().save(user)

        return {'success': True, 'sandbox': sandbox}

    @access.user
    @autoDescribeRoute(
        Description("Remove Zenodo API credentials")
        .notes(
            "Deletes the stored Zenodo token from the "
            "user's metadata."
        )
    )
    def deleteCredentials(self):
        user = self.getCurrentUser()

        if 'meta' in user and 'zenodo' in user['meta']:
            del user['meta']['zenodo']
            User().save(user)

        return {'success': True}
