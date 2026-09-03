"""What a share link's bearer may NOT do, on top of its READ ACL and read
scope (SHARING.md "Share links").

Girder has no scope that separates viewing from downloading: DATA_READ opens
`folder/{id}/download`, `item/{id}/download`, `file/{id}/download`,
`resource/download` and the plugin's export routes. A share link is meant to
show a view, not to hand out the raw files, so those routes refuse a link
user before the handler runs. The link users themselves are also dropped
from `GET user` listings; they are plumbing, not people.
"""

from girder import events
from girder.api.rest import getCurrentUser
from girder.exceptions import AccessException

DOWNLOAD_ROUTES = (
    "rest.get.folder/:id/download.before",
    "rest.get.item/:id/download.before",
    "rest.get.file/:id/download.before",
    "rest.get.file/:id/download/:name.before",
    "rest.get.resource/download.before",
    "rest.post.resource/download.before",
    "rest.get.export/json.before",
    "rest.post.export/csv.before",
)
HANDLER_NAME = "upenncontrast_annotation.shareLinkGuards"


def isLinkUser(user):
    return bool(user and user.get("shareLink"))


def refuseDownloadForLinkUsers(event):
    if isLinkUser(getCurrentUser()):
        raise AccessException(
            "Share links show a view; they cannot download the dataset's "
            "files."
        )


def hideLinkUsersFromListing(event):
    users = event.info.get("returnVal")
    if isinstance(users, list):
        event.info["returnVal"][:] = [
            user for user in users
            if not (isinstance(user, dict) and user.get("shareLink"))
        ]


def bind():
    for name in DOWNLOAD_ROUTES:
        events.bind(name, HANDLER_NAME, refuseDownloadForLinkUsers)
    events.bind("rest.get.user.after", HANDLER_NAME, hideLinkUsersFromListing)
