"""Workers (Docker analysis algorithms) and the jobs they run as."""

from __future__ import annotations

import asyncio
import functools
import time
import weakref
from typing import Literal

import anyio
import girder_client
import requests
from urllib3.exceptions import ConnectTimeoutError, NewConnectionError

from mcp.server.mcpserver.exceptions import ToolError

import nimbusimage as ni

from nimbusimage_mcp import worker_values
from nimbusimage_mcp._common import (
    CACHE_FILL,
    caller_id,
    READ_ONLY,
    WRITES,
    client,
    instrumented,
    settings,
)
from nimbusimage_mcp.tools.datasets import channel_list, channel_names
from nimbusimage_mcp.tools.images import check_location

# Docker marker labels: present means true, whatever the value (often "").
ANNOTATION_LABEL = "isAnnotationWorker"
PROPERTY_LABEL = "isPropertyWorker"
MAX_DESCRIPTION = 200
MAX_TOOLTIP = 200
# The longest a worker-interface fetch takes as a whole, including the
# registration job the first time a worker is asked for (also capped by
# NI_MCP_MAX_JOB_WAIT).
INTERFACE_REQUEST_TIMEOUT = 60
LOG_TAIL = 1500
POLL_SECONDS = 2.0


def worker_roles(labels: dict) -> list[str]:
    """Every role the image's marker labels give it; a worker may have
    both."""
    return [role for role, label in (("annotation", ANNOTATION_LABEL),
                                     ("property", PROPERTY_LABEL))
            if label in labels]


def _trim(text, limit: int):
    if not isinstance(text, str) or len(text) <= limit:
        return text
    return text[:limit - 1] + "…"


@instrumented
def ni_workers_list(
    kind: Literal["annotation", "property", "all"] = "all",
    include_test_images: bool = False,
) -> dict:
    """List the analysis workers installed on this server: annotation
    workers create objects or process images (for example cell or
    nucleus segmentation, spot detection, filters), property workers
    compute measurements (area, intensity). Servers differ in what is
    installed. Returns image, name, roles (annotation, property, or both),
    category, description, and for property workers the annotation shape
    they measure. kind filters by role. Use ni_worker_interface to see a
    worker's parameters.
    """
    rows = []
    for image, labels in sorted(client().list_workers().items()):
        roles = worker_roles(labels)
        if not roles or (kind != "all" and kind not in roles):
            continue
        if image.endswith(":test") and not include_test_images:
            continue
        row = {
            "image": image,
            "name": labels.get("interfaceName") or image,
            "roles": roles,
            "category": labels.get("interfaceCategory"),
            "description": _trim(labels.get("description"), MAX_DESCRIPTION),
        }
        if "property" in roles:
            row["shape"] = labels.get("annotationShape")
        rows.append(row)
    return {"workers": rows}


def in_thread(fn, *args, **kwargs):
    """Run blocking nimbusimage work off the event loop."""
    return anyio.to_thread.run_sync(functools.partial(fn, *args, **kwargs))


def _snapshot(job: ni.Job) -> dict:
    """Refresh the job and copy what the tools report, in the worker
    thread. A refresh abandoned at a deadline still finishes and mutates
    the Job afterwards; a snapshot it never touches."""
    job.refresh()  # also fetches the log
    return _fields(job)


def _fields(job: ni.Job) -> dict:
    return {
        "title": job.title,
        "status": job.status_name,
        "finished": job.finished,
        "succeeded": job.succeeded,
        "log_tail": job.log[-LOG_TAIL:] if job.log else "",
    }


async def poll_job(job: ni.Job, deadline: float) -> dict | None:
    """Refresh the job until it finishes or the (monotonic) deadline, and
    return the last completed snapshot (None if no refresh completed in
    time). Sleeps on the event loop, so a long wait holds none of the
    worker threads every sync tool shares; only the polls use one.
    """
    done, last = await _by_deadline(functools.partial(_snapshot, job),
                                    deadline)
    last = last if done else None
    # Poll only while a whole interval fits before the deadline, so no
    # refresh starts after it (and no two refreshes of a job overlap).
    while not (last and last["finished"]) \
            and deadline - time.monotonic() > POLL_SECONDS:
        await anyio.sleep(POLL_SECONDS)
        done, snap = await _by_deadline(
            functools.partial(_snapshot, job), deadline
        )
        if done:
            last = snap
    return last


