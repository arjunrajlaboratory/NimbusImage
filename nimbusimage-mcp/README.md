# nimbusimage-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude (Claude Code,
Claude Desktop, claude.ai connectors) work with NimbusImage: find datasets, count
and summarize annotations, look at images, read measurements, run analysis
workers, and tag annotations.

Every call runs **as the caller**. A client sends its own Girder API key as a
bearer token; the server exchanges it for a Girder session and calls the
NimbusImage REST API with it, so Girder's access control decides what anyone can
see or change. The server holds no credentials of its own.

Design and roadmap: [`codebaseDocumentation/NIMBUSIMAGE_MCP_SERVER.md`](../codebaseDocumentation/NIMBUSIMAGE_MCP_SERVER.md).
Phase 0 measurements: [`eval/PHASE0_RESULTS.md`](eval/PHASE0_RESULTS.md).

## Tools

All names start with `ni_`. Results are compact JSON, capped, and summary-first;
images are downsampled JPEGs.

| Tool | What it does |
|---|---|
| `ni_datasets_list` | Datasets you can open (`{id, name}`, max 100; filter by name) |
| `ni_dataset_info` | Size, channels, z/time/xy counts, pixel size |
| `ni_annotations_count` | Counts in one or more datasets (up to 50), by shape and tags |
| `ni_annotations_summary` | Total, counts by tag and by shape |
| `ni_annotations_list` | Specific annotations (max 200 per call), with center and location |
| `ni_annotations_tag` | **Writes.** Add/remove/replace tags on annotations chosen by a query (max 10,000) |
| `ni_image_get_composite` | The image as the app draws it, optionally cropped |
| `ni_image_get_channel` | One channel in grayscale, auto-contrast |
| `ni_properties_list` | Measurements set up for a dataset, their value paths and uncomputed counts |
| `ni_property_values_summary` | Count/mean/std/min/max per value path, optionally filtered |
| `ni_property_histogram` | Equal-count histogram of one value path |
| `ni_property_compute` | **Writes.** Start computing a measurement (returns a job id) |
| `ni_workers_list` | Annotation and property workers on the server |
| `ni_worker_interface` | A worker's parameters and the value format each expects |
| `ni_worker_run` | **Writes.** Run an annotation worker (returns a job id) |
| `ni_job_wait` | Wait (bounded) for a job and report its outcome |
| `ni_help_topic` | NimbusImage user documentation by topic |

Tools that write are marked with the MCP `destructiveHint`, so clients ask
before running them.

## Running it

With the local compose stack (from the repo root; **not** from a git worktree,
see the `nimbus-local-ops` skill):

```bash
docker compose --profile mcp up -d mcp     # http://localhost:8001/mcp
```

Plain `docker compose up` does not start it. The image builds from two contexts
(`nimbusimage-mcp/` and `nimbusimage/`); if the build sits with no output,
Compose's bake builder is likely waiting to confirm read access to the second
one, which never shows without a terminal. `COMPOSE_BAKE=false` builds with the
classic builder instead (about a minute).

Or run it on the host:

```bash
python3 -m venv nimbusimage-mcp/.venv
nimbusimage-mcp/.venv/bin/pip install -e nimbusimage -e "nimbusimage-mcp[dev]"
NI_API_URL=http://localhost:8080/api/v1 nimbusimage-mcp/.venv/bin/nimbusimage-mcp
```

