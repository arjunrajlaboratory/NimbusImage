import platform
import sys

import pytest

from girder import events


def _restoreVariadicTIFFGetField():
    """Undo large_image_source_tiff's ``TIFFGetField.argtypes = None`` on
    Apple Silicon.

    ``TIFFGetField`` is variadic. The Apple arm64 ABI passes variadic
    arguments on the stack, but ctypes only knows to do so for the
    arguments past a declared ``argtypes`` list. With ``argtypes = None``
    (set by ``large_image_source_tiff.tiff_reader.patchLibtiff`` on import),
    the output pointer goes in a register, libtiff reads a garbage pointer
    off the stack and writes the tag value through it: a segfault in
    ``GetField`` whose timing depends on what the stack held, i.e. on
    which tests ran before. On Linux (the Girder container, CI) variadic
    and fixed arguments travel the same way, so nothing breaks there.
    Restoring pylibtiff's own two fixed arguments makes the rest variadic.
    """
    if sys.platform != "darwin" or platform.machine() != "arm64":
        return
    try:
        # Importing applies large_image's patch; undo it after.
        import large_image_source_tiff.tiff_reader  # noqa: F401
        from libtiff import libtiff_ctypes
    except ImportError:
        return
    libtiff_ctypes.libtiff.TIFFGetField.argtypes = [
        libtiff_ctypes.TIFF, libtiff_ctypes.c_ttag_t,
    ]


_restoreVariadicTIFFGetField()


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
