"""Collections of the MCP OAuth server.

Codes, access and refresh tokens are stored only as SHA-256 hashes, as
the documents' ``_id``. An access token's record holds the id of the Girder
session token behind it, which is itself a credential (Girder stores its
tokens in the clear). Every collection with an ``expiresAt``
has a TTL index; MongoDB's TTL monitor runs about once a minute, so readers
also check expiry themselves.
"""
import datetime

from girder.models.model_base import Model


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def expired(doc):
    expiresAt = doc['expiresAt']
    if expiresAt.tzinfo is None:
        expiresAt = expiresAt.replace(tzinfo=datetime.timezone.utc)
    return expiresAt <= now()


class _TTLModel(Model):
    collectionName = None
    extraIndices = ()

    def initialize(self):
        self.name = self.collectionName
        self.ensureIndex(('expiresAt', {'expireAfterSeconds': 0}))
        self.ensureIndices(list(self.extraIndices))

    def validate(self, doc):
        return doc


class AuthorizationRequest(_TTLModel):
    """An authorize call waiting for the user's consent. ``_id`` is the
    random request id carried by the consent page's URL."""
    collectionName = 'mcp_oauth_request'


class AuthorizationCode(_TTLModel):
    collectionName = 'mcp_oauth_code'


class Grant(_TTLModel):
    """One user's connection of one client. ``expiresAt`` slides forward on
    every refresh (the refresh token's idle lifetime)."""
    collectionName = 'mcp_oauth_grant'
    extraIndices = ('userId',)


class AccessToken(_TTLModel):
    collectionName = 'mcp_oauth_access'
    extraIndices = ('grantId',)


class RefreshToken(_TTLModel):
    collectionName = 'mcp_oauth_refresh'
    extraIndices = ('grantId',)


class ClientDocument(_TTLModel):
    """Cache of fetched Client ID Metadata Documents, keyed by URL."""
    collectionName = 'mcp_oauth_client'
