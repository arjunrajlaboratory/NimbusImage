export const MAX_NUMBER_OF_RECENT_DATASET_VIEWS = 20;

// Guard against accidentally launching an unbounded number of worker jobs.
// This lives in the store layer so both UI eligibility checks and the
// authoritative batch actions enforce the same limit.
export const BATCH_DATASET_LIMIT = 50;

// Tag applied to connections that represent tracking links across time.
// `deleteAllTimelapseConnections` selects on this exact string, so every
// producer of a timelapse connection must use this constant rather than a
// literal, or those connections become undeletable by that action.
export const TIMELAPSE_CONNECTION_TAG = "Time lapse connection";
