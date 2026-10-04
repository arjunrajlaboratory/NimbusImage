# Job notification recovery

`src/store/jobs.ts` tracks every job the UI waits on (worker runs, property
computations, transcodes, max-merge and histogram caches, the agent's
`wait_for_job`). A job's completion promise resolves when its terminal event
arrives on Girder's notification WebSocket. If that event is lost (a Girder
restart, a network drop, a stream that stays open but goes silent), the promise
used to hang forever. The worst case was the dataset-configuration screen hanging
on "Preparing transcoding".

## Design

- **Reconnect.** `handleClose` reconnects after an unexpected close. The delay
  starts at 1 s, doubles with each failure up to 30 s, and gives up after 10
  failures or when the user is logged out. The failure count resets only after a
  connection has stayed open for 10 s, so a server that accepts the socket and
  drops it at once still backs off. A fresh connection, such as logging in or a
  new job after the reconnects gave up, starts the count again. A job added
  during a backoff waits for the pending reconnect.
- **Re-check on (re)connect.** `handleOpen` runs `reconcileTrackedJobs`. It makes
  one `GET job` request for the current user's *unfinished* jobs, then
  `GET job/:id` only for tracked jobs missing from that list. It lists unfinished
  jobs rather than finished ones because a job that ended long ago behind many
  newer jobs is still found this way.
- **Safety-net poll.** While anything is tracked, a check runs every 15 s on jobs
  that have had no event for 30 s, using the same batched request. This catches
  ends the socket cannot reveal: a drop and reconnect while the job's request was
  in flight, a silent open stream, or reconnects that gave up.
- **Only the current user's jobs** are checked. Another session's jobs, from
  before a logout or token expiry, are never settled in this one, and the poll
  runs only while the current user has tracked jobs.
- **Deleted jobs.** If Girder answers 400 when we read a job, the job no longer
  exists, so it is settled as failed.
- **Settling.** A `settled` flag, set synchronously, dedupes a second report of a
  job's end. The entry leaves `jobInfoMap` only after the end is handled (after
  the awaited notification). Watchers that read the map after the current tick,
  such as ToolItem's outcome icon and the job-log panels, still see a fast job.
- **Recovered logs.** `unseenLogSuffix` delivers only the part of the server's log
  that we have not seen. The server keeps only the tail of a long log, so this
  part is the longest overlap between the end of our log and the start of the
  server's log. If they don't overlap at all, the whole server log is treated as
  new.

## Regression checklist

Drawing on the stream:

- A job that ended while the stream was down still settles, and its listeners
  get its log: *"settles a job that ended while the stream was down"*,
  *"reports a job that had already failed"*.
- A running job keeps waiting on the stream: *"keeps waiting on the stream while
  the job is still running"*.
- A second report of the end is handled once: *"acts once when the stream and
  the status check both report the end"*.
- A job's entry stays in `jobInfoMap` until its end is handled. This test fails if
  `removeJobInfo` moves back to the synchronous point: *"keeps a fast job visible
  to a watcher until its end is handled"*.
- A throwing listener cannot leave a job unsettled: *"settles a job even when a
  listener throws"*.
- A deleted job (Girder answers 400) settles as failed rather than being checked
  forever, while a transient read failure is retried: *"settles a deleted job as
  failed instead of checking it forever"*, *"keeps checking a job it could not
  read for a transient reason"*.

Cost:

- A healthy stream costs no request per job: *"makes no request per job while
  the stream is healthy"*.
- The poll makes one list request, and reads only jobs that ended: *"checks jobs
  that go quiet with one list of unfinished jobs"*, *"settles a job missing from
  the unfinished list only once it ended"*.
- Several jobs added at once share one socket: *"opens one stream for several
  jobs added after it gave up"*.

Reconnecting:

- *"reconnects after the stream drops and re-checks pending jobs"*
- Flapping still backs off: *"backs off against a server that accepts then drops
  the socket"*, *"leaves a pending reconnect's backoff alone when a job is
  added"*.
- *"gives up after repeated failures until a new job needs the stream"*, *"resets
  the give-up count on a fresh connection such as login"*
- *"cancels a pending reconnect on a deliberate close"*, *"does not reconnect
  after a deliberate close"*, *"stops reconnecting once logged out"*

Sessions and logs:

- *"does not check another session's jobs"*
- *"delivers only the unseen part of a recovered log"*, *"drops the part of a
  server tail we already saw"*, *"finds the longest overlap, not the first"*,
  *"treats the whole server log as new when nothing overlaps"*

Process: the fake WebSocket in `jobs.test.ts` opens asynchronously, as a browser's
does, so `handleOpen` runs after `addJob` registers the job. Under fake timers,
concurrent dynamic imports of the mocked `./progress` never resolve. Deliver the
terminal events of several jobs one tick apart.
