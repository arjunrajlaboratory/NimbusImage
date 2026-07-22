"""
Tests for the admin-only active-users usage metric
(GET /api/v1/system/active_users).
"""
import datetime

import pytest
from pytest_girder.assertions import assertStatus, assertStatusOk

from girder.models.token import Token


def ageToken(token, days):
    """Backdate a token's ``created`` timestamp by ``days`` days."""
    token["created"] = datetime.datetime.utcnow() - datetime.timedelta(
        days=days
    )
    return Token().save(token)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestActiveUsers:
    def testCountsDistinctUsersDeduplicated(self, admin, user, server):
        # Two tokens for the same user must count once.
        Token().createToken(user=user)
        Token().createToken(user=user)
        Token().createToken(user=admin)

        resp = server.request(
            path="/system/active_users", method="GET", user=admin,
            params={"window": "1d"},
        )
        assertStatusOk(resp)
        # Distinct users active in the last day: admin and user. The request
        # itself is authenticated with an admin token, which is also within
        # the window.
        assert resp.json["activeUsers"] == 2
        assert resp.json["window"] == "1d"
        assert resp.json["windowSeconds"] == 86400

    def testExcludesTokensOutsideWindow(self, admin, user, server):
        # A stale token for ``user`` should fall outside a 1d window, leaving
        # only the admin token created to serve the request.
        ageToken(Token().createToken(user=user), days=10)

        resp = server.request(
            path="/system/active_users", method="GET", user=admin,
            params={"window": "1d"},
        )
        assertStatusOk(resp)
        assert resp.json["activeUsers"] == 1

        # Widening the window past the stale token includes ``user`` again.
        resp = server.request(
            path="/system/active_users", method="GET", user=admin,
            params={"window": "30d"},
        )
        assertStatusOk(resp)
        assert resp.json["activeUsers"] == 2

    def testDefaultsToOneDay(self, admin, server):
        resp = server.request(
            path="/system/active_users", method="GET", user=admin,
        )
        assertStatusOk(resp)
        assert resp.json["window"] == "1d"
        assert resp.json["windowSeconds"] == 86400

    def testRequiresAdmin(self, user, server):
        resp = server.request(
            path="/system/active_users", method="GET", user=user,
        )
        assertStatus(resp, 403)

    def testRequiresAuthentication(self, server):
        resp = server.request(path="/system/active_users", method="GET")
        assertStatus(resp, 401)

    @pytest.mark.parametrize("window", ["abc", "0d", "-1d", "5x", "9999d"])
    def testRejectsInvalidWindow(self, admin, server, window):
        resp = server.request(
            path="/system/active_users", method="GET", user=admin,
            params={"window": window},
        )
        assertStatus(resp, 400)
