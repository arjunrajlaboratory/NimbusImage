"""Shared helpers for access control endpoints."""

from girder.constants import AccessType
from girder.exceptions import AccessException
from girder.models.folder import Folder
from girder.models.user import User


def requireDatasetsAccess(datasetIds, user, level=AccessType.WRITE):
    """Load all datasets in one query and check access on each.

    :param datasetIds: Iterable of dataset ObjectIds.
    :param user: The current user document.
    :param level: The required AccessType level.
    :raises AccessException: If user lacks access to any dataset.
    """
    datasetIds = list(set(datasetIds))
    if not datasetIds:
        return
    folderModel = Folder()
    datasets = list(folderModel.find(
        {'_id': {'$in': datasetIds}}
    ))
    if len(datasets) != len(datasetIds):
        found = {d['_id'] for d in datasets}
        missing = [d for d in datasetIds if d not in found]
        raise AccessException(
            'Dataset(s) not found: %s' % missing
        )
    for dataset in datasets:
        folderModel.requireAccess(dataset, user, level)


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
