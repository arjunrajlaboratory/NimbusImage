"""
REST API endpoints for managing Zenodo API credentials.

Stores the user's Zenodo token encrypted in their user
metadata using Fernet symmetric encryption. The encryption
key is read from the ZENODO_ENCRYPTION_KEY environment
variable (or a default for development).
"""

import os
import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from girder.api import access
from girder.api.describe import Description, autoDescribeRoute
from girder.api.rest import Resource
from girder.models.user import User


def _get_fernet():
    """Get a Fernet instance using the server encryption
    key.

    Uses ZENODO_ENCRYPTION_KEY env var. If not set, derives
    a key from a default passphrase (development only).
    """
    env_key = os.environ.get("ZENODO_ENCRYPTION_KEY")
    if env_key:
        # If it's already a valid Fernet key (44 chars
        # base64), use directly; otherwise derive one.
        try:
            Fernet(env_key.encode())
            return Fernet(env_key.encode())
        except Exception:
            pass
    # Derive a key from a passphrase
    passphrase = (
        env_key or "nimbus-zenodo-dev-key-change-in-prod"
    )
    key = base64.urlsafe_b64encode(
        hashlib.sha256(passphrase.encode()).digest()
    )
    return Fernet(key)


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
            return {'error': 'Token is required'}

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
