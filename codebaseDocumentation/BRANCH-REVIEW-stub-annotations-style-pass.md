# Branch Review — `feature/stub-annotations` — Style Pass

**Scope:** A style/convention-conformance pass over the branch diff vs `master`,
complementary to the correctness rounds already completed
(`BRANCH-REVIEW-stub-annotations.md`, `...-round2.md`). This pass looked **only**
at stylistic conformance to documented repo conventions and local-idiom matching
(does new code read like its neighbors?) — not logic, performance, or access
control, which prior rounds covered.

**Overall:** The branch is highly conformant. New code consistently uses
`<script setup lang="ts">`, the button taxonomy, semantic color tokens, `I`/`T`
type prefixes, named-export utils with JSDoc, `logWarning`/`logError`, and proper
store-module organization. Backend is flake8-clean (all 5 files). This pass found
one genuinely important issue (a NUL byte that made a source file binary and thus
invisible to every prior review) plus a set of small import-hygiene, naming, and
comment-density deviations.

## Status legend
- [ ] TODO — not yet addressed
- [~] IN PROGRESS
- [x] DONE — fixed (commit/verification noted inline)
- [-] WONTFIX — deliberately not changed (reason noted inline)

## Progress
All 12 findings addressed: 11 fixed, 1 reviewed and kept as-is (Finding 11,
WONTFIX with rationale). Final verification: `pnpm tsc`, `pnpm lint:ci`, the
touched Vitest suites, and backend `tox` — results recorded below.

---

## Findings

### [x] Finding 1 — NUL byte makes `propertyValues.ts` a binary file
> **DONE.** Removed the duplicate `serializePath` (whose body held the NUL) and
> repointed both call sites at the shared `createPathStringFromPathArray()` from
> `@/utils/paths`. File is now UTF-8 text; `propertyValues.test.ts` (27 tests)
> passes. The "." separator is collision-safe here for the same documented reason
> the util uses it (MongoDB forbids "." in field names / property sub-ids).
- **Severity:** High
- **Category:** Encoding / Hygiene (with latent correctness + code duplication)
- **File:** `src/utils/propertyValues.ts:17`

**Current** (`hexdump`: `6e 28 22 00 22 29` = `n ( " <NUL> " )`):
```typescript
function serializePath(path: string[]): string {
  return path.join("\0");   // byte between the quotes is 0x00, not "."
}
```

**Fix:** Retype the separator. Prefer reusing the existing canonical util
`createPathStringFromPathArray()` in `src/utils/paths.ts:16` (which does
`path.join(".")` for exactly this purpose), or at minimum `path.join(".")`.

**Rationale:** A single `0x00` at offset 0x182 trips git's binary heuristic, so
the whole 6.4 KB module shows as `Bin 0 -> 6446 bytes` — no readable diff, no
line-level review, broken blame/merge. This is why the file was never examined in
the correctness rounds. `serializePath` is internal to the module so behavior is
self-consistent today (latent, not active, bug), but it must be retyped, and
ideally folded into the existing util to remove duplication.

---

### [x] Finding 2 — Stray "Finding N" review artifacts in committed comments
> **DONE.** Removed all 7 `(Finding N)` parentheticals across the 4 files,
> keeping the explanatory prose. `grep` confirms none remain; flake8 still clean.
- **Severity:** Low
- **Category:** Docstring / Comment
- **Files (7 sites):** `server/models/annotation.py:251,608`;
  `server/models/propertyValues.py:147`; `server/api/annotation.py:616,627`;
  `server/helpers/validation.py:148,192`

**Fix:** Drop the `(Finding N)` parentheticals, keep the explanatory prose.

**Rationale:** They reference review-round numbering meaningless in the committed
tree; nothing else in the plugin references "Finding N".

---

### [x] Finding 3 — Lone `import` placed ~2,400 lines into the file
> **DONE.** Moved `import type AnnotationsAPI from "./AnnotationsAPI"` into the
> top import group (next to the other `./` sibling imports). eslint clean.
- **Severity:** Low
- **Category:** Import Order
- **File:** `src/store/annotation.ts:2430`

