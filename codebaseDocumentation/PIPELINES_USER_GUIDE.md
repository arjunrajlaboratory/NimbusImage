# Worker Pipelines — Feature Guide

This document describes the **worker pipelines** feature from a user's point of
view. It is written to be dropped into (or summarized for) the NimbusImage
chat assistant's knowledge so the assistant can explain pipelines, guide users
through building and running them, and help troubleshoot. It intentionally
avoids implementation detail — for the architecture and code, see
[`WORKER_PIPELINES.md`](./WORKER_PIPELINES.md).

Audience: end users of NimbusImage (biologists analyzing microscopy images) and
the chat assistant that helps them. Keep explanations concrete and task-focused.

---

## What a pipeline is

A **pipeline** is an ordered list of analysis **steps** that run one after
another on a dataset, with a single click. Each step runs a Docker-based
**worker** — the same workers a user can otherwise run one at a time from the
Tools menu. Chaining them into a pipeline lets a user express a repeatable
recipe like:

> "Detect nuclei, then detect spots inside them, then measure each spot's
> intensity"

and run the whole thing (and re-run it on other datasets) without configuring
each worker by hand every time.

Pipelines are saved **on the dataset's configuration**, which means they are
shared by every dataset in the same collection. Building a pipeline once makes
it available across the collection.

### Two kinds of step

Every step is one of two kinds:

- **Annotation step** — runs an annotation-producing worker (segmentation, spot
  detection, blob finding, etc.). It *creates annotations* on the dataset. Its
  output is described by **tags** and a **shape** (point, polygon, line, …).
- **Property step** — runs a property-computing worker. It *measures* existing
  annotations (area, intensity, count, …) and writes the results as computed
  property values. A property step does not create annotations; it reads them.

The natural order is annotation steps first, then the property steps that
measure what they produced.

### How steps connect: tags

Steps do **not** pass data to each other in memory. Instead, each annotation
step tags the annotations it creates, and each property step selects which
annotations to measure **by tag**. Tags are the glue of a pipeline.

Example: an annotation step tags its output `spots`; a downstream property step
sets its input tags to `spots`, so it measures exactly those annotations.

