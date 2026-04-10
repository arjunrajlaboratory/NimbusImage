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

For each issue:
1. Quote the specific code location (`file:line`)
2. Explain why it's an issue
3. Provide a concrete suggestion or code example
4. Note the severity (must fix vs. nice to have)

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

```markdown
## Code Review: [branch-name]

### Overall Assessment
[Brief summary of code quality and main concerns]

### Issues to Address

#### 1. [Issue Title]
**File:** `src/store/example.ts:42`
**Severity:** High/Medium/Low

**Current code:**
\`\`\`typescript
// problematic code
\`\`\`

**Suggestion:**
\`\`\`typescript
// improved code
\`\`\`

**Rationale:** [Why this change improves the code]

---

### Minor Observations
- [Small improvements that aren't blocking]

### Questions for Clarification
- [Anything that needs discussion]

### Summary Table
| Category | Status |
|----------|--------|
| Pattern Consistency | pass/warn |
| Code Duplication | pass/warn |
| ...etc |
```

## References

- Codebase-specific review guidelines: `CLAUDE.md`
- Feature documentation index: `references/feature-documentation-index.md`
