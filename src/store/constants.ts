export const MAX_NUMBER_OF_RECENT_DATASET_VIEWS = 20;

// Guard against accidentally launching an unbounded number of worker jobs.
// This lives in the store layer so both UI eligibility checks and the
// authoritative batch actions enforce the same limit.
export const BATCH_DATASET_LIMIT = 50;
