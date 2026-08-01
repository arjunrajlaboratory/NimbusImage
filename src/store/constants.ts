export const MAX_NUMBER_OF_RECENT_DATASET_VIEWS = 20;

// Guard against accidentally launching an unbounded number of worker jobs.
// This lives in the store layer so both UI eligibility checks and the
// authoritative batch actions enforce the same limit.
export const BATCH_DATASET_LIMIT = 50;

// Upper bound on how many annotations "Connect selected" will chain in one go.
// Without it, a select-all in the Objects tab (routinely tens of thousands of
// objects) followed by one click would POST that many connections in a single
// request — the backend batch-create endpoint has no cap of its own. A real
// track spans timepoints, not tens of thousands of objects, so this is well
// clear of any legitimate use.
export const MAX_CONNECT_SELECTED = 500;

// Tag applied to connections that represent tracking links across time.
// `deleteAllTimelapseConnections` selects on this exact string, so every
// producer of a timelapse connection must use this constant rather than a
// literal, or those connections become undeletable by that action.
export const TIMELAPSE_CONNECTION_TAG = "Time lapse connection";

// Largest population the Analysis panel will plot CLIENT-SIDE as a scatter.
//
// Above it the panel does not plot a sample: a gate resolves to a set of
// annotation ids, so gating a sample would silently exclude every unsampled
// object while the counts still looked right. Instead, display switches to
// server-binned heatmaps and gate resolution moves to the gate_ids endpoint
// (SERVER_GATING.md) — exact at any dataset size. Matches
// DEFAULT_VISIBILITY_CONFIG's maxVisible, already this codebase's "as many
// as we will draw at once".
export const MAX_ANALYSIS_PLOT_POINTS = 50000;

// Bins per numeric axis for the over-cap heatmaps (clamped server-side at
// 512; categorical axes bin one category per index regardless).
export const ANALYSIS_HISTOGRAM_BINS = 128;

// Largest id-list filter the client will inline into a histogram request as
// an idConstraints entry. Bigger lists are skipped and reported in the
// panel's honesty banner — the DISPLAY may over-include; gate RESOLUTION is
// filter-independent and never degrades.
export const MAX_HISTOGRAM_ID_CONSTRAINT = 50000;
