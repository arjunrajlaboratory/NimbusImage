"""Tests for SharingAccessor.

These assert the exact request each method sends, because the server
validates bodies against a JSON schema: a mock that only checks "post
was called" passed while every real ``share()`` call returned 400.
"""

import pytest

from nimbusimage.sharing import SharingAccessor

VIEWS = [
    {"_id": "view_1", "datasetId": "ds_001", "configurationId": "cfg_1"},
    {"_id": "view_2", "datasetId": "ds_001", "configurationId": "cfg_2"},
]


class TestShare:
    @pytest.mark.parametrize(
        "access, access_type",
        [("read", 0), ("write", 1), ("admin", 2), ("remove", -1)],
    )
    def test_share_sends_schema_body(self, mock_gc, access, access_type):
        """Body matches datasetView_share: all of the dataset's view ids,
        the user, and the access code — and nothing else."""
        mock_gc.get.return_value = VIEWS
        SharingAccessor(mock_gc, "ds_001").share(
            "user@test.com", access=access
        )

        mock_gc.get.assert_called_once_with(
            "dataset_view",
            parameters={"datasetId": "ds_001", "limit": 0},
        )
        mock_gc.post.assert_called_once_with(
            "dataset_view/share",
            json={
                "datasetViewIds": ["view_1", "view_2"],
                "userMailOrUsername": "user@test.com",
                "accessType": access_type,
            },
        )

    def test_share_leaves_self_targeting_to_the_server(self, mock_gc):
        """No client-side identity check: any target, the caller
        included, goes straight to dataset_view/share, whose
        requireCanSetUserAccess refuses taking the dataset's creator
        below ADMIN. So share() never needs user/me, and works with a
        data-only API key that can't read it."""
        mock_gc.get.return_value = VIEWS
        SharingAccessor(mock_gc, "ds_001").share("owner", access="remove")

        assert [c.args[0] for c in mock_gc.get.call_args_list] == [
            "dataset_view"
        ]
        mock_gc.post.assert_called_once_with(
            "dataset_view/share",
            json={
                "datasetViewIds": ["view_1", "view_2"],
                "userMailOrUsername": "owner",
                "accessType": -1,
            },
        )

    def test_share_without_views_raises_before_posting(self, mock_gc):
        mock_gc.get.return_value = []
        with pytest.raises(ValueError, match="no dataset views"):
            SharingAccessor(mock_gc, "ds_001").share("user@test.com")
        mock_gc.post.assert_not_called()

    def test_share_invalid_access_raises_before_any_request(self, mock_gc):
        with pytest.raises(ValueError, match="Invalid access level"):
            SharingAccessor(mock_gc, "ds_001").share(
                "user@test.com", access="owner"
            )
        mock_gc.get.assert_not_called()
        mock_gc.post.assert_not_called()


class TestSetPublic:
    @pytest.mark.parametrize(
        "public, flag", [(True, "true"), (False, "false")]
    )
    def test_set_public_sends_query_params(self, mock_gc, public, flag):
        mock_gc.post.return_value = {"dataset": "ds_001", "public": public}
        result = SharingAccessor(mock_gc, "ds_001").set_public(public)

        mock_gc.post.assert_called_once_with(
            "dataset_view/set_public",
            parameters={"datasetId": "ds_001", "public": flag},
        )
        assert result == {"dataset": "ds_001", "public": public}


class TestGetAccess:
    def test_get_access_path(self, mock_gc):
        mock_gc.get.return_value = {"users": [], "public": False}
        result = SharingAccessor(mock_gc, "ds_001").get_access()

        mock_gc.get.assert_called_once_with("dataset_view/access/ds_001")
        assert result == {"users": [], "public": False}
