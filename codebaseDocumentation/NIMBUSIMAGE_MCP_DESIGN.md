# NimbusImage MCP Server — Design Thoughts

## Context

The `nimbusimage` Python API was designed from the start to support future MCP (Model Context Protocol) tool integration. The API's clean accessor pattern (`ds.images.get()`, `ds.annotations.list()`, etc.) maps naturally to MCP tool definitions.

An MCP server would let Claude (or any MCP client) interact with NimbusImage datasets directly — listing datasets, fetching images, creating annotations, running workers, and analyzing results through natural language.

## Architecture

```
Claude / MCP Client
    ↕ MCP protocol (stdio or SSE)
NimbusImage MCP Server (Python)
    ↕ nimbusimage Python API
Girder Backend (REST)
    ↕
MongoDB + Large Image + Docker Workers
```

The MCP server is a thin layer that wraps `nimbusimage` functions as MCP tools. The `nimbusimage` package does all the heavy lifting — the MCP server just translates between the protocol and the API.

## Proposed Tools

### Discovery and navigation

| Tool | Description | Maps to |
|------|-------------|---------|
| `list_datasets` | List accessible datasets with name, shape, channels | `client.list_datasets()` |
| `get_dataset_info` | Get metadata for a dataset (shape, channels, pixel size, frame count) | `ds.name`, `ds.shape`, `ds.channels`, etc. |
| `open_dataset` | Open dataset in browser, return URL | `ds.open()` |
| `list_projects` | List projects | `client.list_projects()` |

### Images

| Tool | Description | Maps to |
|------|-------------|---------|
| `get_image` | Fetch a single frame as base64 PNG | `ds.images.get()` + encode |
| `get_composite` | Fetch composite RGB image | `ds.images.get_composite()` + encode |
| `get_z_stack` | Fetch z-stack, return summary or specific slice | `ds.images.get_stack()` |

**Design consideration:** Images can be large. Options:
1. Return base64-encoded PNG (works for single frames, ~1-4MB)
2. Return a thumbnail (downsampled) for overview, full res on request
3. Return image metadata only, let the user decide what to fetch
4. Save to a temp file and return the path

For MCP with Claude, base64 PNG is the most practical since Claude can view images inline. A `max_size` parameter could downsample large images.

### Annotations

| Tool | Description | Maps to |
|------|-------------|---------|
| `list_annotations` | List/filter annotations by shape, tags, location | `ds.annotations.list()` |
| `count_annotations` | Count annotations matching filters | `ds.annotations.count()` |
| `create_annotation` | Create a point or polygon annotation | `ds.annotations.create()` |
| `create_annotations_bulk` | Create many annotations at once | `ds.annotations.create_many()` |
| `delete_annotations` | Delete annotations by ID or tag | `ds.annotations.delete_many()` |
| `get_annotation_pixels` | Get pixel values inside an annotation | `ann.get_mask()` + `ds.images.get()` |

### Workers

| Tool | Description | Maps to |
|------|-------------|---------|
| `list_workers` | List available worker images | `client.list_workers()` |
| `get_worker_interface` | Get parameter schema for a worker | `client.get_worker_interface()` |
| `run_annotation_worker` | Run an annotation worker and wait | `ds.annotations.compute()` + `job.wait()` |
| `run_property_worker` | Run a property worker and wait | `ds.properties.compute()` + `job.wait()` |

### Properties

| Tool | Description | Maps to |
|------|-------------|---------|
| `list_properties` | List property definitions | `ds.properties.list()` |
| `get_property_values` | Get computed property values | `ds.properties.get_values()` |
| `create_property` | Create a property definition | `ds.properties.create()` |
| `submit_property_values` | Submit computed values | `ds.properties.submit_values()` |

### Connections

| Tool | Description | Maps to |
|------|-------------|---------|
| `list_connections` | List connections for an annotation | `ds.connections.list()` |
| `create_connection` | Create a parent-child connection | `ds.connections.create()` |
| `connect_to_nearest` | Auto-connect to nearest matching annotation | `ds.connections.connect_to_nearest()` |

### Export and sharing

