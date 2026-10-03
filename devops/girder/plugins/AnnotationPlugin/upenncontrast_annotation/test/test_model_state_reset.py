"""Guards for the per-test model reset in conftest.py.

Without it, every test re-indexed every model created by every earlier test
and the suite's runtime grew quadratically. See
codebaseDocumentation/BACKEND_CI_PERFORMANCE.md.
"""

import pytest

from girder import events
from girder.models import model_base
from girder.models.model_base import Model

from .model_state import dropStaleModelState


class _ProbeModel(Model):
    def initialize(self):
        self.name = "model_state_reset_probe"


# The instance testLeavesAModelBehind creates, for the next test to check.
_leftBehind = []


@pytest.mark.usefixtures("db")
class TestModelStateReset:
    # pytest runs these in definition order, so the first leaves a model for
    # db teardown to turn stale and the second checks it was dropped. That
    # keeps the check meaningful even when this file runs on its own.
    def testLeavesAModelBehind(self):
        _leftBehind.append(_ProbeModel())

    def testNoStaleModelsAtTestStart(self):
        # The autouse fixture ran before this test's db setup, so the
        # reconnect loop only saw live singletons.
        assert _leftBehind, "testLeavesAModelBehind must run first"
        assert _leftBehind[0] not in model_base._modelSingletons
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
