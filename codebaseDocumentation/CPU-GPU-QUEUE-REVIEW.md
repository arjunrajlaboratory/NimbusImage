# CPU/GPU Queue Routing — Review Findings

Branch: `feature/cpu-gpu-queue-routing` (PR #1236)
Source: /branch-review, 2026-07-13

## Finding 1: Broad `except Exception` in the label lookup
- **Location:** `server/helpers/workerQueues.py:53`
- **Severity:** Medium
- **Summary:** `except Exception` swallows programming errors (TypeError,
  AttributeError, MemoryError) into a silent GPU-route. Catch the expected
  families instead: `docker.errors.DockerException` +
  `requests.exceptions.RequestException`.
- **Status:** fixed (uncommitted) — docker/requests families caught,
  programming errors propagate; covered by
  `test_docker_error_defaults_to_gpu_and_is_not_cached` (parametrized) and
  `test_programming_error_propagates`.

## Finding 2: Missing-label default cached until Girder restarts
- **Location:** `server/helpers/workerQueues.py:65`
- **Severity:** Low
- **Summary:** The unlabeled/garbage-label → GPU default is cached forever,
  so re-pulling a fixed (labeled) image under the same tag doesn't take
  effect until Girder restarts. Don't cache the default, consistent with
  the error path. Accepted trade-off: the warning logs on every dispatch
  of an unlabeled image.
- **Status:** fixed (uncommitted) — unlabeled/garbage defaults return
  without caching; covered by
  `test_missing_label_defaults_to_gpu_and_is_not_cached` and
  `test_relabeled_image_is_picked_up_without_restart`.

## Non-findings (for the record)
- Deployment ordering: coordinated; the deployment-side changes go out
  first (confirmed 2026-07-13).
