from girder.models.assetstore import Assetstore
from girder.models.user import User


def provision():
    """
    Provision the instance.

    :param opts: the argparse options.
    """
    # If there is are no users, create an admin user
    if User().findOne() is None:
        User().createUser(
            "admin", "password", "Admin", "Admin", "admin@nowhere.nil"
        )

    # Make sure we have an assetstore
    if Assetstore().findOne() is None:
        Assetstore().createFilesystemAssetstore("Assetstore", "/assetstore")


if __name__ == "__main__":
    provision()
