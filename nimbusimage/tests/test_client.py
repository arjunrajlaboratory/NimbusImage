"""Tests for NimbusClient."""

import os
from unittest.mock import MagicMock, patch

import pytest

from nimbusimage.client import NimbusClient


class TestNimbusClientInit:
    def test_connect_with_token(self):
        with patch("nimbusimage._girder.girder_client.GirderClient") as MockGC:
            mock_gc = MagicMock()
            MockGC.return_value = mock_gc
            mock_gc.get.return_value = {"_id": "user123", "login": "admin"}

            NimbusClient(
                api_url="http://localhost:8080/api/v1",
                token="tok123",
            )
            mock_gc.setToken.assert_called_with("tok123")

    def test_connect_with_username_password(self):
        with patch("nimbusimage._girder.girder_client.GirderClient") as MockGC:
            mock_gc = MagicMock()
            MockGC.return_value = mock_gc
            mock_gc.get.return_value = {"_id": "user123", "login": "admin"}

            NimbusClient(
                api_url="http://localhost:8080/api/v1",
                username="admin",
                password="password",
            )
            mock_gc.authenticate.assert_called_with(
                username="admin", password="password"
            )

    def test_connect_with_env_vars(self):
        with patch("nimbusimage._girder.girder_client.GirderClient") as MockGC:
            mock_gc = MagicMock()
            MockGC.return_value = mock_gc
            mock_gc.get.return_value = {"_id": "user123", "login": "admin"}

            with patch.dict(os.environ, {
                "NI_API_URL": "http://env:8080/api/v1",
                "NI_TOKEN": "envtoken",
            }):
                client = NimbusClient()
                assert client.api_url == "http://env:8080/api/v1"
                mock_gc.setToken.assert_called_with("envtoken")

    def test_connect_no_credentials_raises(self):
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(ValueError, match="api_url must be provided"):
                NimbusClient()

    def test_connect_anonymous(self):
        with patch("nimbusimage._girder.girder_client.GirderClient") as MockGC:
            mock_gc = MagicMock()
            MockGC.return_value = mock_gc

            NimbusClient(
                api_url="http://localhost:8080/api/v1",
                anonymous=True,
            )
            mock_gc.authenticate.assert_not_called()
            mock_gc.setToken.assert_not_called()

    def test_connect_anonymous_ignores_env_credentials(self):
        """anonymous=True must not silently authenticate from env vars."""
        with patch("nimbusimage._girder.girder_client.GirderClient") as MockGC:
            mock_gc = MagicMock()
            MockGC.return_value = mock_gc

            with patch.dict(os.environ, {
                "NI_API_URL": "http://env:8080/api/v1",
                "NI_API_KEY": "envkey",
            }):
                NimbusClient(anonymous=True)
            mock_gc.authenticate.assert_not_called()
            mock_gc.setToken.assert_not_called()

    def test_connect_anonymous_with_credentials_raises(self):
        with patch("nimbusimage._girder.girder_client.GirderClient"):
            with pytest.raises(ValueError, match="anonymous"):
                NimbusClient(
                    api_url="http://localhost:8080/api/v1",
                    anonymous=True,
                    token="tok123",
                )


class TestNimbusClientProperties:
    def test_girder_escape_hatch(self, mock_gc):
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"
        client._frontend_url = "http://localhost:5173"
        assert client.girder is mock_gc

    def test_token_property(self, mock_gc):
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"
        client._frontend_url = "http://localhost:5173"
        assert client.token == "test-token-abc123"


