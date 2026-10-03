"""Per-test reset of girder model state, shared by the plugins' conftests.

Kept out of conftest.py so another plugin's test suite (SpatialPlugin) can
import it without pulling in this conftest's fixtures and import-time setup.
"""

from girder import events


def dropStaleModelState():
    """Drop model singletons and event handlers left over from earlier tests.

    pytest-girder's ``db`` fixture resets each model class's ``_instance``
    after a test but never removes the old instance from girder's
    ``model_base._modelSingletons`` list. Its setup then calls
    ``reconnect()`` (which re-creates indexes) on every entry, so each test
    re-indexed every model created by every earlier test: setup cost grew
    linearly through the run and the suite's runtime quadratically (over an
    hour in CI). See codebaseDocumentation/BACKEND_CI_PERFORMANCE.md.

    The stale instances' event handlers must go too. Models bind handlers
    under fixed names, so a stale instance keeps receiving events until a
    fresh instance rebinds the name, and it would then run against a closed
    client.
    """
    from girder.models import model_base

    stale = {
        id(model) for model in model_base._modelSingletons
        if type(model)._instance is not model
    }
    for handlers in events._mapping.values():
        for handlerName in [
            name for name, handler in handlers.items()
            if id(getattr(handler, "__self__", None)) in stale
        ]:
            del handlers[handlerName]
    model_base._modelSingletons[:] = [
        model for model in model_base._modelSingletons
        if id(model) not in stale
    ]
