"""Tests for SharingAccessor."""

from nimbusimage.sharing import SharingAccessor


class TestSharingAccessor:
    def test_share_read(self, mock_gc):
        accessor = SharingAccessor(mock_gc, "ds_001")
        accessor.share("user@test.com", access="read")
        mock_gc.post.assert_called_once()
        body = mock_gc.post.call_args[1]["json"]
        assert body["userMailOrUsername"] == "user@test.com"
        assert body["accessType"] == 0  # READ

    def test_share_write(self, mock_gc):
        accessor = SharingAccessor(mock_gc, "ds_001")
        accessor.share("user@test.com", access="write")
        body = mock_gc.post.call_args[1]["json"]
        assert body["accessType"] == 1  # WRITE

    def test_share_remove(self, mock_gc):
        accessor = SharingAccessor(mock_gc, "ds_001")
        accessor.share("user@test.com", access="remove")
        body = mock_gc.post.call_args[1]["json"]
        assert body["accessType"] == -1

    def test_set_public(self, mock_gc):
        accessor = SharingAccessor(mock_gc, "ds_001")
        accessor.set_public(True)
        mock_gc.post.assert_called_once()

    def test_get_access(self, mock_gc):
        mock_gc.get.return_value = {"users": [], "public": False}
        accessor = SharingAccessor(mock_gc, "ds_001")
        result = accessor.get_access()
        assert "public" in result