class TestNimbusClientDataset:
    def test_dataset_by_id(self, mock_gc):
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"
        client._frontend_url = "http://localhost:5173"

        ds = client.dataset("folder_123")
        assert ds.id == "folder_123"

    def test_dataset_by_name(self, mock_gc):
        mock_gc.get.return_value = [
            {"_id": "folder_123", "name": "My Dataset", "meta": {}},
        ]
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"
        client._frontend_url = "http://localhost:5173"

        ds = client.dataset(name="My Dataset")
        assert ds.id == "folder_123"
        # The search returns 10 matches by default; an exact name behind
        # 10 longer prefix matches must still be found.
        assert mock_gc.get.call_args.kwargs["parameters"]["limit"] == 0

    def test_list_projects_requests_every_page(self, mock_gc):
        mock_gc.get.return_value = []
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client.list_projects()
        mock_gc.get.assert_called_once_with(
            "project", parameters={"limit": 0}
        )

    def test_dataset_by_name_not_found(self, mock_gc):
        mock_gc.get.return_value = []
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"
        client._frontend_url = "http://localhost:5173"

        with pytest.raises(ValueError, match="not found"):
            client.dataset(name="Nonexistent")


class TestNimbusClientCreateDataset:
    def _client(self, mock_gc):
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"
        client._frontend_url = "http://localhost:5173"
        return client

    def test_create_dataset_uses_createFolder(self, mock_gc):
        """girder_client's createFolder (which JSON-encodes metadata itself)
        is used rather than a hand-rolled POST."""
        mock_gc.createFolder.return_value = {"_id": "newfolder"}
        client = self._client(mock_gc)

        ds = client.create_dataset(
            "My Experiment", description="desc", parent_folder_id="parent1"
        )
        assert ds.id == "newfolder"
        mock_gc.createFolder.assert_called_once_with(
            "parent1",
            "My Experiment",
            description="desc",
            metadata={
                "subtype": "contrastDataset",
                "selectedLargeImageId": None,
            },
        )

    def test_create_dataset_defaults_to_private_folder(self, mock_gc):
        """The Private folder is found with listFolder(name=...), not by
        fetching every top-level folder and scanning client-side."""
        mock_gc.get.return_value = {"_id": "user123", "login": "admin"}
        mock_gc.listFolder.return_value = iter(
            [{"_id": "privfolder", "name": "Private"}]
        )
        mock_gc.createFolder.return_value = {"_id": "newfolder"}
        client = self._client(mock_gc)

        client.create_dataset("My Experiment")
        mock_gc.listFolder.assert_called_once_with(
            "user123", parentFolderType="user", name="Private"
        )
        assert mock_gc.createFolder.call_args[0][0] == "privfolder"

    def test_create_dataset_no_private_folder_raises(self, mock_gc):
        mock_gc.get.return_value = {"_id": "user123", "login": "admin"}
        mock_gc.listFolder.return_value = iter([])
        client = self._client(mock_gc)

        with pytest.raises(ValueError, match="No Private folder"):
            client.create_dataset("My Experiment")


def _bare_client(mock_gc):
    client = NimbusClient.__new__(NimbusClient)
    client._gc = mock_gc
    client._api_url = "http://localhost:8080/api/v1"
    client._frontend_url = "http://localhost:5173"
    return client


def _serve(mock_gc, views, me=None):
    """Answer GET dataset_view and GET user/me by path."""
    me = me or {"_id": "me", "admin": False, "groups": []}

    def get(path, parameters=None, **kwargs):
        if path == "dataset_view":
            return views
        if path == "user/me":
            return me
        raise AssertionError(f"unexpected GET {path}")

    mock_gc.get.side_effect = get


class TestAccessLevel:
    """Mirrors Girder's AccessControlledModel.getAccessLevel for a
    logged-in user, so batched results keep GET folder's _accessLevel."""

    def test_access_level_follows_girder_rules(self):
        from nimbusimage.client import _access_level

        me = {"_id": "me", "admin": False, "groups": ["g1"]}
        doc = {"access": {
            "users": [{"id": "me", "level": 0}, {"id": "x", "level": 2}],
            "groups": [{"id": "g1", "level": 1}, {"id": "g2", "level": 2}],
        }}
        assert _access_level(doc, me) == 1  # best of own and group grants
        assert _access_level(doc, {**me, "admin": True}) == 2
        # Public does not count for a logged-in user (Girder's rule).
        assert _access_level({"public": True, "access": {}}, me) == -1

    def test_server_provided_level_wins(self, mock_gc):
        _serve(mock_gc, [{"_id": "v1", "datasetId": "f1"}])
        mock_gc.post.return_value = {"folder": {"f1": {
            "_id": "f1", "name": "A", "_accessLevel": 2, "access": {},
        }}}
        [dataset] = _bare_client(mock_gc).list_datasets()
        assert dataset["_accessLevel"] == 2


