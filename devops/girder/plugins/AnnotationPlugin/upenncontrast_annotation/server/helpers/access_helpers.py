"""Shared helpers for access control endpoints."""

from collections import defaultdict
from dataclasses import dataclass, field

from bson import ObjectId

from girder.constants import AccessType
from girder.exceptions import AccessException, RestException
from girder.models.folder import Folder
from girder.models.user import User

from .constants import MAX_IDS_PER_QUERY
from .folder_access_guard import require_creator_keeps_admin
from ..models.annotation import Annotation
from ..models.collection import Collection
from ..models.datasetView import DatasetView

SHARE_ACCESS_TYPES = (
    AccessType.NONE, AccessType.READ, AccessType.WRITE, AccessType.ADMIN
)


def parseShareAccessType(accessType):
    """Convert a share request's accessType to a setUserAccess level.

    The share endpoints take -1 (AccessType.NONE) to mean "remove access",
    but Girder's setUserAccess only removes the entry when the level is None;
    any other value, -1 included, is stored as an inert {id, level: -1}
    entry that keeps the user listed in the access table.

    AccessType.validate would also accept SITE_ADMIN (100) and raises
    ValueError (a 500) on bad input, so the allowed set is checked here.
    The value must already be an int: int() would truncate a JSON 1.9 to
    WRITE, and bool is an int subclass.

    :param accessType: -1 (remove), 0 (READ), 1 (WRITE) or 2 (ADMIN).
    :returns: The AccessType level, or None to remove access.
    :raises RestException: 400 if accessType is not one of those levels.
    """
    if (isinstance(accessType, bool) or not isinstance(accessType, int)
            or accessType not in SHARE_ACCESS_TYPES):
        raise RestException(
            "accessType must be one of %s" % (SHARE_ACCESS_TYPES,), code=400)
    return None if accessType == AccessType.NONE else accessType


def findShareTarget(userMailOrUsername):
    """Find the named user a share request targets, by login or email.

    Share-link principals are managed only through the link endpoints, so
    they are treated as unknown here: otherwise a WRITE collaborator could
    widen a link to other collections or quietly break it.

    :param userMailOrUsername: The target's login or email.
    :returns: The user document.
    :raises RestException: "badEmailOrUsername" if no such named user.
    """
    targetUser = User().findOne({
        '$or': [
            {'login': userMailOrUsername},
            {'email': userMailOrUsername},
        ],
        'shareLink': {'$exists': False},
    })
    if not targetUser:
        raise RestException('badEmailOrUsername')
    return targetUser


def requireCanSetUserAccess(model, document, user, targetUser, level):
    """Refuse an ACL change that reaches above the caller's own level.

    The caller may grant at most their own level, and may change or remove
    only a user whose current entry is no higher than their own. So a WRITE
    collaborator can share READ or WRITE, but can neither make anyone
    (themselves included) ADMIN nor demote or remove an owner. On a dataset
    folder, nobody but a site admin may take its creator below ADMIN, the
    creator included (folder_access_guard.require_creator_keeps_admin).

    :param model: The AccessControlledModel the document belongs to.
    :param document: The document whose ACL is about to change.
    :param user: The user making the change.
    :param targetUser: The user whose access is changing.
    :param level: The new level, or None to remove access.
    :raises AccessException: If the change exceeds the caller's level.
    :raises ValidationException: If a dataset's creator would lose ADMIN.
    """
    userLevel = model.getAccessLevel(document, user)
    targetLevel = max(
        (entry['level']
         for entry in document.get('access', {}).get('users', [])
         if entry['id'] == targetUser['_id']),
        default=None,
    )
    if level is not None and level > userLevel:
        raise AccessException(
            'You cannot grant access above your own level')
    if targetLevel is not None and targetLevel > userLevel:
        raise AccessException(
            'You cannot change access for a user above your own level')
    if isinstance(model, Folder):
        require_creator_keeps_admin(document, targetUser, level)


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


@dataclass
class ProjectContents:
    """What a project's export publishes, as an access check saw it."""
    datasetIds: list
    collectionIds: list
    # dataset id -> configuration docs (with meta.propertyIds) its views use
    configsByDataset: dict = field(default_factory=dict)


def _requireDocsAccess(model, ids, user, level, fields):
    """Check access on the docs among `ids` that exist; return them by id."""
    docs = {}
    for doc in model.find({'_id': {'$in': list(ids)}}, fields=fields):
        model.requireAccess(doc, user, level)
        docs[doc['_id']] = doc
    return docs


