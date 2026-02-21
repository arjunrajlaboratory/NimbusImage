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


def formatAccessList(model, document):
    """Format a document's access list with user emails.

    Returns dict with 'public', 'users', and 'groups' keys.
    Users include id, login, name, email, and level.

    :param model: The Girder model instance.
    :param document: The document to get access for.
    :returns: Dict with public, users, groups.
    """
    accessList = model.getFullAccessList(document)
    userIds = [
        u['id'] for u in accessList.get('users', [])
    ]
    userEmails = fetchUserEmails(userIds)
    return {
        'public': document.get('public', False),
        'users': [
            {
                'id': str(u['id']),
                'login': u.get('login', ''),
                'name': u.get('name', ''),
                'email': userEmails.get(
                    u['id'], ''
                ),
                'level': u['level'],
            }
            for u in accessList.get('users', [])
        ],
        'groups': accessList.get('groups', []),
    }
