# NimbusImage Python API — Next Steps

## Context

The `nimbusimage` Python API package is implemented on branch `feature/nimbusimage-python-api` at `nimbusimage/` in the repo root. 198 unit tests passing. The package is functional and tested against the live backend.

**Key docs to read first:**
- Design spec: `codebaseDocumentation/NIMBUSIMAGE_API.md`
- Testing guide: `nimbusimage/TESTING.md`
- Memory: auto-loaded `project_nimbusimage_api.md`

## Task 1: Migrate dataclasses to Pydantic

**Why:** Pydantic validates data at the boundary — catches wrong types, missing fields, and schema mismatches before they hit the server. Several bugs found during live testing (coordinate `z` field, `id` vs `_id`, tags list-vs-dict) would have been caught automatically with Pydantic validation.

**Scope:** Replace `@dataclass` classes in `nimbusimage/nimbusimage/models.py` with Pydantic `BaseModel` subclasses. The public API does not change.

**What to change:**

1. Add `pydantic` to `pyproject.toml` dependencies

2. Rewrite `models.py`:
   - `Location` → `BaseModel` with `xy: int = 0`, `z: int = 0`, `time: int = 0`
   - `Annotation` → `BaseModel` with all fields typed, `model_config = ConfigDict(populate_by_name=True)` for field aliases (`dataset_id` ↔ `datasetId`, etc.)
   - `Connection` → `BaseModel`
   - `Property` → `BaseModel`
   - `PixelSize` → `BaseModel` (keep the `to()` conversion method)
   - `FrameInfo` → `BaseModel`
   - Replace `to_dict()` with `model_dump(by_alias=True, exclude_none=True)`
   - Replace `from_dict(data)` with `model_validate(data)`
   - Keep `from_point()`, `from_polygon()`, `from_mask()` as classmethods

3. Update all code that calls `.to_dict()` and `.from_dict()`:
   - `annotations.py`, `connections.py`, `properties.py` — accessor methods
   - `coordinates.py` — `attach_geometry_methods` and factory classmethods
   - `worker.py` — WorkerContext
   - `filters.py` — should work unchanged (accesses `.location.xy` etc.)

4. Update all tests — Pydantic models are not dicts, so:
   - `Annotation(**kwargs)` works the same
   - `ann.to_dict()` → `ann.model_dump(by_alias=True, exclude_none=True)` (or keep `to_dict` as a wrapper)
   - `Annotation.from_dict(d)` → `Annotation.model_validate(d)` (or keep `from_dict` as a wrapper)

**Recommendation:** Keep `to_dict()` and `from_dict()` as thin wrappers around the Pydantic methods so the rest of the codebase doesn't need to change. Only `models.py` changes significantly.

```python
# Example of what the Annotation model would look like:
from pydantic import BaseModel, ConfigDict, Field

class Annotation(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str | None = Field(None, alias="_id")
    shape: str
    tags: list[str] = []
    channel: int = 0
    location: Location = Location()
    coordinates: list[dict] = []
    dataset_id: str = Field("", alias="datasetId")
    color: str | None = None

    def to_dict(self) -> dict:
        d = self.model_dump(by_alias=True, exclude_none=True)
        if self.id is None:
            d.pop("_id", None)
        return d

    @classmethod
    def from_dict(cls, data: dict) -> "Annotation":
        return cls.model_validate(data)
```

## Task 2: Set up MkDocs with auto-generated API docs

**Why:** Auto-generate browsable API documentation from docstrings. Deploy to GitHub Pages via GitHub Action.

**What to set up:**

1. Install MkDocs tooling (add to `[project.optional-dependencies]` under a `docs` extra):
   ```
   docs = ["mkdocs", "mkdocs-material", "mkdocstrings[python]"]
   ```

2. Create `nimbusimage/mkdocs.yml`:
   ```yaml
   site_name: NimbusImage Python API
   theme:
     name: material
   plugins:
     - mkdocstrings:
         handlers:
           python:
             paths: [nimbusimage]
   nav:
     - Home: index.md
     - Getting Started: getting-started.md
     - API Reference:
       - Client: api/client.md
       - Dataset: api/dataset.md
       - Images: api/images.md
       - Annotations: api/annotations.md
       - Connections: api/connections.md
       - Properties: api/properties.md
       - Collections: api/collections.md
       - Projects: api/projects.md
       - Export: api/export.md
       - History: api/history.md
       - Sharing: api/sharing.md
       - Worker Context: api/worker.md
       - Models: api/models.md
       - Coordinates: api/coordinates.md
       - URLs: api/urls.md
   ```

3. Create `nimbusimage/docs/` directory with:
   - `index.md` — overview and quick start
   - `getting-started.md` — installation, connection, basic usage
   - `api/*.md` — one file per module with `::: nimbusimage.module` directive

4. Create `.github/workflows/docs.yml`:
   ```yaml
   name: Deploy API Docs
   on:
     push:
       branches: [master]
       paths: ['nimbusimage/**']
   permissions:
     contents: read
     pages: write
     id-token: write
   jobs:
     deploy:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-python@v5
           with:
             python-version: '3.11'
         - run: pip install -e "nimbusimage[docs]"
         - run: cd nimbusimage && mkdocs build
         - uses: actions/deploy-pages@v4
           with:
             artifact_name: github-pages
             path: nimbusimage/site
   ```

5. Enable GitHub Pages in repo settings (Source: GitHub Actions)

**Order:** Do Task 1 (Pydantic) first, then Task 2 (MkDocs), since the Pydantic models will have richer schema info that mkdocstrings can display.

## Other pending items

- **Dataset upload** — needs backend refactoring (frontend logic for folder creation, metadata, large image detection)
- **Snapshots** — read works today, create/restore needs backend endpoints
- **Batch frame fetch** — needs new backend endpoint for multi-frame download
- **Bulk annotation update** — waiting on fix for [#780](https://github.com/arjunrajlaboratory/NimbusImage/issues/780)
