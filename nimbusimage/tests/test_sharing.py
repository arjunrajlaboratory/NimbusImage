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

# The caller can write both views and both configurations.
ACCESS = {
    "datasetId": "ds_001",
    "currentUserLevel": 2,
    "writableViewIds": ["view_1", "view_2"],
    "configurations": [
        {"id": "cfg_1", "currentUserLevel": 2},
        {"id": "cfg_2", "currentUserLevel": 1},
    ],
}


def _serve(mock_gc, views=VIEWS, access=ACCESS):
    """Answer share()'s two reads by path."""
    responses = {
        "dataset_view": views,
        "dataset_view/access/ds_001": access,
    }
    mock_gc.get.side_effect = lambda path, **kwargs: responses[path]


def _shared_view_ids(mock_gc):
    mock_gc.post.assert_called_once()
    return mock_gc.post.call_args.kwargs["json"]["datasetViewIds"]


class TestShare:
    @pytest.mark.parametrize(
        "access, access_type",
        [("read", 0), ("write", 1), ("admin", 2), ("remove", -1)],
    )
    def test_share_sends_schema_body(self, mock_gc, access, access_type):
        """Body matches datasetView_share: the view ids, the user, and
        the access code, and nothing else."""
        _serve(mock_gc)
        SharingAccessor(mock_gc, "ds_001").share(
            "user@test.com", access=access
        )

        mock_gc.get.assert_any_call(
            "dataset_view",
            parameters={"datasetId": "ds_001", "limit": 0},
        )
        mock_gc.get.assert_any_call("dataset_view/access/ds_001")
        mock_gc.post.assert_called_once_with(
            "dataset_view/share",
            json={
                "datasetViewIds": ["view_1", "view_2"],
                "userMailOrUsername": "user@test.com",
                "accessType": access_type,
            },
        )

    def test_share_skips_views_the_caller_cannot_write(self, mock_gc):
        """dataset_view/share needs WRITE on every view it is sent and
        refuses the whole request (403) otherwise, so a view the caller
        can only read is left out, as the web Share dialog does."""
        _serve(mock_gc, access={**ACCESS, "writableViewIds": ["view_1"]})
        SharingAccessor(mock_gc, "ds_001").share("user@test.com")
        assert _shared_view_ids(mock_gc) == ["view_1"]

    def test_share_skips_views_whose_configuration_is_read_only(
        self, mock_gc
    ):
        """It also needs WRITE on each view's configuration."""
        _serve(mock_gc, access={**ACCESS, "configurations": [
            {"id": "cfg_1", "currentUserLevel": 2},
            {"id": "cfg_2", "currentUserLevel": 0},
        ]})
        SharingAccessor(mock_gc, "ds_001").share("user@test.com")
        assert _shared_view_ids(mock_gc) == ["view_1"]

    def test_share_skips_views_whose_configuration_is_unreadable(
        self, mock_gc
    ):
        """The access list names only configurations the caller can
        read, so an absent one is not writable either."""
        _serve(mock_gc, access={**ACCESS, "configurations": [
            {"id": "cfg_1", "currentUserLevel": 2},
        ]})
        SharingAccessor(mock_gc, "ds_001").share("user@test.com")
        assert _shared_view_ids(mock_gc) == ["view_1"]

    def test_share_without_write_on_the_dataset_raises_before_posting(
        self, mock_gc
    ):
        """The server also needs WRITE on the dataset folder. A READ
        collaborator can still own a view and its collection (one they
        made), which would otherwise pass the per-view filter."""
        _serve(mock_gc, access={**ACCESS, "currentUserLevel": 0})
        with pytest.raises(ValueError, match="WRITE access on dataset"):
            SharingAccessor(mock_gc, "ds_001").share("user@test.com")
        mock_gc.post.assert_not_called()

    def test_share_reports_missing_write_before_listing_views(
        self, mock_gc
    ):
        """A READ user who can't read any of the views sees no views at
        all; the error must name the permission, not tell them to link a
        collection."""
        _serve(mock_gc, views=[], access={**ACCESS, "currentUserLevel": 0})
        with pytest.raises(ValueError, match="WRITE access on dataset"):
            SharingAccessor(mock_gc, "ds_001").share("user@test.com")
        assert [c.args[0] for c in mock_gc.get.call_args_list] == [
            "dataset_view/access/ds_001"
        ]

    def test_share_with_nothing_writable_raises_before_posting(
        self, mock_gc
    ):
        _serve(mock_gc, access={**ACCESS, "writableViewIds": []})
        with pytest.raises(ValueError, match="can't write"):
            SharingAccessor(mock_gc, "ds_001").share("user@test.com")
        mock_gc.post.assert_not_called()

    def test_share_leaves_self_targeting_to_the_server(self, mock_gc):
        """No client-side identity check: any target, the caller
        included, goes straight to dataset_view/share. So share() never
        needs user/me, and works with a data-only API key that can't
        read it. (Removing a dataset's last ADMIN is refused by the
        server, not by this client.)"""
        _serve(mock_gc)
        SharingAccessor(mock_gc, "ds_001").share("owner", access="remove")

        assert "user/me" not in [c.args[0] for c in mock_gc.get.call_args_list]
        mock_gc.post.assert_called_once_with(
            "dataset_view/share",
            json={
                "datasetViewIds": ["view_1", "view_2"],
                "userMailOrUsername": "owner",
                "accessType": -1,
            },
        )

    def test_share_without_views_raises_before_posting(self, mock_gc):
        _serve(mock_gc, views=[])
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
