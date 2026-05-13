---
name: branch-review
description: "Use when reviewing code changes on a feature branch before merging, or when the user asks for a code review, PR review, or branch diff analysis. Compares against a base branch (default: master). Checks both frontend and backend: looped DB/API calls (the #1 review issue), API vs model layer separation (models must not raise RestException), raw PyMongo usage, missing exc=True on model loads, broad exception handling, access control and permission escalation, code factorization, redundant validation, naming clarity, API calls in Vue components instead of GirderAPI.ts, unnecessary temporary variables, and TypeScript type safety. Use this skill even for small PRs — single-file backend changes often have layer violations or missing batch queries."
---

# Branch Code Review

Review code changes on a feature branch, checking for:
- Pattern consistency with existing codebase
- Code duplication that should be factored out
- Unnecessary temporary variables
- Proper use of existing functions and utilities
- Potential N+1 query patterns or looped API/DB calls (frontend AND backend)
- Type safety issues (avoiding `as any` casts)
- Error handling consistency
- API vs model layer separation (backend)
- Raw PyMongo usage instead of Girder Model methods (backend)
- Missing `exc=True` on model loads (backend)
- Broad exception handling (backend)
- Access control and permission escalation (backend)
- Redundant validation that duplicates framework behavior
- API calls placed directly in Vue components instead of API files (frontend)
- Frontend code compensating for backend issues

## Usage

```
/branch-review [base-branch]
```

**Arguments:**
- `base-branch` (optional): The branch to compare against. Defaults to `master`.

## Review Process

### Step 1: Gather Context

```bash
git diff [base-branch]...HEAD --stat
git diff [base-branch]...HEAD
```

### Step 2: Read Changed Files

For each significantly changed file, read the full file to understand context:
- Use the `Read` tool to examine new/modified files
- Look at surrounding code to understand existing patterns
- Check imports and dependencies

### Step 3: Load Feature Documentation

Check `references/feature-documentation-index.md` to find relevant architecture docs for the feature area being changed. Read those docs before reviewing to understand expected patterns.

### Step 4: Pattern Analysis

Compare new code against existing patterns:

1. **Store Modules**: Check `vuex-module-decorators` patterns
2. **API Clients**: Verify error handling patterns, check that API calls live in API files (not components)
3. **Vue Components**: Ensure structure consistency (props, computed, methods order)
4. **Backend API**: Check for looped DB queries, proper input conversion at API boundary, `exc=True` usage
5. **Backend Models**: Check Girder plugin patterns, verify no `RestException` imports, no HTTP concerns
6. **Access Control**: Verify mutation endpoints check WRITE/ADMIN access, consider permission escalation

Codebase-specific review guidelines are in `CLAUDE.md` - read them before reviewing.

### Step 5: Provide Actionable Feedback

Produce a single, numbered list of findings — do not split issues into separate "major" and "minor" sections. Use a Severity column instead (High / Medium / Low / Nit). For each finding, include:

1. A numeric ID (Finding 1, Finding 2, …)
2. A short title
3. The specific code location (`file:line`)
4. The severity (High / Medium / Low / Nit) and one category from the **Issue Categories** table
5. Current code, suggested code, and a brief rationale

Then produce two numbered tables (see **Example Output Format** below):
- A **Findings Summary** table whose rows correspond 1-to-1 with the findings list, in the same order, sharing the same numeric IDs.
- A **Checklist Coverage** table that lists each review category as a row and marks it pass / warn / n/a; warn rows cite the finding number(s) that caused the warning.