**Current:**
```typescript
import type AnnotationsAPI from "./AnnotationsAPI";
async function _hydrateFromBackend(api: AnnotationsAPI, ...) {
```

**Fix:** Hoist `import type AnnotationsAPI` into the top import group.

**Rationale:** Every other import is at the top; a type-only import has no
ordering constraint forcing it mid-file.

---

### [x] Finding 4 — Module-level `const` wedged between import blocks
> **DONE.** Moved `propertyFilterRequestGuard` (and its comment) below the now-
> contiguous import block, before `type TFilterHistograms` — matching
> `annotationListServer.ts`. eslint clean.
- **Severity:** Low
- **Category:** Import Order
- **File:** `src/store/filters.ts:22-25`

**Fix:** Keep all imports contiguous; declare
`const propertyFilterRequestGuard = createSequenceGuard();` after the import
block (as `annotationListServer.ts:33` does).

**Rationale:** Interleaving a declaration between import groups (it currently
splits imports into three groups) is inconsistent with the file and its siblings.

---

### [x] Finding 5 — Separate `import type` instead of inline `type` on `./model`
> **DONE.** Folded the four type-only names into the existing
> `import { ... } from "./model"` block using inline `type` qualifiers (the
> file's own idiom for the `@/utils/annotationUpdate` import). eslint clean.
- **Severity:** Nit
- **Category:** Import Order
- **File:** `src/store/annotation.ts:33-38`

**Fix:** Fold the type-only names into the single existing
`import { ... } from "./model"` using inline `type` qualifiers — the idiom this
file already uses for `@/utils/annotationUpdate` (l.54-59).

**Rationale:** Two imports from one module breaks the file's own inline-`type`
pattern.

---

### [x] Finding 6 — Paragraph-length trailing field comments on `IVisibilityConfig`
> **DONE.** Converted all 7 fields to wrapped leading comments (full prose
> preserved, now within print width), matching the short-trailing-comment idiom
> used elsewhere in `model.ts`. eslint clean.
- **Severity:** Nit
- **Category:** Comment Style
- **File:** `src/store/model.ts:1454-1460`

**Fix:** Move prose into a leading block comment; keep trailing field comments
terse (cf. neighbors `// In GCS coordinates`, `// Time in seconds`).

**Rationale:** Every other interface in `model.ts` uses short trailing comments;
these 150-220-char trailing comments are far denser than any neighbor and
overflow Prettier's print width.

---

### [x] Finding 7 — JSDoc separated from its function by an interface
> **DONE.** Moved `interface IHasKey` above the JSDoc so the doc block is now
> flush against `export function idsNeedingHydration`. eslint clean.
- **Severity:** Nit
- **Category:** Comment Style
- **File:** `src/utils/annotation.ts:473-485`

**Fix:** Move `interface IHasKey` above the JSDoc so the doc sits flush against
`export function idsNeedingHydration`.

**Rationale:** Neighbors keep JSDoc immediately adjacent to the documented
subject; the interposed interface makes the doc read as documenting `IHasKey`.

---

### [x] Finding 8 — `body` local where siblings use `bodyJson`
> **DONE.** Renamed the `memoizedBodyJson` locals (and their in-method uses) to
> `bodyJson` in `listAnnotationIds` and `listAnnotations`. Left
> `uncomputedCounts(self, body)` alone — there `body` is the `autoDescribeRoute`
> jsonParam name, the correct idiom. flake8 clean.
- **Severity:** Nit
- **Category:** Naming
- **File:** `server/api/annotation.py:582,607`

**Fix:** `bodyJson = kwargs["memoizedBodyJson"]`.

**Rationale:** The other 9 extractions in this file (and 5 in `connections.py`)
name the local `bodyJson`.

---

### [x] Finding 9 — Opaque `pf` loop variable across two backend files
> **DONE.** Renamed all `pf` → `propertyFilter` (14 in `models/annotation.py`,
> 21 in `helpers/validation.py`, including docstring refs), matching the
> `propertyFilters` collection name. Reflowed 4 lines (1 docstring, 1 boolean
> return, 1 list comprehension) that crossed 79 chars. flake8 clean.
- **Severity:** Nit
- **Category:** Naming
- **Files:** `server/models/annotation.py` (~l.333,660,670);
  `server/helpers/validation.py` (~l.104,173)

**Fix:** Rename to `propertyFilter` (or `propFilter`).

**Rationale:** `pf` is introduced by this branch, used nowhere else in the
plugin; repo convention prefers descriptive names, and it appears pervasively
across two files.

---

### [x] Finding 10 — Single-name import expanded to 3-line parenthesized form
> **DONE.** Collapsed to
> `from ..models.annotation import Annotation as AnnotationModel` (61 chars).
> flake8 clean.
- **Severity:** Nit
- **Category:** Import Order
- **File:** `server/api/annotation.py:24-26`

**Current:**
```python
from ..models.annotation import (
    Annotation as AnnotationModel,
)
```

**Fix:** `from ..models.annotation import Annotation as AnnotationModel`
(fits under 79 chars; master and `connections.py` use the one-liner).

---

### [-] Finding 11 — `as string` cast in template markup  (WONTFIX — reviewed)
> **WONTFIX, with rationale.** On inspection this is a deliberate, documented
> design, and "fixing" it would *reduce* quality:
> - `PropertyColumnHeader.sortIcon` is intentionally typed `string` with a
>   comment: "Vuetify's getSortIcon is typed IconValue but always returns a
>   string … the parent narrows it." The `as string` cast IS that narrowing.
> - `getSortIcon` and `column` are Vuetify **slot-scoped** values; their types
>   are inferred *in the template*. Extracting the cast to a `<script>` helper
>   would force `any`/`unknown` params (the slot types aren't importable),
>   losing that inference — a net type-safety regression.
> - Widening the child prop to Vuetify's `IconValue` isn't viable: that type is
>   an internal `framework.d.ts` declaration, not cleanly exported from
>   `vuetify` and used nowhere in `src`.
>
> Net: the current template-level cast is the type-safest minimal option.
> Leaving as-is. (Happy to relocate it into an `any`-typed script helper if the
> markup-purity is preferred over the inference — flag if so.)
- **Severity:** Nit
- **Category:** Type Safety
- **File:** `src/components/AnnotationBrowser/AnnotationList.vue:218,257`

**Current:** `:sort-icon="getSortIcon(column) as string"`

**Fix:** Narrow once in `<script>` (e.g. make `getSortIcon` return a typed
`string`) rather than casting in markup.

**Rationale:** Casts elsewhere in these components live in `<script>`, not the
template. Narrowly justified; flagged for completeness.

---

### [x] Finding 12 — Braceless single-line `if`
> **DONE.** Braced the `if (hydrated)` body to match the file's dominant style.
> eslint clean.
- **Severity:** Nit
- **Category:** Pattern Consistency
- **File:** `src/store/annotation.ts:133`

**Current:** `if (hydrated) return hydrated;`

**Fix:** `if (hydrated) { return hydrated; }`

**Rationale:** The file is ~107 braced `if` bodies to effectively one braceless;
this breaks the dominant local style.

---

## Verification (post-fix)
- `pnpm tsc` (vue-tsc --noEmit): **pass** (exit 0).
- `pnpm lint:ci` (eslint, --max-warnings=0): **pass** (exit 0).
- `pnpm exec vitest run src/`: **pass** — 2400 tests across 138 files.
- backend `flake8` on all 5 touched files: **pass** (clean) throughout.
- backend `tox` (plugin pytest): **pass** — 284 passed, 0 failures (py311).
  Covers `test_server_list`, `test_uncomputed_counts`, `test_stubs`,
  `test_annotations`, `test_export` — the suites exercising the edited code.

All green. Changes are staged in the working tree (not committed).

## Lower-confidence items checked but NOT flagged (no action)
- `spatialIndex.ts:3` `interface SpatialItem` not `I`-prefixed — file-private,
  and `src/utils/` interface naming is genuinely mixed; no firm local norm.
- Backend `%`-style formatting vs f-strings — codebase leans f-string but `%`
  has local precedent in the plugin; mixed, not a defect.
- Backend comprehension wrapping at `annotation.py:556-557` — purely cosmetic.
