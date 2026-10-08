"""Shared helpers for access control endpoints."""

from girder.constants import AccessType
from girder.exceptions import AccessException, RestException
from girder.models.folder import Folder
from girder.models.user import User

from ..models.annotation import Annotation
from ..models.propertyValues import MAX_IDS_PER_QUERY


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


def requireAnnotationsInDatasets(entries):
    """Reject entries whose annotation is not in the entry's datasetId.

    Endpoints authorize a write by each entry's datasetId, but a write keyed
    by annotationId alone touches whichever dataset that annotation is in.
    Without this check, WRITE access to one dataset let a caller overwrite
    the values of any annotation in another (Codex P1, PR #1358).

    :param entries: Dicts with ObjectId "annotationId" and "datasetId".
    :raises RestException: 400 if an annotation is missing or belongs to a
        different dataset than its entry names, or an entry omits either id.
    """
    annotationIds = list({entry.get("annotationId") for entry in entries})
    datasetOf = {}
    for start in range(0, len(annotationIds), MAX_IDS_PER_QUERY):
        for annotation in Annotation().find(
            {"_id": {"$in": annotationIds[start:start + MAX_IDS_PER_QUERY]}},
            fields={"datasetId": 1},
        ):
            datasetOf[annotation["_id"]] = annotation["datasetId"]
    for entry in entries:
        annotationId = entry.get("annotationId")
        datasetId = entry.get("datasetId")
        if datasetId is None or datasetOf.get(annotationId) != datasetId:
            raise RestException(
                "Annotation %s does not belong to dataset %s"
                % (annotationId, datasetId),
                code=400,
            )


def fetchNamedUserEmails(userIds):
    """Bulk-fetch emails of ordinary users, excluding share-link principals.

    :param userIds: List of ObjectId user IDs.
    :returns: Dict mapping user ObjectId -> email string.
    """
    if not userIds:
        return {}
    users = list(User().find(
        {'_id': {'$in': userIds}, 'shareLink': {'$exists': False}},
        fields=['email']
    ))
    return {
        u['_id']: u.get('email', '')
        for u in users
    }


def formatAccessList(model, document):
    """Format a document's access list with user emails.

    Returns dict with 'public', 'users', and 'groups' keys.
    Users include id, login, name, email, and level. Share-link principals
    are managed only through the link list, never the named sharing table.

    :param model: The Girder model instance.
    :param document: The document to get access for.
    :returns: Dict with public, users, groups.
    """
    accessList = model.getFullAccessList(document)
    userIds = [
        u['id'] for u in accessList.get('users', [])
    ]
    userEmails = fetchNamedUserEmails(userIds)
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
            if u['id'] in userEmails
        ],
        'groups': accessList.get('groups', []),
    }