Routing rules — do not invent new top-level sections:
- Positive confirmations or "nothing wrong here" notes → fold into **Overall Assessment**, not into findings.
- Actionable nits / stylistic suggestions → make them a finding with **Severity: Nit**.
- Open questions that need user input (and aren't actionable as-is) → **Questions for Clarification**.

This keeps every actionable item discoverable from the Findings Summary table by number, and the Checklist Coverage table answers "what was checked vs. what was flagged" without overlapping content.

## Issue Categories

| Category | Description |
|----------|-------------|
| **Pattern Consistency** | Code that doesn't follow established patterns |
| **Code Duplication** | Logic that should be extracted to shared utilities |
| **Unnecessary Variables** | Temporary variables used only once |
| **Missing Abstractions** | Opportunities to use existing utilities |
| **Performance Issues** | N+1 queries, looped API/DB calls, missing batch endpoints |
| **Type Safety** | `as any` casts, missing types, unsafe assertions |
| **Error Handling** | Inconsistent or duplicate error handling |
| **Layer Violation** | API concerns in models or model concerns in API |
| **Security / Access Control** | Missing permission checks, bypassed access control |
| **Raw PyMongo** | Using `Model().collection.find()` instead of `Model().find()` |
| **Redundant Validation** | Checks that duplicate framework behavior |

## Backend-Specific Checks

When reviewing changes to `devops/girder/plugins/AnnotationPlugin/`, apply these additional checks:

### 1. Looped Database Queries
Search for patterns like `for ... in ...: Model().load(` or `[Model().load(id) for id in ids]`. These should use `$in` queries instead.

### 2. API vs Model Layer
- **Models** (`server/models/`) must NOT import or raise `RestException`. They should raise `ValueError` or `ValidationException`.
- **API files** (`server/api/`) should handle all input parsing/conversion at the top of the method, then pass clean data to models.
- Input conversion (string → ObjectId, JSON body parsing) should happen once at the API boundary, not in utility functions or models.

### 3. Raw PyMongo Access
Flag any use of `Model().collection.find()` — should be `Model().find()`. The only exception is `collection.aggregate()` for aggregation pipelines.

### 4. Model Loading
- Flag `Model().load(id, ...)` followed by `if result is None: raise ...`. Should use `exc=True` parameter instead.
- Flag `Model().load(id, force=True)` unless there's a clear comment explaining why access checks are bypassed.

### 5. Broad Exception Handling
Flag `except Exception:` or bare `except:`. These swallow errors like KeyboardInterrupt, MemoryError, etc. Catch specific exception types.

### 6. Access Control
- Check that mutation endpoints (POST, PUT, DELETE) verify the user has `WRITE` or `ADMIN` access on the affected resource.
- Check for permission escalation: can a user with WRITE access grant themselves broader access?
- Security enforcement must be in the backend. Frontend permission checks are cosmetic, not security.

### 7. Code Factorization
- Flag identical code blocks appearing in multiple API files — extract to a shared helper.
- Flag functions that re-fetch data already available in the calling context — pass as parameter instead.

### 8. Redundant Validation
- Flag ObjectId validity checks before `ObjectId()` conversion (the conversion itself raises on invalid input).
- Flag null checks after `Model().load(..., exc=True)` (exc=True already raises).

### 9. Naming
- Flag functions whose names reference parameters they no longer use.
- Flag generic variable names like `id`, `item`, `data` when a more specific name is possible.

## Frontend-Specific Checks

When reviewing changes to `src/`, apply these additional checks:

### 1. API Calls in Components
Flag any direct `this.girderRest.get(...)` or `this.girderRest.post(...)` calls in Vue components. These should be methods in `GirderAPI.ts`, `AnnotationsAPI.ts`, or the appropriate API file.

### 2. Looped Frontend API Calls
Flag `Promise.all(items.map(item => api.updateItem(item)))` patterns. Suggest using or creating a batch endpoint instead.

### 3. Frontend Compensating for Backend
Flag fallback patterns like "try new API, catch error, try old API". The frontend should trust the backend API. Double implementations create maintenance debt.

### 4. Store Organization
New state for distinct feature areas should go in a new store module, not `src/store/index.ts` (already 2000+ lines).

## Example Output Format

The output has exactly four sections, in this order: **Overall Assessment**, **Findings**, **Findings Summary**, **Checklist Coverage**. **Questions for Clarification** is optional and appears only if there are open questions. There is no separate "Minor Observations" section — small items become findings with Severity Nit.

The two tables are numbered and serve different purposes:
- **Findings Summary** — one row per finding, sharing IDs with the Findings list above.
- **Checklist Coverage** — one row per review category, showing what was checked. Cite finding numbers in the row(s) that warn so the reader can jump from "this category warned" → "because of finding #N".

```markdown
## Code Review: [branch-name]

### Overall Assessment
[1–3 sentences: scope of the diff, overall quality, and anything notable that is NOT a finding — e.g. positive confirmations such as "backend access control is intact" or "no looped DB calls introduced". Do not list issues here.]

### Findings

#### Finding 1: [Short title]
- **File:** `src/store/example.ts:42`
- **Severity:** High | Medium | Low | Nit
- **Category:** [one of the Issue Categories rows, e.g. Pattern Consistency]

**Current:**
\`\`\`typescript
// problematic code
\`\`\`

**Suggested:**
\`\`\`typescript
// improved code
\`\`\`

**Rationale:** [Why this change improves the code]

---

#### Finding 2: [Short title]
- **File:** `…`
- **Severity:** …
- **Category:** …

**Current:** … **Suggested:** … **Rationale:** …

---

### Findings Summary
| # | Severity | Category | Location | Summary |
|---|----------|----------|----------|---------|
| 1 | Low | Pattern Consistency | `src/store/example.ts:42` | one-line restatement of Finding 1 |
| 2 | Nit | Code Duplication | `src/components/Foo.vue:17` | one-line restatement of Finding 2 |

### Checklist Coverage
| Category | Status | Findings |
|----------|--------|----------|
| Pattern Consistency | warn | #1 |
| Code Duplication | warn | #2 |
| Unnecessary Variables | pass | — |
| Missing Abstractions | pass | — |
| Performance Issues (looped DB/API) | pass | — |
| Type Safety | pass | — |
| Error Handling | pass | — |
| Layer Violation (API vs model) | n/a | — |
| Security / Access Control | pass | — |
| Raw PyMongo | n/a | — |
| Redundant Validation | pass | — |
| API calls in Vue components | pass | — |
| Frontend compensating for backend | pass | — |

### Questions for Clarification
[Only include this section if there are open questions. Otherwise omit it.]
- [Question that needs the author's input]
```

Notes on the tables:
- Use `n/a` for categories that don't apply to the diff (e.g. backend-only checks on a frontend-only PR).
- Sort the Findings list and Findings Summary by descending severity (High → Nit). Tie-break by file path.
- Keep the **Summary** column in the Findings Summary to one line. The detailed reasoning belongs in the Findings entry above.

## References

- Codebase-specific review guidelines: `CLAUDE.md`
- Feature documentation index: `references/feature-documentation-index.md`
