# NimbusImage Codex Skills Review

Branch: `codex/nimbusimage-codex-skills`

## Finding 1: Credential detection can expose secrets

- **Severity:** High
- **Location:** `plugins/nimbusimage/skills/nimbusimage/SKILL.md:58`
- **Summary:** The skill suggests using `echo` to inspect credential variables and asking users to paste API keys into conversation.
- **Status:** fixed `3e4cb076`

## Finding 2: Annotation pagination guidance can skip records

- **Severity:** Medium
- **Location:** `plugins/nimbusimage/skills/annotations/SKILL.md:35`
- **Summary:** The skill demonstrates offset pagination without the accessor's mutation-safety warning and omits `iter_all` from the API reference.
- **Status:** fixed `3e4cb076`

## Finding 3: Documentation-only drift bypasses CI

- **Severity:** Low
- **Location:** `.github/workflows/agent-skills.yaml:4`
- **Summary:** The synchronization validator reads `README.md` and `nimbusimage/README.md`, but changes to those files do not trigger its workflow.
- **Status:** fixed `3e4cb076`

## Finding 4: Stale generated reference files are never removed

- **Severity:** Low
- **Location:** `plugins/nimbusimage/scripts/sync_skills.py:87`
- **Summary:** Synchronization overwrites known reference files without replacing or validating the generated reference directory as a complete tree.
- **Status:** fixed `3e4cb076`
