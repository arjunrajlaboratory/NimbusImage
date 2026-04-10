# NimbusImage Skills for Claude Code

Teach Claude Code how to work with NimbusImage scientific imaging datasets via the `nimbusimage` Python API.

## Installation

**Option A — Marketplace install (recommended):**

```bash
# Add the NimbusImage marketplace (one-time)
claude plugin marketplace add arjunrajlaboratory/NimbusImage

# Install the nimbus-skills plugin
claude plugin install nimbus-skills@arjunrajlaboratory/NimbusImage
```

**Option B — For this session only (development):**

```bash
claude --plugin-dir /path/to/NimbusImage/plugins/nimbusimage
```

## Skills

| Skill | Command | What it covers |
|-------|---------|---------------|
| Core | `/nimbus-skills` | Connection, dataset discovery, metadata, projects |
| Annotations | `/nimbus-skills:annotations` | CRUD, geometry helpers, bulk operations |
| Images | `/nimbus-skills:images` | Frame retrieval, composites, z-stacks, crops |
| Workers | `/nimbus-skills:workers` | Docker worker discovery, execution, job tracking |
| Analyze | `/nimbus-skills:analyze` | Properties, export, connections, sharing |

## Progressive disclosure

1. **Skill descriptions** (~100 words) — always in Claude's context, used for triggering
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

After installing the skill, just ask Claude:

> "Connect to my NimbusImage server at localhost:8080 and show me what datasets I have"

Claude will write the correct Python code using `import nimbusimage as ni`.
