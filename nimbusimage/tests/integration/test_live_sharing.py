"""Integration tests for dataset sharing.

The unit tests pin the request bodies; these prove the server accepts
them and that access actually changes for another, non-admin user.
"""

import contextlib
import json
import secrets

import girder_client
import pytest

import nimbusimage as ni

pytestmark = pytest.mark.integration


# A minimal configuration document, as the web app creates one.
CONFIGURATION_METADATA = {
    "subtype": "contrastConfiguration", "compatibility": {},
    "layers": [], "tools": [], "propertyIds": [],
    "snapshots": [], "scales": {},
}


@contextlib.contextmanager
def _temporary_user(client, api_url):
    """A temporary non-admin user, deleted afterwards.

    Yields ``(login, ni.NimbusClient)`` with the client authenticated as
    that user.
    """
    login = f"ni-share-test-{secrets.token_hex(4)}"
    password = secrets.token_urlsafe(16)
    user = client.girder.post(
        "user",
        data={
            "login": login,
            "email": f"{login}@example.com",
            "firstName": "Share",
            "lastName": "Test",
            "password": password,
            "admin": "false",
        },
    )
    try:
        assert not user["admin"]
        yield login, ni.connect(api_url, username=login, password=password)
    finally:
        client.girder.delete(f"user/{user['_id']}")


@pytest.fixture
def second_user(client, api_url):
    with _temporary_user(client, api_url) as user:
        yield user


@pytest.fixture
def third_user(client, api_url):
    with _temporary_user(client, api_url) as user:
        yield user


def _can_read(other_client, dataset_id):
    try:
        other_client.girder.get(f"folder/{dataset_id}")
    except girder_client.HttpError as error:
        if error.status in (401, 403):
            return False
        raise
    return True


def _user_levels(ds):
    return {u["login"]: u["level"] for u in ds.sharing.get_access()["users"]}


def _has_no_entry(ds, login):
    # "remove" sends accessType -1, which the server turns into deleting
    # the user's entry (#1406), not storing an inert level -1 one.
    return login not in _user_levels(ds)