class TestNimbusClientListDatasets:
    def test_list_datasets_batches_the_folder_lookup(self, mock_gc):
        """One resource/batch call for every dataset, not a GET per folder;
        view order is kept and repeated datasets appear once."""
        _serve(mock_gc, [
            {"_id": "v1", "datasetId": "f2", "configurationId": "c1"},
            {"_id": "v2", "datasetId": "f1", "configurationId": "c2"},
            {"_id": "v3", "datasetId": "f2", "configurationId": "c3"},
        ])
        mock_gc.post.return_value = {"folder": {
            "f1": {"_id": "f1", "name": "Dataset A"},
            "f2": {"_id": "f2", "name": "Dataset B"},
        }}

        datasets = _bare_client(mock_gc).list_datasets()

        assert [d["name"] for d in datasets] == ["Dataset B", "Dataset A"]
        mock_gc.get.assert_any_call("dataset_view", parameters={"limit": 0})
        assert not any(
            c.args[0].startswith("folder/")
            for c in mock_gc.get.call_args_list
        )
        mock_gc.post.assert_called_once_with(
            "resource/batch", json={"folder": ["f2", "f1"]}
        )

    def test_list_datasets_keeps_only_the_public_folder_fields(
        self, mock_gc,
    ):
        """resource/batch returns raw documents; the ACL (other users' ids
        and levels) must not leak into the result."""
        _serve(mock_gc, [{"_id": "v1", "datasetId": "f1"}])
        mock_gc.post.return_value = {"folder": {"f1": {
            "_id": "f1", "name": "A", "meta": {"subtype": "contrastDataset"},
            "parentId": "p1", "lowerName": "a",
            "access": {"users": [
                {"id": "someone", "level": 2}, {"id": "me", "level": 1},
            ]},
        }}}

        [dataset] = _bare_client(mock_gc).list_datasets()
        assert dataset == {
            "_id": "f1", "name": "A",
            "meta": {"subtype": "contrastDataset"}, "parentId": "p1",
            "_accessLevel": 1, "_modelType": "folder",
        }

    def test_list_datasets_skips_unreadable_folders(self, mock_gc):
        """A view can be shared while its folder is not; resource/batch
        omits that folder and so does the result."""
        _serve(mock_gc, [
            {"_id": "v1", "datasetId": "f1"},
            {"_id": "v2", "datasetId": "f2"},
        ])
        mock_gc.post.return_value = {"folder": {
            "f2": {"_id": "f2", "name": "Dataset B"},
        }}

        datasets = _bare_client(mock_gc).list_datasets()
        assert [d["name"] for d in datasets] == ["Dataset B"]

    def test_list_datasets_without_views_makes_no_lookup(self, mock_gc):
        mock_gc.get.return_value = []
        assert _bare_client(mock_gc).list_datasets() == []
        mock_gc.post.assert_not_called()

    def test_anonymous_list_datasets_fetches_public_folders(self, mock_gc):
        """resource/batch requires a user, so an anonymous client fetches
        each folder and skips only the ones it cannot read."""
        import girder_client

        mock_gc.token = ""
        mock_gc.get.side_effect = [
            [
                {"_id": "v1", "datasetId": "f1"},
                {"_id": "v2", "datasetId": "f2"},
            ],
            girder_client.HttpError(403, "denied", "url", "GET"),
            {"_id": "f2", "name": "Dataset B", "meta": {}},
        ]

        datasets = _bare_client(mock_gc).list_datasets()
        assert [d["name"] for d in datasets] == ["Dataset B"]
        mock_gc.post.assert_not_called()

    def test_anonymous_list_datasets_propagates_unexpected_errors(
        self, mock_gc,
    ):
        mock_gc.token = ""
        mock_gc.get.side_effect = [
            [{"_id": "v1", "datasetId": "f1"}],
            RuntimeError("boom"),
        ]
        with pytest.raises(RuntimeError, match="boom"):
            _bare_client(mock_gc).list_datasets()


