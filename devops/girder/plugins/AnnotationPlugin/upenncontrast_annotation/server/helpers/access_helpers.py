"""Shared helpers for access control endpoints."""

from girder.models.user import User


def fetchUserEmails(userIds):
    """Bulk-fetch email addresses for a list of user IDs.

    :param userIds: List of ObjectId user IDs.
    :returns: Dict mapping user ObjectId -> email string.
    """
    if not userIds:
        return {}
    users = list(User().find(
        {'_id': {'$in': userIds}},
        fields=['email']
    ))
    return {
        u['_id']: u.get('email', '')
        for u in users
    }