class TestLiveSharing:
    def test_share_read_then_remove(self, private_test_dataset, second_user):
        ds = private_test_dataset
        login, other = second_user
        views = other.girder.get(
            "dataset_view", parameters={"datasetId": ds.id, "limit": 0}
        )
        assert views == []
        assert not _can_read(other, ds.id)

        ds.sharing.share(login, access="read")

        assert _user_levels(ds)[login] == 0
        assert _can_read(other, ds.id)
        assert other.dataset(ds.id).id == ds.id
        # The view and its collection are shared too, so the dataset
        # opens in the web app with its configuration.
        views = other.girder.get(
            "dataset_view", parameters={"datasetId": ds.id, "limit": 0}
        )
        assert len(views) == 1
        other.girder.get(f"upenn_collection/{views[0]['configurationId']}")

        ds.sharing.share(login, access="remove")

        assert _has_no_entry(ds, login)
        assert not _can_read(other, ds.id)

    @pytest.mark.parametrize("access, level", [("write", 1), ("admin", 2)])
    def test_share_higher_levels(
        self, private_test_dataset, second_user, access, level
    ):
        ds = private_test_dataset
        login, other = second_user

        ds.sharing.share(login, access=access)
        assert _user_levels(ds)[login] == level
        folder = other.girder.get(f"folder/{ds.id}")
        assert folder["_accessLevel"] == level

        ds.sharing.share(login, access="remove")
        assert _has_no_entry(ds, login)

    def test_set_public_round_trip(self, private_test_dataset, second_user):
        ds = private_test_dataset
        _, other = second_user

        result = ds.sharing.set_public(True)
        assert result["public"] is True
        assert result["datasetViewsUpdated"] == 1
        assert ds.sharing.get_access()["public"] is True
        assert _can_read(other, ds.id)

        ds.sharing.set_public(False)
        assert ds.sharing.get_access()["public"] is False
        assert not _can_read(other, ds.id)

    def test_share_with_data_only_api_key(
        self, private_test_dataset, second_user, client, api_url
    ):
        """share() needs no user/me lookup, so a key scoped to data only
        (for which user/me returns null) can share."""
        ds = private_test_dataset
        login, other = second_user
        key = client.girder.post(
            "api_key",
            parameters={
                "name": f"ni-share-test-{secrets.token_hex(4)}",
                "scope": json.dumps(["core.data.read", "core.data.write"]),
            },
        )
        try:
            scoped = ni.connect(api_url, api_key=key["key"])
            assert scoped.girder.get("user/me") is None

            scoped.dataset(ds.id).sharing.share(login, access="read")
        finally:
            client.girder.delete(f"api_key/{key['_id']}")

        assert _user_levels(ds)[login] == 0
        assert _can_read(other, ds.id)

    def test_collaborator_shares_through_writable_views_only(
        self, client, private_test_dataset, second_user, third_user
    ):
        """A dataset can have a view, and a collection, that the sharer
        can only read. dataset_view/share refuses a whole request that
        names one (403), so share() sends only the views the sharer can
        write, each with its collection."""
        ds = private_test_dataset
        gc = client.girder
        collaborator_login, collaborator = second_user
        target_login, target = third_user
        first_view = gc.get(
            "dataset_view", parameters={"datasetId": ds.id, "limit": 0}
        )[0]
        collection = gc.post(
            "upenn_collection",
            parameters={"folderId": ds.id, "name": "read-only cfg"},
            data={"metadata": json.dumps(CONFIGURATION_METADATA)},
        )
        second_view = None
        try:
            second_view = gc.post(
                "dataset_view",
                json={
                    "datasetId": ds.id,
                    "configurationId": collection["_id"],
                    "layerContrasts": {},
                    "lastLocation": {"xy": 0, "z": 0, "time": 0},
                },
            )
            # READ on the second view and its collection, then WRITE on
            # the first view, its collection and the dataset itself.
            for view, level in ((second_view, 0), (first_view, 1)):
                gc.post(
                    "dataset_view/share",
                    json={
                        "datasetViewIds": [view["_id"]],
                        "userMailOrUsername": collaborator_login,
                        "accessType": level,
                    },
                )

            collaborator.dataset(ds.id).sharing.share(
                target_login, access="read"
            )

            assert _can_read(target, ds.id)
            shared_views = target.girder.get(
                "dataset_view", parameters={"datasetId": ds.id, "limit": 0}
            )
            assert [v["_id"] for v in shared_views] == [first_view["_id"]]
        finally:
            if second_view is not None:
                gc.delete(f"dataset_view/{second_view['_id']}")
            gc.delete(f"upenn_collection/{collection['_id']}")

    def test_last_admin_cannot_remove_themselves(self, client, second_user):
        """Leaving a dataset with no ADMIN is refused by the server, not
        the client: share() sends a self-removal like any other, and
        dataset_view/share answers 400 without changing anything."""
        login, owner = second_user
        gc = owner.girder
        me = gc.get("user/me")
        private = gc.get(
            "folder",
            parameters={
                "parentType": "user", "parentId": me["_id"],
                "name": "Private",
            },
        )[0]
        folder = gc.post(
            "folder",
            parameters={
                "parentType": "folder", "parentId": private["_id"],
                "name": f"ni-share-test-{secrets.token_hex(4)}",
                "metadata": json.dumps({"subtype": "contrastDataset"}),
            },
        )
        collection = view = None
        # Cleanup runs as admin: without the guard the owner is locked out.
        try:
            collection = gc.post(
                "upenn_collection",
                parameters={"folderId": folder["_id"], "name": "cfg"},
                data={"metadata": json.dumps(CONFIGURATION_METADATA)},
            )
            view = gc.post(
                "dataset_view",
                json={
                    "datasetId": folder["_id"],
                    "configurationId": collection["_id"],
                    "layerContrasts": {},
                    "lastLocation": {"xy": 0, "z": 0, "time": 0},
                },
            )

            with pytest.raises(girder_client.HttpError) as refused:
                owner.dataset(folder["_id"]).sharing.share(
                    login, access="remove"
                )
            assert refused.value.status == 400
            assert gc.get(f"folder/{folder['_id']}")["_accessLevel"] == 2
        finally:
            if view is not None:
                client.girder.delete(f"dataset_view/{view['_id']}")
            if collection is not None:
                client.girder.delete(
                    f"upenn_collection/{collection['_id']}"
                )
            client.girder.delete(f"folder/{folder['_id']}")


@pytest.fixture
def private_project(client, private_test_dataset):
    """A temporary project holding ``private_test_dataset``."""
    project = client.create_project(
        f"ni-share-test-project-{secrets.token_hex(4)}"
    )
    try:
        project.add_dataset(private_test_dataset.id)
        yield project, private_test_dataset
    finally:
        project.delete()


class TestLiveProjectSharing:
    def test_share_read_then_remove(self, private_project, second_user):
        project, ds = private_project
        login, other = second_user
        assert not _can_read(other, ds.id)

        project.share(login, access="read")

        users = project.get_access()["users"]
        assert {u["login"]: u["level"] for u in users}[login] == 0
        assert other.project(project.id).id == project.id
        # Project sharing propagates to the datasets it contains.
        assert _can_read(other, ds.id)

        project.share(login, access="remove")

        assert not _can_read(other, ds.id)

    def test_set_public_round_trip(self, private_project, second_user):
        project, ds = private_project
        _, other = second_user

        assert project.set_public(True)["public"] is True
        assert project.get_access()["public"] is True
        assert _can_read(other, ds.id)

        assert project.set_public(False)["public"] is False
        assert not _can_read(other, ds.id)
