# Non-admin API behavior: token scopes and endpoint quirks

Recorded 2026-05-18 while exercising the NimbusImage REST API as a non-admin user with an API key.

## TL;DR

The endpoints below behave in ways that look like bugs but are **core Girder**, not NimbusImage. Documenting so future debugging doesn't go around the loop again.

| Endpoint | Symptom for non-admin API key | Root cause | Fix in our code? |
|---|---|---|---|
| `GET /job` (and friends) | `401 "user None"` when the API key has only `core.*` scopes | `girder_jobs` requires its own scope `jobs.rest.list_job` | No — `girder_jobs` plugin, not us |
| `GET /user` (listing) | `401 "You must be logged in."` even with a valid API key | `@access.user` decorator-level scope mismatch for API keys without sufficient default scopes | No — core Girder |
| `GET /user/me`, `GET /user/:id` | Works fine | Endpoints use `@access.public(scope=USER_INFO_READ)` which the API key satisfies | n/a |

## /job endpoints — required scope

From `girder_jobs/constants.py`:

```python
REST_LIST_JOB_TOKEN_SCOPE = 'jobs.rest.list_job'
REST_CREATE_JOB_TOKEN_SCOPE = 'jobs.rest.create_job'
```

All `GET /job*` endpoints are decorated `@access.public(scope=REST_LIST_JOB_TOKEN_SCOPE)`. An API key created with the default scope set (`core.data.read`, `core.data.write`, `core.data.own`, `core.user_info.read`) will return 401 on these endpoints because none of those scopes match.

**Workaround for users:** when creating the API key, select **"Allow all scopes"** (or explicitly include `jobs.rest.list_job` and `jobs.rest.create_job`). Session tokens from username/password auth automatically have all scopes, so the frontend isn't affected.

**Could NimbusImage fix this?** Not really — `girder_jobs` is a Girder-maintained plugin we depend on. A PR to upstream Girder is conceivable (e.g., make `jobs.rest.list_job` implicit when `core.data.read` is present), but that's their call. For our own users, the right answer is documentation + a default-permissive API key creation flow if we want to streamline it.

## /user listing — also scope-related

`GET /user` (search/list) is decorated `@access.user` in core Girder. Despite the docstring being permissive, with an API key whose token scopes are limited, `getCurrentUser()` returns `None` and the endpoint 401s with `"You must be logged in."`.

`GET /user/me` and `GET /user/:id` continue to work because they use `@access.public(scope=USER_INFO_READ)` which the API key has.

**Practical impact:** small. The frontend uses `GET /user/:id` and the share-by-email flow (`dataset_view/share` accepts `userMailOrUsername`), so listing is rarely needed. If a tool/script needs to enumerate users, it needs a broader-scope API key.

## How to verify the API key's scopes

```bash
TOKEN=$(curl -s -X POST -H "Content-Length: 0" \
  "http://localhost:8080/api/v1/api_key/token?key=$API_KEY" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["authToken"]["token"])')

curl -s -H "Girder-Token: $TOKEN" \
  http://localhost:8080/api/v1/token/current | python3 -m json.tool
```

The `scope` array tells you exactly which scopes the key was created with. If you don't see `jobs.rest.list_job` and you need /job access, recreate the key with "Allow all scopes" in the Girder UI.

## Optional follow-up (if we want to)

If we want the default API key creation in NimbusImage to "just work" for the full API surface, we could:

1. Add a one-paragraph note to the Python API README (`nimbusimage/README.md`) under "Authentication" about API key scopes — quick win.
2. Override `POST /api_key` in the plugin to default `scope=None` (= all scopes) instead of Girder's UI default — more invasive, changes user behavior.

(1) is probably enough. Adding (2) would be a UX bandage; the cleaner answer is making the API key UI clearer in Girder upstream.