async def _by_deadline(fn, deadline: float):
    """Blocking `fn()` in a thread, waited for until the (monotonic)
    deadline: a slow backend must not hold a call past its cap. Returns
    (finished, result). An abandoned call finishes in its thread, within
    the client's HTTP_TIMEOUT per attempt (connect and 5xx retries can
    add attempts)."""
    with anyio.move_on_after(max(0.0, deadline - time.monotonic())):
        return True, await anyio.to_thread.run_sync(
            fn, abandon_on_cancel=True
        )
    return False, None


async def _before(deadline: float, fn, *args, **kwargs):
    """`fn(*args, **kwargs)` in a thread; a ToolError if it does not
    finish by the deadline."""
    done, result = await _by_deadline(
        functools.partial(fn, *args, **kwargs), deadline
    )
    if not done:
        raise ToolError("NimbusImage did not answer in time; try again.")
    return result


# One registration task per image in this process: the server starts a
# worker container for every registration request, so a burst of first
# calls, or a retry while a slow registration is still running, must not
# send another. Callers wait on the task (shielded, up to their own
# deadline); a finished task leaves the registry, so the next call starts
# afresh. Keyed per event loop (production has one).
_registrations: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()
# The longest a registration task follows its job.
REGISTRATION_PENDING_SECONDS = 300


async def _run_registration(nc: ni.NimbusClient, image: str) -> None:
    """Register the image's interface: one POST, then follow it to the
    end. Runs as a task with the first caller's client (it polls that
    caller's own job); its outcome is every waiter's."""
    deadline = time.monotonic() + REGISTRATION_PENDING_SECONDS
    # A task that finished just before this one started may have
    # registered it already.
    if await _interface(nc, image, deadline) is not None:
        return
    try:
        # (A POST still hanging at the task's own deadline raises a
        # ToolError and ends the task: after five minutes, accepted.)
        response = await _before(
            deadline, nc.girder.post, "worker_interface/request",
            parameters={"image": image},
        )
    except girder_client.HttpError as e:
        # Caught first: girder_client.HttpError is also a
        # requests.RequestException. A 502/504 is a proxy giving up after
        # forwarding the request, which Girder may still have acted on:
        # keep it pending. Any other answer is a refusal: nothing runs.
        if e.status not in (502, 504):
            raise
        await _watch_for_interface(nc, image, deadline)
        return
    except requests.RequestException as e:
        if _never_sent(e):
            raise  # nothing reached Girder: the next call may register
        # The request may have reached Girder (only its answer was
        # lost): treat it as running rather than letting a retry send
        # another.
        await _watch_for_interface(nc, image, deadline)
        return
    if not (isinstance(response, list) and response):
        return
    try:
        state = await poll_job(ni.Job(nc.girder, response[0]), deadline)
    except (girder_client.HttpError, PermissionError,
            requests.RequestException):
        # The request was accepted but its job cannot be followed (a key
        # without core.user_auth, a job error, Girder unreachable for a
        # moment): watch for the interface instead, so the registration
        # stays pending rather than ending and letting the next call send
        # another.
        await _watch_for_interface(nc, image, deadline)
        return
    if state is None or not state["finished"]:
        raise _did_not_finish(image)
    if not state["succeeded"]:
        raise ToolError(
            f"{image}'s parameter registration failed ({state['status']}); "
            "try again, or check the worker."
        )


def _did_not_finish(image: str) -> ToolError:
    return ToolError(
        f"{image}'s parameter registration did not finish; try again "
        "later."
    )


def _never_sent(error: requests.RequestException) -> bool:
    """Whether a failed request certainly never reached the server: the
    connection was never opened."""
    if isinstance(error, requests.ConnectTimeout):
        return True
    reason = getattr(error.args[0], "reason", None) if error.args else None
    return isinstance(reason, (NewConnectionError, ConnectTimeoutError))


async def _watch_for_interface(nc: ni.NimbusClient, image: str,
                               deadline: float) -> None:
    """Poll for the interface a registration in flight will produce,
    until the deadline. Transient errors keep waiting; a refusal
    (401/403) is final and raised."""
    while deadline - time.monotonic() > POLL_SECONDS:
        await anyio.sleep(POLL_SECONDS)
        try:
            if await _interface(nc, image, deadline) is not None:
                return
        except girder_client.HttpError as e:
            if e.status in (401, 403):
                raise  # refused for good: report it (_register_once)
            # a 5xx: keep waiting
        except requests.RequestException:
            pass  # unreachable for now: keep waiting
        except ToolError:
            break  # the read ran into the deadline
    raise _did_not_finish(image)


