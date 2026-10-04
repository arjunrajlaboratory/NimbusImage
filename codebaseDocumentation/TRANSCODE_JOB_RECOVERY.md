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
   (2/4/8/16 s) and stopping early if the stream delivers the end while
   the retries wait.
4. If the job has finished and the stream still has not delivered its end,
   buffer the missing events with `jobs.storeMessage`: the log entries the
   stream did not carry (those it did form a prefix of the job's log),
   then the final status. `addJob` replays them exactly as if the stream
   had delivered them -- per-entry progress, the usual toasts, the quota
   message and cleanup all go through the normal path.
5. An unreadable or unfinished job is left to the stream, as before.

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
- Cancelled is a failure; a job with no log still finishes —
  *"reports a cancelled job as a failure"*,
  *"finishes a job that has no log"*.
- Only what the stream did not carry is supplied —
  *"supplies only what the stream had not delivered"*.

**Reads and retries**
- A failed read is retried —
  *"retries a failed read of the job"*.
- Retries stop as soon as the stream delivers the end —
  *"stops retrying the read once the stream delivers the end"*.
- An unreadable job leaves the store untouched and waits on the stream —
  *"waits on the stream as before when the job cannot be read"*.

**Process**
- Verify live, not only in tests: open the configuration page for a
  folder of ND2 tiles, assign XY and tick Composite (transcode turns on),
  run `docker compose restart girder`, then Submit. Without the fix the
  page stays on "Preparing transcoding"; with it, Girder's log shows a
  `GET job/:id` about 2 s after the transcode `POST` returns and the page
  moves on. Also run one submit without a restart and confirm there is no
  read of the transcode job.
- Editing `src/store/*.ts` under a running dev server breaks Vuex hot
  reload: hard-reload every open tab before trusting it.
