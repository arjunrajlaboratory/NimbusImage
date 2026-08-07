"""Worker role validation shared by the compute accessors.

Annotation workers and property workers are submitted through different
endpoints with different payload formats, and neither endpoint checks
that the Docker image actually matches its worker kind. Submitting a
property worker through ``ds.annotations.compute`` (or vice versa)
produces a job that starts fine and then crashes inside the worker with
a confusing error — e.g. ``AttributeError: 'list' object has no
attribute 'get'`` when a property worker receives an annotation-compute
body whose ``tags`` field is a list instead of a filter dict.

This module cross-checks the image's role labels from
``GET /worker_interface/available`` before submitting, so the mismatch
fails immediately, client-side, with a message naming the correct
accessor.
"""

from __future__ import annotations

import girder_client

ANNOTATION_ROLE_LABEL = "isAnnotationWorker"
PROPERTY_ROLE_LABEL = "isPropertyWorker"

_MISMATCH_MESSAGES = {
    # required_label -> message when only the opposite label is present
    ANNOTATION_ROLE_LABEL: (
        "'{image}' is a property worker (its Docker labels have "
        "isPropertyWorker but not isAnnotationWorker). Submitting it "
        "through ds.annotations.compute sends an annotation-compute "
        "payload (list-valued tags, assignment, tile, connectTo) that "
        "crashes property workers with \"AttributeError: 'list' object "
        "has no attribute 'get'\". Create or get a Property and use "
        "ds.properties.compute(prop, ...) instead."
    ),
    PROPERTY_ROLE_LABEL: (
        "'{image}' is an annotation worker (its Docker labels have "
        "isAnnotationWorker but not isPropertyWorker). Submitting it "
        "through ds.properties.compute sends a property-compute payload "
        "(tags as a {{'tags': [...], 'exclusive': bool}} filter dict) "
        "that annotation workers cannot handle. Use "
        "ds.annotations.compute(...) instead."
    ),
}


def check_worker_role(
    gc: girder_client.GirderClient, image: str, required_label: str
) -> None:
    """Raise ``ValueError`` if ``image`` is known to have the wrong role.

    Role labels (``isAnnotationWorker`` / ``isPropertyWorker``) are
    Docker *marker* labels: their presence defines the role and their
    value is commonly the empty string, so detection is by key presence
    only — never by comparing the value, and never by inspecting the
    image path prefix.

    The check is best-effort and only rejects a *known* mismatch — the
    image lacks ``required_label`` but carries the opposite role label.
    Submission proceeds unvalidated when the role cannot be determined:
    the discovery endpoint errors, the image is not in the listing, or
    the image carries no role labels at all. A worker labeled with both
    roles is valid for either accessor.

    Args:
        gc: The girder client to query.
        image: Docker image name as passed to the compute accessor.
        required_label: ``ANNOTATION_ROLE_LABEL`` or
            ``PROPERTY_ROLE_LABEL`` — the role the calling accessor
            requires.

    Raises:
        ValueError: If the image carries the opposite role label and
            not the required one. The message names the correct
            accessor to use.
    """
    try:
        workers = gc.get("/worker_interface/available")
    except girder_client.HttpError:
        return
    if not isinstance(workers, dict):
        return
    labels = workers.get(image)
    if not isinstance(labels, dict) or required_label in labels:
        return
    wrong_label = (
        PROPERTY_ROLE_LABEL
        if required_label == ANNOTATION_ROLE_LABEL
        else ANNOTATION_ROLE_LABEL
    )
    if wrong_label in labels:
        raise ValueError(
            _MISMATCH_MESSAGES[required_label].format(image=image)
        )
