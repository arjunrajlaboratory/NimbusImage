# Analysis panel: scatter plots and sequential gating

The **Analysis** palette (scatter-plot icon in the top bar) plots any two
object measurements against each other and lets the user keep a subpopulation
by drawing around it — flow-cytometry-style gating, applied to image objects.

## What a gate is

A gate is a **region drawn on a plot**, stored as a polygon in the plot's
coordinate space — not as a list of objects. That matters:

- It re-resolves against whatever dataset is open, so the same gating
  strategy applies to every replicate using that collection.
- It is saved with the collection, so reopening a dataset restores it and it
  is applying **before** the user opens the panel.

An object is inside a gate when its two axis values fall inside the polygon.
Objects missing a value on either axis are outside it.

## Gates chain

Plots are ordered. Each plot shows the objects that passed the gates of the
plots **before** it, and its own gate narrows what later plots see. Two plots
therefore compose with AND. A plot never filters its own scatter, so the
points a user just drew around stay visible.

## Where gates apply

A gate is a filter like any other. Everything narrows together: the image
viewer, the Objects tab, counts, and exports. The Analysis button carries a
badge with the number of active gates, separate from the Filters badge —
each badge counts only what its own panel can show.

**This is the usual reason a dataset shows fewer objects than expected with
no visible filter.** If someone asks why objects are missing, check
`get_interface_state` for `analysisPlots` before blaming tag or property
filters, and offer `clear_analysis_plots`.

## Gates vs. property filters

Both narrow the object set, and either can express "area over 100".

- A **property filter** (`set_annotation_filter`) is a numeric range on one
  measurement. Use it for a simple threshold.
- A **gate** is a region on a two-measurement plot. Use it when the user is
  thinking about a population on a scatter ("the high-area, low-circularity
  cluster"), when two measurements must be combined, or when they want a
  sequential strategy where each step refines the last.

## Large datasets

Above 50,000 objects the panel switches from a point scatter to a
server-computed density heatmap, and gates resolve on the server. Gating
stays exact at any size; only the picture changes. Drawing on a heatmap uses
the shape tools in the plot's mode bar rather than a lasso.

## What you can and cannot do for the user

`create_analysis_plot` builds a plot and, given `xRange`/`yRange`, a
**rectangular** gate — which is what a value-range request amounts to. You
cannot draw a freehand lasso; for an irregular population, or for a
categorical axis, create the plot with the right axes and tell the user to
draw the region themselves. `clear_analysis_plots` removes everything.