Because getting these tags to line up by hand is fiddly, the builder does it
automatically (see [Auto-wiring](#auto-wiring-tags) below).

---

## Where to find pipelines in the UI

There are two entry points, both in the dataset viewer:

1. **Pipelines palette** (left side, under the Tools panel). It is **hidden by
   default**; toggle it from the Pipelines icon in the top toolbar (a
   connected-nodes icon, next to the Tools icon). The palette is a compact
   summary: one row per saved pipeline showing its name, step count, an "ai"
   badge if it was AI-suggested, and a live spinner while it is running. An
   **Open pipelines** button opens the full editor.
2. **Object Browser toolbar** — the same Pipelines icon appears in the
   Object Browser's toolbar and opens the full editor directly.

Everything except the at-a-glance summary happens in the **full Pipelines
dialog**, which has three views: the **list**, the **builder**, and the
**run panel**.

---

## Building a pipeline

From the Pipelines dialog list, click **New pipeline** (or **Edit** on an
existing one, or **Duplicate** to copy one) to open the **builder**.

In the builder a user can:

- Set the pipeline's **name** and **description**.
- **Add steps** (see below). Steps appear as an ordered, expandable list.
- **Reorder** steps with the Move up / Move down buttons.
- **Enable/disable** a step. Disabled steps are skipped when the pipeline runs
  (useful for temporarily turning off part of a recipe).
- **Remove** a step.
- **Save** the pipeline (Save is disabled until the pipeline has a name and at
  least one step). Nothing is persisted until Save — closing the builder
  discards unsaved changes, which is how an unwanted AI suggestion is dismissed.

### Adding a step

The **Add step** dialog offers three sources:

1. **Annotation worker** — pick an annotation-producing Docker image from the
   catalog. Creates an annotation step.
2. **Property worker** — pick a property-computing Docker image. Creates a
   property step.
3. **Existing tool** — pick a worker-backed tool that already exists in the
   configuration (the tools a user set up in the Tools panel). This copies that
   tool's worker image, its parameter values, its annotation setup (tags,
   shape, coordinate assignment), and any connection settings into a new
   annotation step — so a user who already tuned a segmentation tool can reuse
   it in a pipeline without re-entering everything. This option is disabled if
   the configuration has no worker-backed tools.

### Configuring a step

Expanding a step shows its editor:

- **Name** and **Enabled** toggle.
- The **worker image** and its **parameters** (the same parameter widgets used
  everywhere else — sigma, threshold, channel, etc., seeded with the worker's
  defaults).
- For **annotation steps**: the **annotation setup** — the output **tags** to
  apply, the **shape**, and the **coordinate assignment** (which layer/channel
  and which Z/Time frames to run on).
- For **property steps**: the **shape** of the annotations to measure and the
  **input tags** that select them, plus an exclusive-match toggle.

### Auto-wiring tags

To spare users from lining tags up by hand, the builder **auto-wires** property
steps: a property step automatically takes its **input tags** and **shape**
from the nearest **enabled annotation step above it**. A caption on the property
step shows what it is wired to (e.g. "Reads tags from step 1 (Cellpose SAM)").

Rules a user should understand:

- Auto-wiring only pulls from **enabled** annotation steps that come **before**
  the property step. A disabled or later annotation step is not a source.
- If a user **manually edits** a property step's input tags or shape, that step
  **detaches** from auto-wiring and keeps the manual value.
- Property steps can only measure certain shapes. The materializable shapes are
  **point, line, and polygon**. If an upstream annotation step uses a shape a
  property can't be computed on (rectangle, circle, ellipse), the property step
  is automatically clamped to **polygon** so it still runs.

---

## Running a pipeline

From the list, click **Run** to open the **run panel** (only one pipeline can
run at a time; Run is disabled while any pipeline is running).

The run panel shows:

- A **Run** button that executes the enabled steps in order, awaiting each
  before starting the next.
- An **overall progress** bar and a **per-step** list, each step showing
  pending / running (with a live progress bar) / success ✓ / failed ✗ /
  skipped.
- A **Cancel** button that stops the run and cancels the currently running job.
- A **Continue running remaining steps if a step fails** checkbox. Off by
  default: the run stops at the first failed step. On: later steps still run.
- **Pre-run warnings** (non-blocking) — e.g. a property step whose input tags
  match neither an upstream step's output nor any tag already on the dataset
  ("it may compute on nothing").
- A **Logs** button per step (see [Job logs](#job-logs-diagnosing-a-worker)).

The run panel keeps working if the dialog is closed and reopened mid-run — it
returns to the live run rather than resetting.

### Materialized properties

The first time a **property step** runs, it creates a persisted property
definition (this is what the compute endpoint needs) and remembers it, reusing
it on later runs. If the step's configuration changes, the old property is
replaced. Deleting a pipeline also removes the properties its property steps
created — unless another pipeline still relies on the same property. When
deleting a pipeline, the confirmation dialog offers a checkbox to keep or remove
those computed properties.

### Running across a whole collection

If the dataset belongs to a collection with **more than one and at most 50**
datasets, the run panel offers **Apply to all datasets in collection**. This
runs the whole pipeline once per dataset in the collection, in sequence, with a
batch progress indicator. The 50-dataset cap is a guard against accidentally
launching a very large batch. Above 50, the option is disabled with an
explanation.

---

## AI-suggested pipelines

From the list, **Suggest with AI ✨** opens the suggestion dialog. The user can
optionally type a goal ("count nuclei and measure their intensity"); the goal
field is optional. NimbusImage sends the goal, the catalog of installed
workers, and context about the dataset (channels, existing tags and shapes) to
Claude, which returns up to **three** suggested pipelines.

Key points for guiding users:

- Suggestions only reference **installed** workers. Any step referencing a
  worker that isn't installed is dropped.
- Suggestions always come **tag-wired**: annotation steps have output tags and
  property steps have matching input tags, so a suggested pipeline is runnable
  as-is.
- A suggestion carries an **"ai"** origin badge.
- Clicking **Use this** opens the suggestion in the **builder** — it is *not*
  saved yet. The user reviews and edits it, and only **Save** commits it. This
  lets a user discard a suggestion they don't want by simply closing the
  builder.

The suggestion feature requires the server to be configured with an Anthropic
API key; if it isn't, the feature is unavailable and returns an error.

---

## Job logs (diagnosing a worker)

When a step is running or has finished, its **Logs** button opens the job log.
The log shows the worker's live output while it runs (streamed) and the full
persisted log after it finishes, including the container invocation, arguments,
status, and duration. There is a copy-to-clipboard button. This is the primary
way to find out **why** a worker failed or produced unexpected results — always
point a user to the step's Logs button when a step shows a failure.

---

## Managing pipelines

From the list, each pipeline row offers:

- **Run** — open the run panel.
- **Edit** — open the builder.
- **Duplicate** — make an independent copy (fresh ids; the copy creates its own
  computed properties on first run).
- **Delete** — remove it (with the keep/remove computed-properties choice).

Pipelines live on the configuration, so they persist across sessions and are
shared by every dataset in the collection.

---

## Glossary

| Term | Meaning |
|---|---|
| **Pipeline** | An ordered list of worker steps saved on a configuration. |
| **Step** | One worker invocation in a pipeline — annotation or property. |
| **Annotation step** | Runs an annotation-producing worker; creates tagged annotations. |
| **Property step** | Runs a property worker; measures existing annotations selected by tag. |
| **Tags** | Labels applied to annotations; how a property step selects what to measure and how steps connect. |
| **Auto-wiring** | The builder copying an upstream annotation step's tags/shape into a downstream property step automatically. |
| **Materializable shapes** | The shapes a property can be computed on: point, line, polygon. |
| **Materialized property** | The persisted property definition a property step creates on first run and reuses. |
| **Origin** | Where a pipeline came from: `user`, `ai`, or `preset`. |
| **Batch run** | Running one pipeline across every dataset in the collection (≤ 50). |

---

## FAQ / assistant answers

**"How do I make a pipeline?"** Open the Pipelines panel (icon in the top
toolbar, next to Tools) or the Pipelines button in the Object Browser, click
New pipeline, add steps (annotation workers, property workers, or existing
tools), and Save. Or click Suggest with AI to have one drafted for you.

**"Why did my property step measure nothing?"** Its input tags probably don't
match any annotations. Property steps select annotations by tag; make sure the
step's input tags match the output tags of the annotation step that produced
them. The builder auto-wires this, but a manual tag edit detaches it. The run
panel shows a pre-run warning for this case.

**"Why did a step fail?"** Open that step's **Logs** button in the run panel to
see the worker's output. That log explains the failure.

**"Can I run a pipeline on all my datasets?"** Yes, if the collection has
between 2 and 50 datasets — check "Apply to all datasets in collection" in the
run panel.

**"My step uses a rectangle shape but the property won't compute."** Properties
can only be computed on point, line, or polygon annotations. Use one of those
shapes for annotation steps that feed a property step (the builder clamps
non-materializable shapes to polygon automatically).

**"Can I reuse a tool I already set up?"** Yes — in Add step, choose "Existing
tool" to import a configured worker tool as a pipeline step.

**"Where are my pipelines saved?"** On the dataset's configuration, so they're
shared by every dataset in the collection and persist across sessions.