def _interface(nc: ni.NimbusClient, image: str, deadline: float):
    """The image's registered interface (None if there is none yet), read
    by `nc`'s user, by the deadline."""
    return _before(deadline, nc.get_worker_interface, image,
                   request_if_missing=False)


def _registration_task(nc: ni.NimbusClient,
                       image: str) -> tuple[asyncio.Task, str | None]:
    """The running registration of `image`, or a new one; and who
    started it."""
    tasks = _registrations.setdefault(asyncio.get_running_loop(), {})
    entry = tasks.get(image)
    if entry is None or entry[0].done():
        task = asyncio.create_task(_run_registration(nc, image))
        entry = tasks[image] = (task, caller_id())

        def finished(t):
            if tasks.get(image) is entry:
                del tasks[image]  # drop the starter's client with it
            # Mark a failure as seen even if every waiter has given up.
            if not t.cancelled():
                t.exception()

        task.add_done_callback(finished)
    return entry


async def _register_once(nc: ni.NimbusClient, image: str,
                         deadline: float) -> dict | None:
    """Wait (until the deadline) for the image's registration, starting
    one unless one is running, then read the interface as the caller."""
    task, starter = _registration_task(nc, image)
    try:
        with anyio.move_on_after(
            max(0.0, deadline - time.monotonic())
        ) as wait:
            # Shielded: a caller giving up does not cancel the task.
            await asyncio.shield(task)
    except (girder_client.HttpError, PermissionError):
        if starter == caller_id():
            raise  # about this caller's own key: say so
        # Another request's key was refused; that says nothing about
        # this caller's, and nothing is registering now.
        raise ToolError(
            f"{image}'s parameter registration could not be completed; "
            "try again."
        ) from None
    if wait.cancelled_caught:
        raise ToolError(
            f"{image} is still registering its parameters; try again in "
            "a minute."
        )
    return await _interface(nc, image, deadline)


async def fetch_interface(nc: ni.NimbusClient, image: str,
                          labels: dict | None = None) -> dict:
    """The worker's parameter interface, asking the worker to register it
    (a short job) the first time. Bounded as a whole by the job-wait cap,
    since it can wait on that job. `labels`: the image's labels if the
    caller already listed the workers (a slow Docker listing)."""
    deadline = time.monotonic() + max(1.0, min(
        INTERFACE_REQUEST_TIMEOUT, settings().max_job_wait
    ))
    interface = await _interface(nc, image, deadline)
    if interface is None:
        # Registering runs the image on the server, which accepts any
        # name: only ever ask for an installed worker.
        if labels is None:
            labels = (await _before(deadline, nc.list_workers)).get(image)
        if labels is None or not worker_roles(labels):
            raise ToolError(
                f"No worker image {image!r}; use ni_workers_list for names."
            )
        interface = await _register_once(nc, image, deadline)
    if not interface:
        raise ToolError(
            f"{image} has no parameter interface; check the image name "
            "with ni_workers_list."
        )
    return interface


@instrumented
async def ni_worker_interface(
    image: str, dataset_id: str | None = None
) -> dict:
    """The parameters a worker takes (from ni_workers_list): each one's
    name, type, default, min/max, and choices, plus value_formats saying
    the exact value shape each type expects. Pass dataset_id to also get
    that dataset's channel list (index and name), since channel
    parameters take 0-based channel indices. Call before ni_worker_run.
    """
    nc = client()
    # The dataset first: a typo or unreadable id must fail before a
    # cache miss starts a registration job.
    channels = await in_thread(
        channel_list, nc.dataset(dataset_id)
    ) if dataset_id else None
    interface = await fetch_interface(nc, image)
    parameters, notes = [], []
    for name, element in sorted(
        interface.items(), key=lambda item: item[1].get("displayOrder", 0)
    ):
        if element.get("type") == "notes":
            notes.append(_trim(element.get("value"), MAX_TOOLTIP))
            continue
        row = {"name": name, "type": element.get("type")}
        for key in ("default", "min", "max", "step", "items", "unit",
                    "required"):
            if element.get(key) is not None:
                row[key] = element[key]
        if element.get("tooltip"):
            row["tooltip"] = _trim(element["tooltip"], MAX_TOOLTIP)
        parameters.append(row)
    result = {
        "image": image,
        "notes": notes,
        "parameters": parameters,
        "value_formats": {
            kind: worker_values.VALUE_FORMATS[kind]
            for kind in sorted({p["type"] for p in parameters})
            if kind in worker_values.VALUE_FORMATS
        },
    }
    if channels is not None:
        result["channels"] = channels
    return result


