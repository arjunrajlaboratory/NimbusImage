# NimbusImage Skills for Claude Code and Codex

Teach Claude Code and Codex how to work with NimbusImage scientific imaging datasets via the `nimbusimage` Python API. Both agents load the same Agent Skills from `skills/`, with provider-specific plugin namespaces:

- Claude Code uses `/nimbus-skills:...`.
- Codex uses `$nimbusimage:...`.

## Installation

### Claude Code

**Option A — Marketplace install (recommended):**

```bash
# Add the NimbusImage marketplace (one-time)
claude plugin marketplace add arjunrajlaboratory/NimbusImage

# The marketplace entry is nimbusimage; installed skills remain namespaced nimbus-skills
claude plugin install nimbusimage@NimbusImage
```

**Option B — For this session only (development):**

```bash
claude --plugin-dir /path/to/NimbusImage/plugins/nimbusimage
```

### Codex

Add this repository as a plugin marketplace, then install the plugin:

```bash
codex plugin marketplace add arjunrajlaboratory/NimbusImage
codex plugin add nimbusimage@NimbusImage
```

When working from a clone of this repository, the skills are also available directly through `.agents/skills/` without installing the plugin. Those repository-local aliases use names such as `$nimbusimage-annotations`. Restart Codex or start a new task after installing or changing the plugin so the skill inventory refreshes.

## Skills

| Skill | Claude Code | Codex | What it covers |
|-------|-------------|-------|----------------|
| Core | `/nimbus-skills:nimbusimage` | `$nimbusimage:nimbusimage` | Connection, dataset discovery, metadata, projects |
| Annotations | `/nimbus-skills:annotations` | `$nimbusimage:annotations` | CRUD, geometry helpers, bulk operations |
| Images | `/nimbus-skills:images` | `$nimbusimage:images` | Frame retrieval, composites, z-stacks, crops |
| Workers | `/nimbus-skills:workers` | `$nimbusimage:workers` | Docker worker discovery, execution, job tracking |
| Analyze | `/nimbus-skills:analyze` | `$nimbusimage:analyze` | Properties, export, connections, sharing |
| Xenium ingest | `/nimbus-skills:xenium-ingest` | `$nimbusimage:xenium-ingest` | Load a 10x Xenium bundle: images, cell polygons, gene panel, clustering, UMAP, cell-type tags, and the full matrix as a spatial table |

## Progressive disclosure

1. **Skill descriptions** — indexed by the agent and used for triggering
2. **Skill body** — loaded when a skill triggers, has common patterns and code examples
3. **Reference files** — loaded on demand for full API details:
   - `references/api-overview.md` — complete method signatures for all accessors
   - `references/gotchas.md` — known issues and things that will trip you up

## Prerequisites

The `nimbusimage` Python package must be installed:

```bash
pip install nimbusimage
```

And you need a running NimbusImage server to connect to.

## Example

After installing the plugin, ask Claude Code or Codex:

> "Connect to my NimbusImage server at localhost:8080 and show me what datasets I have"

The agent will write the correct Python code using `import nimbusimage as ni`.

## Development

The Agent Skills in `skills/` are the canonical API guidance for both providers. Synchronize shared references and repository-local `.agents/skills/` aliases after changing a skill or reference:

```bash
python3 plugins/nimbusimage/scripts/sync_skills.py --write
python3 plugins/nimbusimage/scripts/sync_skills.py --check
```

The check is also enforced in CI so plugin packages, references, and repository-local aliases cannot drift silently.
