---
description: Review code changes on current branch vs base branch (default: master)
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Edit
  - Write
  - Task
  - TodoWrite
argument-hint: [base-branch]
---

# Branch Code Review

Review the code changes on the current branch compared to `$ARGUMENTS` (or `master` if not specified).

## Current State
- **Current branch:** !`git branch --show-current`
- **Base branch:** $ARGUMENTS (default: master)

## Your Task

Perform a thorough code review following these steps:

### 1. Get the Diff
Run `git diff` to see all changes between the base branch and HEAD.

### 2. Review Each Changed File
For significant changes, read the full files to understand:
- Existing patterns in the codebase
- How similar features are implemented elsewhere
- What utilities/functions already exist

### 3. Check for Issues

Look for these common problems:

**Pattern Consistency:**
- Does new code follow existing patterns in the codebase?
- Are store modules using `vuex-module-decorators` correctly?
- Do API clients follow the same error handling patterns?

**Code Quality:**
- Are there unnecessary temporary variables?
- Is there duplicated logic that should be extracted?
- Are there `as any` type casts that could be avoided?

**Performance:**
- Are there looped API calls that should use batch endpoints?
- Are there N+1 query patterns?

**Error Handling:**
- Is error handling consistent with the rest of the codebase?
- Is there duplicate error logging (both API and store catching)?

### 4. Report Findings

Organize your review into:
1. **Issues to Address** - Problems that should be fixed
2. **Minor Observations** - Nice-to-haves
3. **Questions** - Things needing clarification

For each issue, provide:
- File and line number
- The problematic code
- A suggested fix
- Rationale

### 5. Summary Table

End with a summary table showing status for each category.

## Reference

See CLAUDE.md for project-specific coding guidelines, especially:
- Avoid looped database calls (use batch endpoints)
- Avoid unnecessary temporary variables
- Keep error handling in store actions, not API methods
- Extend types instead of using `as any`
