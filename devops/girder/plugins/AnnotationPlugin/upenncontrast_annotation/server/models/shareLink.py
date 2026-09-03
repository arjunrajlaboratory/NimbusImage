"""Share-view links (plan §14.1, SHARING.md "Share links").

A link is a capability URL for ONE dataset view. Its bearer is a hidden
Girder user created for the link (`share-<hex>`), given READ on the dataset
folder, the dataset view and its configuration exactly as `dataset_view/share`
grants a named user, and a DATA_READ-scoped token for that user. Read access
is therefore bounded twice: by the ACL (only this dataset) and by the scope
(write endpoints refuse the token). Revoking deletes the user — Girder's
cleanup drops its ACL entries — and the token.
"""

import datetime
import secrets

from bson.objectid import ObjectId
from girder.constants import AccessType, TokenScope
from girder.exceptions import ValidationException
from girder.models.folder import Folder
from girder.models.model_base import Model
from girder.models.token import Token
from girder.models.user import User

from .collection import Collection as CollectionModel
from .datasetView import DatasetView as DatasetViewModel

LINK_USER_PREFIX = "share-"
LINK_USER_EMAIL_DOMAIN = "share-link.invalid"
# "No expiry" links still get a token lifetime Girder accepts; ten years is
# past any reasonable use and keeps `expires` a real date for the listing.
NO_EXPIRY_DAYS = 3650
MAX_LABEL_LENGTH = 120


def _utcNow():
    return datetime.datetime.now(datetime.timezone.utc)


def _aware(value):
    """Mongo hands back naive UTC datetimes unless the client is tz-aware;
    Girder's token expiry is aware. Compare everything as aware UTC."""
    if value.tzinfo is None:
        return value.replace(tzinfo=datetime.timezone.utc)
    return value


class ShareLink(Model):
    def initialize(self):
        self.name = "share_link"
        self.ensureIndices(["datasetId", "linkUserId", "tokenId"])

    def validate(self, document):
        for key in ("datasetId", "datasetViewId", "configurationId",
                    "linkUserId", "createdBy"):
            if not isinstance(document.get(key), ObjectId):
                raise ValidationException("%s must be an ObjectId" % key)
        # Girder token ids are the 64-character token strings themselves.
        if not isinstance(document.get("tokenId"), str):
            raise ValidationException("tokenId must be a token string")
        label = document.get("label", "")
        if not isinstance(label, str) or len(label) > MAX_LABEL_LENGTH:
            raise ValidationException(
                "label must be a string of at most %d characters"
                % MAX_LABEL_LENGTH
            )
        return document

    # ---- creation ---------------------------------------------------------

    def create(self, datasetView, configuration, dataset, creator, days,
               label=""):
        """A new link for `datasetView`. Returns (document, token string);
        the token string is only ever available here."""
        suffix = secrets.token_hex(6)
        linkUser = User().createUser(
            login=LINK_USER_PREFIX + suffix,
            password=secrets.token_urlsafe(32),
            firstName="Share link",
            lastName=suffix,
            email="%s%s@%s" % (
                LINK_USER_PREFIX, suffix, LINK_USER_EMAIL_DOMAIN
            ),
            admin=False,
            public=False,
        )
        linkUser["shareLink"] = {
            "datasetId": dataset["_id"], "createdBy": creator["_id"],
        }
        User().save(linkUser, validate=False)
        CollectionModel().setUserAccess(
            configuration, linkUser, AccessType.READ, save=True
        )
        DatasetViewModel().setUserAccess(
            datasetView, linkUser, AccessType.READ, save=True
        )
        Folder().setUserAccess(dataset, linkUser, AccessType.READ, save=True)
        # USER_INFO_READ lets the client's `user/me` bootstrap see the link
        # user; DATA_READ is what actually reads the dataset. No write scope.
        token = Token().createToken(
            user=linkUser, days=days if days else NO_EXPIRY_DAYS,
            scope=[TokenScope.DATA_READ, TokenScope.USER_INFO_READ],
        )
        document = self.save({
            "datasetId": dataset["_id"],
            "datasetViewId": datasetView["_id"],
            "configurationId": configuration["_id"],
            "linkUserId": linkUser["_id"],
            "tokenId": token["_id"],
            "label": label,
            "createdBy": creator["_id"],
            "created": _utcNow(),
            "expiresAt": token["expires"] if days else None,
            "revoked": False,
        })
        return document, token["_id"]

    # ---- reads ------------------------------------------------------------

    def forDataset(self, datasetId):
        return list(self.find(
            {"datasetId": datasetId, "revoked": False}, sort=[("created", 1)]
        ))

    def forLinkUser(self, userId):
        return self.findOne({"linkUserId": userId, "revoked": False})

    def isExpired(self, document, now=None):
        expiresAt = document.get("expiresAt")
        return expiresAt is not None and _aware(expiresAt) <= (
            now or _utcNow()
        )

    # ---- revocation ---------------------------------------------------------

    def revoke(self, document):
        """Delete the link user (its ACL entries go with it) and the token,
        and keep the document as a revoked record."""
        Token().removeWithQuery({"userId": document["linkUserId"]})
        linkUser = User().load(document["linkUserId"], force=True)
        if linkUser is not None:
            User().remove(linkUser)
        document["revoked"] = True
        document["revokedAt"] = _utcNow()
        return self.save(document)

    def serialize(self, document):
        return {
            "_id": str(document["_id"]),
            "datasetId": str(document["datasetId"]),
            "datasetViewId": str(document["datasetViewId"]),
            "configurationId": str(document["configurationId"]),
            "label": document.get("label", ""),
            "created": document["created"].isoformat(),
            "expiresAt": (
                document["expiresAt"].isoformat()
                if document.get("expiresAt") else None
            ),
            "expired": self.isExpired(document),
            "createdBy": str(document["createdBy"]),
        }