| Tool | Description | Maps to |
|------|-------------|---------|
| `export_json` | Export dataset as JSON | `ds.export.to_json()` |
| `export_csv` | Export as CSV, return contents or save to file | `ds.export.to_csv()` |
| `share_dataset` | Share with a user | `ds.sharing.share()` |
| `set_public` | Toggle public access | `ds.sharing.set_public()` |

## Implementation approach

### Option A: Claude Agent SDK (recommended)

Use the [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-and-tools/agent-sdk) to build an agent that uses `nimbusimage` as its toolkit. The Agent SDK handles the MCP protocol, tool registration, and message routing.

```python
from claude_agent_sdk import Agent, tool

agent = Agent(name="nimbusimage")

@tool
def list_datasets(api_url: str, token: str) -> list[dict]:
    """List all accessible NimbusImage datasets."""
    client = ni.connect(api_url, token=token)
    return [{"id": d["_id"], "name": d["name"]} for d in client.list_datasets()]
```

### Option B: Standalone MCP server

Use the `mcp` Python package to create a standalone server that Claude Code or other MCP clients can connect to.

```python
from mcp.server import Server
from mcp.types import Tool

server = Server("nimbusimage")

@server.tool()
async def list_datasets(api_url: str, token: str) -> str:
    client = ni.connect(api_url, token=token)
    datasets = client.list_datasets()
    return json.dumps([{"id": d["_id"], "name": d["name"]} for d in datasets])
```

### Authentication

The MCP server needs credentials for the Girder backend. Options:

1. **Environment variables** (`NI_API_URL`, `NI_TOKEN`) — simplest, set once
2. **Per-request** — pass `api_url` and `token` as tool parameters (more flexible but verbose)
3. **Session-based** — a `connect` tool that stores credentials for the session

Recommendation: Start with environment variables (option 1) since `nimbusimage` already supports them via `ni.connect()`.

### State management

Some tools need to reference a "current dataset." Options:

1. **Stateless** — every tool takes a `dataset_id` parameter
2. **Session state** — a `use_dataset` tool sets the current dataset for subsequent calls
3. **Implicit from context** — Claude tracks which dataset is being discussed

Recommendation: Start stateless (option 1). It's simplest and most predictable. If verbosity becomes an issue, add session state later.

## What nimbusimage already provides

The API was specifically designed to make MCP wrapping trivial:

- **Clean function signatures** — every method has typed parameters and return values
- **Pydantic models** — automatic serialization to/from JSON for MCP responses
- **`to_dict()`** — all models serialize cleanly for JSON transport
- **No side effects** — read operations are pure, write operations are explicit
- **Error messages** — validation errors (e.g., missing `connect_to.tags`) are caught early with clear messages

## What's still needed before MCP

1. **Image encoding helper** — `ds.images.get()` returns numpy arrays; need a utility to encode as base64 PNG for MCP responses
2. **Response size management** — some operations return large results (e.g., `list_annotations` with 10K+ annotations); need pagination or summarization
3. **Progress streaming** — `job.wait()` blocks; MCP may want progress updates as partial results
4. **Error handling** — wrap `girder_client.HttpError` into user-friendly error messages

## Example interaction

```
User: What datasets do I have?
Claude: [calls list_datasets] You have 314 datasets. Here are the first 5:
  - 000001HCR (4 channels, 7 z-slices, 1024x1024)
  - RNA FISH spot detection (2 channels, 1 z-slice, 2048x2048)
  ...

User: Show me the first one
Claude: [calls get_dataset_info, get_composite] Here's dataset 000001HCR:
  [shows composite image]
  It has 220 polygon annotations and 50 connections.

User: Run blob metrics on the polygons
Claude: [calls run_property_worker with blob_metrics]
  Computing... 220/220 annotations processed.
  Results: mean area = 145.3 px, mean circularity = 0.78

User: Which annotations have area > 200?
Claude: [calls get_property_values, filters]
  Found 42 annotations with area > 200. Here they are overlaid on the image:
  [shows composite with highlighted annotations]
```

## Timeline

This is a future task — the `nimbusimage` API is the foundation that needs to be solid first. The MCP layer is relatively thin once the API is stable.

Suggested order:
1. Stabilize `nimbusimage` API (current work)
2. Add image encoding utility
3. Build minimal MCP server with 5-6 core tools
4. Iterate based on real usage patterns
