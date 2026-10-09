import pytest

from girder import events
# tox installs the annotation plugin editable (-e ../AnnotationPlugin), so its
# test helpers are importable here.
from upenncontrast_annotation.test.model_state import dropStaleModelState


@pytest.fixture(autouse=True)
def _resetStaleModelState():
    # Without this, pytest-girder re-indexes every model created by every
    # earlier test and the suite slows quadratically. See
    # codebaseDocumentation/BACKEND_CI_PERFORMANCE.md. Autouse fixtures run
    # before db, so its reconnect loop only sees live models.
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
