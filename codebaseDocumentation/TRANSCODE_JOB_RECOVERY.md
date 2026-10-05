# Transcode job recovery (missed notification)

`addMultiSourceMetadata` (`src/store/index.ts`) starts a transcode with
`POST item/:id/tiles?force=true&localJob=true`. That request runs the job
in-process (girder_large_image `createLocalJob`, synchronous) and returns
only once the job is done. The job's events reach the browser over the
notification WebSocket; the jobs store buffers them in `messageStore`
until `jobs.addJob` registers the job and replays them.

If the stream was down while the job ran (a Girder restart, a network
drop), its end never arrives and `addJob` waits forever: the
configuration screen hung on "Preparing transcode" though the job had
succeeded. The fix is deliberately local to this call; shared job
tracking (`src/store/jobs.ts`) is unchanged. (A general fix in `jobs.ts`,
#1370, was reverted in #1371 because it touched every job's tracking.)

## How it works

`supplyMissedJobEnd`, run after the request returns and before `addJob`:

1. If the stream has already buffered the job's end (the usual case), do
   nothing -- no extra request.
2. Otherwise wait up to `STREAM_GRACE_MS` (2 s, on the wall clock so a
   throttled background tab cannot stretch it) for a merely late stream.
3. Then read the job (`GirderAPI.getJobInfo`), retrying with backoff
   (2/4/8/16 s) and stopping early if the stream delivers the end while a
   read or the retries wait.
4. If the job has finished and the stream still has not delivered its end,
   buffer the missing events with `jobs.storeMessage`: the log entries the
   stream did not carry (those it did form a prefix of the job's log),
   then the final status. `addJob` replays them exactly as if the stream
   had delivered them -- per-entry progress, the usual toasts, the quota
   message and cleanup all go through the normal path.
5. An unreadable or unfinished job is left to the stream, as before.

## Live progress and gateway timeouts

Girder 5's jobs plugin runs local jobs synchronously (Girder 3 ran them on
a background thread, and large_image passed `asynchronous=True`), which is
why the request blocks. Two consequences, both handled in `transcodeItem`
without changing the backend path:

- **Progress.** While the request is open, the job's events already reach
  the stream's buffer; the page could not tell they were its own. Its
  status events carry the job document, whose `meta.itemId` names the item
  just uploaded, so the buffer is checked every 250 ms and the job's events
  are passed to the progress display as they arrive. The replay by
  `addJob` skips those already shown (matched by event identity).
- **Proxy timeouts.** Production HAProxy has `timeout server 300s`
  (AWSDeploy `templates/startup_haproxy.tftpl`): a longer transcode gets a
  504 while Girder keeps running the job. On a 504 only, the job is found
  (in the buffer, else by listing `large_image_tiff` jobs for the item) and
  followed to its end. If the stream stays quiet for 30 s the job is read
  (raced against the stream, like the reads above), and its end supplied
  when finished; a job that shows no update -- or cannot be read -- for an
  hour is reported as failed. Any other request error fails the upload as
  before: a dropped connection or a 502 usually means Girder itself went
  down, and the job died with it (it stays `running` in the database
  forever), so following it would only freeze the page.
- **A closed stream** (e.g. after a server restart) is reopened before the
  request starts, the check `addJob` makes, so the job's events arrive live.

Known limits: duplicated log lines if the server kept only the tail of a
very long log or the stream had a gap mid-job; a quota line lost in such a
gap (with the end delivered) is not recovered; a stream more than the
grace period late can repeat a toast and leave its late events buffered.

## Regression checklist

Each invariant names the test that holds it (`src/store/index.test.ts`).

**Healthy stream unchanged**
- A delivered end means no read and no supplied events —
  *"adds nothing when the stream did deliver the end"*.
- A stream that is merely late still delivers the end itself, with no
  read and one toast — *"lets a stream that is merely late deliver the end
  itself"*.
- The stream-path outcomes still hold —
  *"resolves with the item id when transcoding succeeds"*,
  *"surfaces the friendly storage-quota message when the transcode job
  fails due to quota"*.

**Recovery when the stream missed the end**
- The finished job settles through the normal replay: log entry by entry,
  one toast, buffer cleared —
  *"finishes, replaying the log entry by entry, with the usual toast"*.
- The quota message comes from the job's own log —
  *"surfaces the quota message from the finished job's log"*.
- Cancelled is a failure; a job with no log still finishes; a log given as
  one string (the declared `IJob.log` type) is used too —
  *"reports a cancelled job as a failure"*,
  *"finishes a job that has no log"*,
  *"uses a log given as a single string"*.
- Only what the stream did not carry is supplied —
  *"supplies only what the stream had not delivered"*.

**Reads and retries**
- A failed read is retried —
  *"retries a failed read of the job"*.
- Retries, and a read still in flight, stop as soon as the stream delivers
  the end — *"stops retrying the read once the stream delivers the end"*,
  *"does not wait on a stalled read once the stream delivers the end"*.
- An unreadable job leaves the store untouched and waits on the stream —
  *"waits on the stream as before when the job cannot be read"*.

**Live progress and gateway timeouts**
- Progress shows while the request is open, each line once —
  *"shows the job's progress while the request is still running"*.
- Only this item's transcode is shown —
  *"does not show another item's transcode"*.
- A 504 follows the job instead of failing —
  *"follows the job to its end after a gateway timeout"*,
  *"finds the job by listing transcodes when the stream missed its start"*.
- Following is bounded by the job's updates, not by time —
  *"keeps following a job that is still updating"*,
  *"gives up on a job that stops updating"*.
- A stalled read of the job does not hold up an end the stream delivers —
  *"does not wait on a stalled read of the job once the stream delivers the end"*.
- Only this item's transcode job is shown, not its cache jobs —
  *"does not show other jobs on the same item"*.
- A closed stream is reopened before the job starts —
  *"reopens a closed stream before the job starts"*.
- Other failures fail as before, with the request's own error —
  *"fails with the request's error when no job started"*,
  *"reports the gateway timeout when the jobs cannot be listed"*,
  *"fails as before when the request fails otherwise"*.

**Process**
- Verify live, not only in tests: open the configuration page for a
  folder of ND2 tiles, assign XY and tick Composite (transcode turns on),
  run `docker compose restart girder`, then Submit. Without the fix the
  page stays on "Preparing transcoding"; with it, Girder's log shows a
  `GET job/:id` about 2 s after the transcode `POST` returns and the page
  moves on. Also run one submit without a restart and confirm there is no
  read of the transcode job and the progress bar moves before the request
  returns. For a gateway timeout, replace `store.state.main.api.generateTiles`
  in the page with a wrapper that calls the original but rejects with
  `{response: {status: 504}}` after a few seconds: the page should keep
  following the job to its end. Restarting Girder mid-transcode should fail
  promptly with "Network Error", not hang.
- Editing `src/store/*.ts` under a running dev server breaks Vuex hot
  reload: hard-reload every open tab before trusting it.