| Variable | Default | Meaning |
|---|---|---|
| `NI_API_URL` | `http://localhost:8080/api/v1` | Girder REST root the server calls |
| `NI_MCP_HOST` / `NI_MCP_PORT` | `127.0.0.1` / `8000` | Where it listens (the image uses `0.0.0.0`) |
| `NI_MCP_PUBLIC_URL` | `http://localhost:<port>/mcp` | This server's public URL (the OAuth resource id); an http(s) URL with no fragment, checked at startup as the plugin checks `mcp_oauth.resources` |
| `NI_MCP_ISSUER_URL` | `http://localhost:8080` | Advertised authorization server: the `nimbus_mcp_oauth` plugin's `mcp_oauth.issuer` (the site's bare origin, no path; refused at startup otherwise, and a trailing slash is dropped, as the plugin does) |
| `NI_MCP_INTROSPECTION_SECRET` | unset | Shared with the plugin's `mcp_oauth.introspection_secret` (32+ printable ASCII characters, no spaces). Unset: OAuth tokens are refused and only API keys work. Reach Girder over the private network or https (`NI_API_URL`), since the secret travels with every OAuth request |
| `NI_MCP_CALL_LOG` | unset | JSON-lines call log (tool, user id, arguments, seconds, bytes, error), for evals. The server log has the same records without arguments or error messages (only the kind of error) |
| `NI_MCP_MAX_JOB_WAIT` | `240` | Longest `ni_job_wait` (and cap on a worker-interface fetch, at most 60 s), in seconds, at least 1; keep it under every HTTP timeout in front of the server. Each request to Girder separately times out after 330 s (behind a proxy with a shorter timeout, such as HAProxy, the client sees the proxy's timeout first) |

`NI_API_KEY` and `NI_TOKEN` must **not** be set: the server refuses to start
with a service credential. (The introspection secret is not one: it only
lets this service ask Girder who a token belongs to.)

## Connecting Claude Code

Create an API key in Girder (Swagger at `http://localhost:8080/api/v1`, `POST
/api_key`). A full-access key is simplest; a scoped key needs `core.user_auth`
for `ni_job_wait` and `ni_help_topic`.

```bash
claude mcp add --transport http nimbus http://localhost:8001/mcp \
  --header "Authorization: Bearer <your API key>"
```

Each person uses their own key. Deleting or deactivating the key in Girder ends
access on the next request.

## Testing through a public URL

claude.ai connectors call from Anthropic's servers, so they need an HTTPS URL.
`deploy/local-haproxy/` runs HAProxy with the proposed production routing in
front of the `mcp` service. Port 8090 is the public side: point the tunnel
there, and Girder answers it only for the OAuth discovery documents and
authorize, token and revoke.
Port 8091 (localhost only) stands in for the private network; never tunnel
it. `deploy/local-haproxy/check_routing.sh` checks the routing. HAProxy finds
`mcp` through Docker's DNS, so the order below works and `mcp` can be recreated
while it runs. From the repo root of the main checkout:

```bash
docker compose -f nimbusimage-mcp/deploy/local-haproxy/docker-compose.yaml up -d
# in another terminal (stays in the foreground); prints https://<name>.trycloudflare.com
cloudflared tunnel --url http://localhost:8090
NI_MCP_PUBLIC_URL=https://<name>.trycloudflare.com/mcp \
NI_MCP_ISSUER_URL=https://<name>.trycloudflare.com NI_MCP_MAX_JOB_WAIT=85 \
  COMPOSE_BAKE=false docker compose --profile mcp up -d --no-deps mcp
```

Then add a custom connector at that `/mcp` URL with "No sign in" and the header
`Authorization: Bearer <key>`. Use a dedicated test user's key, never an admin's.
A quick tunnel cuts responses after 100 s (hence the 85 s job wait) and does not
survive overnight. Shut it down afterwards and recreate `mcp` without the
overrides. Results: the plan's "Phase 2 results".

## How auth works

Two kinds of bearer credential:

- **A Girder API key** (Claude Code, and Pro/Max connectors with a fixed
  header), described below.
- **An OAuth access token** (`nio_…`) from the `nimbus_mcp_oauth` Girder
  plugin, for connectors that sign each user in (Team and Enterprise
  orgs). The server asks the plugin's introspection endpoint about it on
  every request, so a disconnected client or disabled account fails on
  its next call; the token must have been issued for this server's URL
  (`NI_MCP_PUBLIC_URL`), or it is refused. That URL must appear in the
  plugin's `mcp_oauth.resources` setting exactly, path case included
  (host case, default port and a trailing slash do not matter; the server
  drops a trailing slash from `NI_MCP_PUBLIC_URL` so its metadata path
  stays `/.well-known/oauth-protected-resource/mcp`).

For API keys:

- `Authorization: Bearer <key>` is exchanged with `POST api_key/token` and the
  session is cached by SHA-256 of the key until an hour before it expires, so a
  user mints one Girder token per key, not one per call.
- Every request re-checks the cached session (`GET token/current`), which is what
  makes a revoked key fail at once.
- Requests without a valid key get `401` with a `WWW-Authenticate` challenge
  pointing at `/.well-known/oauth-protected-resource/mcp`.
- Logs carry the user id, never the key or session token.
- The server is stateless (streamable HTTP, no sessions): any instance can
  serve any request.

## Tests

Run from `nimbusimage-mcp/` (from the repo root, the `nimbusimage/` folder
shadows the installed package):

```bash
cd nimbusimage-mcp
.venv/bin/python -m pytest -m "not integration"   # unit + HTTP auth, no network
.venv/bin/python -m pytest -m integration         # against the local stack
.venv/bin/flake8 nimbusimage_mcp tests
```

Integration tests log in as the admin from `tmp/login_credentials.txt` (line 1
login, line 2 password), create a throwaway user and dataset, and delete them
afterwards. Image and worker tests use `NI_TEST_IMAGE_DATASET` (a dataset id with
an image). Token counts are read from MongoDB through `docker exec`
(`NI_TEST_MONGO_CONTAINER`, default `nimbusimage-mongodb-1`).

The task-based eval (headless Claude Code against a running server) lives in
`eval/`; see the header of `eval/run_eval.sh`.
