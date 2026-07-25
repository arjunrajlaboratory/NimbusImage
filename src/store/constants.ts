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
