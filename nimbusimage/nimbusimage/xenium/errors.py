"""Errors raised by the Xenium ingest."""


class XeniumError(Exception):
    """A Xenium bundle, input file, or upload does not match expectations.

    Raised instead of writing wrong data: a missing gene, a malformed
    alignment, annotations out of ``cell_index`` order, a server that
    created fewer annotations than were sent.
    """
