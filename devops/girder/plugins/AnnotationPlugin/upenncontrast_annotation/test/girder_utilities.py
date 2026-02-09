from girder.models.folder import Folder


def namedFolder(user, folderName="Public"):
    return Folder().find(
        {
            "parentId": user["_id"],
            "name": folderName,
        }
    )[0]


def createFolder(user, name, metadata):
    public = namedFolder(user)
    folder = Folder().createFolder(name=name, creator=user, parent=public)
    Folder().setMetadata(folder, metadata)
    return folder


def createPrivateFolder(user, name, metadata):
    private = namedFolder(user, "Private")
    folder = Folder().createFolder(
        name=name, creator=user, parent=private
    )
    Folder().setMetadata(folder, metadata)
    return folder