class TestJobLookup:
    def test_job_by_id_wraps_the_girder_job(self):
        with patch("nimbusimage._girder.girder_client.GirderClient") as MockGC:
            mock_gc = MagicMock()
            MockGC.return_value = mock_gc
            mock_gc.get.return_value = {"_id": "user123", "login": "admin"}
            client = NimbusClient(
                api_url="http://localhost:8080/api/v1", token="tok",
            )
            mock_gc.get.return_value = {"_id": "job1", "status": 3}
            job = client.job("job1")
            mock_gc.get.assert_called_with("job/job1")
            assert job.id == "job1"

    def test_job_by_id_401_names_the_missing_permission(self):
        # client.job(id) fetches before a Job exists; a key without
        # 'List and read jobs' must get the same hint as refresh(), not
        # Girder's raw scope error.
        import json

        from girder_client import HttpError

        with patch("nimbusimage._girder.girder_client.GirderClient") as MockGC:
            mock_gc = MagicMock()
            MockGC.return_value = mock_gc
            mock_gc.get.return_value = {"_id": "user123", "login": "admin"}
            client = NimbusClient(
                api_url="http://localhost:8080/api/v1", token="tok",
            )
            mock_gc.get.side_effect = HttpError(
                status=401,
                text=json.dumps({
                    "message": "Invalid token scope.\nRequired: "
                    "jobs.job_job1.\nAllowed: core.data.read",
                    "type": "access",
                }),
                url="job/job1",
                method="GET",
            )
            with pytest.raises(PermissionError, match="List and read jobs"):
                client.job("job1")


class TestCountAnnotations:
    def _client(self, mock_gc):
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        return client

    def test_one_request_with_filters(self, mock_gc):
        mock_gc.post.return_value = {"counts": [
            {"datasetId": "a", "count": 3},
            {"datasetId": "b", "error": "not found or not readable"},
        ]}
        rows = self._client(mock_gc).count_annotations(
            ["a", "b", "a"], shape="point", tags=["spot"]
        )
        mock_gc.post.assert_called_once_with(
            "upenn_annotation/counts",
            json={"datasetIds": ["a", "b"], "shape": "point",
                  "tags": ["spot"]},
        )
        assert rows[1]["error"]

    def test_batches_past_the_server_cap(self, mock_gc):
        from nimbusimage import client as client_module
        ids = [f"d{i}" for i in range(client_module._COUNT_BATCH + 1)]
        mock_gc.post.side_effect = lambda url, json: {"counts": [
            {"datasetId": i, "count": 1} for i in json["datasetIds"]
        ]}
        rows = self._client(mock_gc).count_annotations(ids)
        assert [r["datasetId"] for r in rows] == ids
        assert mock_gc.post.call_count == 2

    def test_tags_must_be_a_list(self, mock_gc):
        with pytest.raises(TypeError):
            self._client(mock_gc).count_annotations(["a"], tags="spot")


def test_count_annotations_refuses_a_bare_dataset_id():
    from unittest.mock import MagicMock

    import pytest

    from nimbusimage.client import NimbusClient
    client = NimbusClient.__new__(NimbusClient)
    client._gc = MagicMock()
    with pytest.raises(TypeError, match="dataset_ids"):
        client.count_annotations("6512abcdef0123456789abcd")
    client._gc.post.assert_not_called()
