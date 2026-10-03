import pytest

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


@pytest.fixture(autouse=True)
def _resetStaleModelState():
    # Autouse fixtures run before ``db``, so its reconnect loop only sees
    # live models.
    dropStaleModelState()
    yield


def unbindGirderEventsByHandlerName(handlerName):
    for eventName in events._mapping:
        events.unbind(eventName, handlerName)


@pytest.fixture
def unbindLargeImage(db):
    yield True
    unbindGirderEventsByHandlerName("large_image")


@pytest.fixture
def unbindAnnotation(db):
    yield True
    unbindGirderEventsByHandlerName("upenncontrast_annotation")