@instrumented
async def ni_worker_run(
    dataset_id: str,
    image: str,
    parameters: dict | None = None,
    tags: list[str] | None = None,
    channel: int = 0,
    xy: int = 0,
    z: int = 0,
    time: int = 0,
) -> dict:
    """Run an annotation worker (e.g. Cellpose-SAM segmentation or spot
    detection, from ni_workers_list) on a dataset. It creates annotations
    tagged with `tags` (e.g. ["nucleus"]) and can take minutes. Returns a
    job_id at once; wait with ni_job_wait. `parameters` overrides the
    worker's parameters by name (see ni_worker_interface); the rest use
    their defaults. channel, xy, z, and time choose the image location;
    workers with "Batch XY/Z/Time" parameters process the ranges given
    there. To compute a measurement, use ni_property_compute instead.
    """
    nc = client()
    labels = (await in_thread(nc.list_workers)).get(image)
    if labels is None:
        raise ToolError(
            f"No worker image {image!r}; use ni_workers_list for names."
        )
    if "annotation" not in worker_roles(labels):
        raise ToolError(
            f"{image} is not an annotation worker. Property workers run "
            "through a property: see ni_properties_list and "
            "ni_property_compute."
        )
    ds = nc.dataset(dataset_id)

    def read_dataset():
        # Every read of the dataset here can be an HTTP request, so all
        # of them run in the thread, off the event loop.
        names = channel_names(ds)
        if not 0 <= channel < len(names):
            raise ValueError(
                f"channel={channel} is out of range (0..{len(names) - 1})"
            )
        # A location outside the dataset would start a job that fails.
        check_location(ds, xy, z, time)
        return names, ds.collections.scales

    channels, scales = await in_thread(read_dataset)
    values = worker_values.resolve(
        await fetch_interface(nc, image, labels), parameters or {},
        channels
    )
    job = await in_thread(
        ds.annotations.compute,
        image=image,
        channel=channel,
        tags=tags or [],
        location=ni.Location(xy=xy, z=z, time=time),
        worker_interface=values,
        scales=scales,
        name=labels.get("interfaceName") or image,
    )
    return {"job_id": job.id, "status": job.status_name, "title": job.title}


@instrumented
async def ni_job_wait(job_id: str, timeout_seconds: float = 60) -> dict:
    """Wait for a job started by ni_worker_run or ni_property_compute to
    finish, then report its status and the end of its log. Waits at most
    timeout_seconds (default 60, capped by the server's own limit);
    if the job is still going, the result says finished=false and you can
    call this again with the same job_id. If NimbusImage itself does not
    answer in time, status is "unknown". Do not poll with other tools.
    """
    limit = max(1.0, min(timeout_seconds, settings().max_job_wait))
    # The budget covers the first lookup too.
    deadline = time.monotonic() + limit
    nc = client()
    found, job = await _by_deadline(functools.partial(nc.job, job_id),
                                    deadline)
    if not found:
        return {
            "job_id": job_id, "status": "unknown", "finished": False,
            "succeeded": False,
            "note": "NimbusImage did not answer within the wait; try again.",
        }
    # As looked up (no log yet), in case no refresh completes in time;
    # read before any refresh thread exists.
    looked_up = _fields(job)
    try:
        state = await poll_job(job, deadline)
    except girder_client.HttpError as e:
        # First: girder_client.HttpError is also a RequestException.
        if e.status < 500:
            raise
        state = None
    except requests.RequestException:
        state = None
    else:
        return {"job_id": job_id, **(state or looked_up)}
    # Girder stopped answering mid-wait: report what was known; the job
    # itself is unaffected.
    return {"job_id": job_id, **looked_up,
            "note": "NimbusImage stopped answering during the wait; "
                    "try again."}


TOOLS = [
    (ni_workers_list, READ_ONLY),
    # Not read-only: the first request for a worker registers its
    # interface (a short server job). Nothing the user owns changes.
    (ni_worker_interface, CACHE_FILL),
    (ni_worker_run, WRITES),
    (ni_job_wait, READ_ONLY),
]
