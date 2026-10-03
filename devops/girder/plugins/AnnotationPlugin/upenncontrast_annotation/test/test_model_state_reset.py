"""Guards for the per-test model reset in conftest.py.

Without it, every test re-indexed every model created by every earlier test
and the suite's runtime grew quadratically. See
codebaseDocumentation/BACKEND_CI_PERFORMANCE.md.
"""

import pytest

from girder import events
from girder.models import model_base
from girder.models.model_base import Model

from .conftest import dropStaleModelState


class _ProbeModel(Model):
    def initialize(self):
        self.name = "model_state_reset_probe"


@pytest.mark.usefixtures("db")
class TestModelStateReset:
    def testNoStaleModelsAtTestStart(self):
        # The autouse fixture ran before this test's db setup, so the
        # reconnect loop only saw live singletons.
        assert all(
            type(model)._instance is model
            for model in model_base._modelSingletons
        )

    def testDropsStaleModelsAndTheirHandlers(self):
        stale = _ProbeModel()
        events.bind("probe.event", "probe.stale", lambda event: None)
        events.bind("probe.event", "probe.staleMethod", stale.reconnect)
        _ProbeModel._instance = None  # what pytest-girder's teardown does
        live = _ProbeModel()
        events.bind("probe.event", "probe.liveMethod", live.reconnect)
        try:
            dropStaleModelState()

            assert stale not in model_base._modelSingletons
            assert live in model_base._modelSingletons
            handlers = events._mapping["probe.event"]
            assert "probe.staleMethod" not in handlers
            # Handlers not bound to a stale instance are left alone.
            assert "probe.liveMethod" in handlers
            assert "probe.stale" in handlers
        finally:
            for name in ("probe.stale", "probe.staleMethod",
                         "probe.liveMethod"):
                events.unbind("probe.event", name)
            _ProbeModel._instance = None
            dropStaleModelState()
