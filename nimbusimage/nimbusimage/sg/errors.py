"""Errors raised by the Spatial Genomics ingest."""


class SGError(Exception):
    """A Spatial Genomics export, input file, or upload does not match
    expectations.

    Raised instead of writing wrong data: a missing file, labels that do not
    join, a cell map of another dataset or ROI, a server that created fewer
    annotations than were sent.
    """