def requireResourcesAccess(datasetIds, collectionIds, user,
                           level=AccessType.ADMIN):
    """Check access on datasets and collections loaded in two queries.

    Ids that no longer resolve are left out of the result rather than
    refused: whether a missing resource is an error is the caller's call
    (publishing a Zenodo draft refuses it, since the draft still holds its
    files; the upload job just drops it).

    :raises AccessException: If user lacks access to any that exist.
    :returns: (ids of the datasets that exist, collection documents that
        exist by id, with meta.propertyIds).
    """
    datasets = _requireDocsAccess(
        Folder(), set(datasetIds), user, level, ['access', 'public'])
    collections = _requireDocsAccess(
        Collection(), set(collectionIds), user, level,
        ['access', 'public', 'meta.propertyIds'])
    return list(datasets), collections


def requireProjectContentsAccess(project, user, level=AccessType.ADMIN):
    """Check access on everything a project's export publishes.

    Project-level access says nothing about the resources in it: a dataset
    can be added by someone with only WRITE on it, and a project admin may
    not be able to read it at all. Publishing a project (Zenodo) is an owner
    operation on each dataset and collection it lists. Configurations
    reached only through views of its datasets are exported (their
    property definitions) only when the user owns them, and otherwise left
    out; only views the user can edit count. References to deleted
    resources are skipped, as the export skips them, and left out of the
    result.

    Views and project membership can change after the check, so the export
    must use what this returns rather than query them again, and publishing
    a draft must check what was uploaded (requireResourcesAccess on the
    returned ids), not the project as it is by then.

    :raises AccessException: If user lacks access to any of them.
    :returns: A ProjectContents of what was checked and exists.
    """
    meta = project.get('meta', {})
    datasetIds = list(_requireDocsAccess(
        Folder(),
        {ObjectId(d['datasetId']) for d in meta.get('datasets', [])},
        user, level, ['access', 'public']))
    # Collections the project lists are published as such: the user must
    # own them.
    collectionsById = _requireDocsAccess(
        Collection(),
        {ObjectId(c['collectionId']) for c in meta.get('collections', [])},
        user, level, ['access', 'public', 'meta.propertyIds'])
    # Configurations reached only through views of the uploaded datasets
    # contribute their property definitions only if the user owns them,
    # and are otherwise left out rather than refused. Only views the user
    # can edit count: anyone can create a view naming any dataset (and
    # make it public, which grants READ but never WRITE), so a stranger's
    # view must neither block the upload nor choose what it contains.
    configIdsByDataset = defaultdict(set)
    if datasetIds:
        datasetViewModel = DatasetView()
        for view in datasetViewModel.find(
                {'datasetId': {'$in': datasetIds}},
                fields=['datasetId', 'configurationId', 'access',
                        'public']):
            if not datasetViewModel.hasAccess(
                    view, user, AccessType.WRITE):
                continue
            configIdsByDataset[view['datasetId']].add(
                view['configurationId'])
    viewConfigIds = set().union(*configIdsByDataset.values()) - set(
        collectionsById)
    collectionModel = Collection()
    for doc in collectionModel.find(
            {'_id': {'$in': list(viewConfigIds)}},
            fields=['access', 'public', 'meta.propertyIds']):
        if collectionModel.hasAccess(doc, user, level):
            collectionsById[doc['_id']] = doc
    return ProjectContents(
        datasetIds=datasetIds,
        collectionIds=list(collectionsById),
        configsByDataset={
            datasetId: [
                collectionsById[c] for c in configIds
                if c in collectionsById]
            for datasetId, configIds in configIdsByDataset.items()
        },
    )


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


def formatAccessList(model, document, currentUser):
    """Format a document's access list with user emails.

    Returns dict with 'public', 'users', 'groups' and 'currentUserLevel'.
    currentUserLevel is the caller's effective level (groups and site admin
    included, the same getAccessLevel the share endpoints authorize with),
    so a client never infers its own rights from the direct-user rows.
    Users include id, login, name, email, and level. Share-link principals
    are managed only through the link list, never the named sharing table.
    Entries with a negative level grant nothing; they are leftovers from
    share endpoints that stored -1 instead of removing the user, so they
    are dropped rather than listed as a user with access.

    :param model: The Girder model instance.
    :param document: The document to get access for.
    :param currentUser: The user making the request.
    :returns: Dict with public, users, groups, currentUserLevel.
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
            if u['id'] in userEmails and u['level'] >= AccessType.READ
        ],
        'groups': accessList.get('groups', []),
        'currentUserLevel': model.getAccessLevel(document, currentUser),
    }
