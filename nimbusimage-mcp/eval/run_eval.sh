#!/usr/bin/env bash
# Run every task in tasks.txt through headless Claude Code against a running
# nimbusimage-mcp server, in parallel, then summarize tool choice, turns,
# cost, and answers.
#
#   NI_MCP_KEY_FILE=../tmp/local_api_key.txt eval/run_eval.sh [http://127.0.0.1:8000/mcp]
#
# The key file holds a Girder API key for the user the tasks run as (a
# full-access key: job status and help topics need core.user_auth). Start the
# server with a fresh call log (NI_MCP_CALL_LOG=<new file>) so the eval's
# sizes and latencies are not mixed with earlier calls. The tasks only read.
#
# Only the read-only nimbus MCP tools (and ni_worker_interface) are
# allowed, and user/project settings are not
# loaded, so Claude cannot fall back to the nimbusimage skills or Bash.
set -euo pipefail
EVAL="$(cd "$(dirname "$0")" && pwd)"
URL="${1:-http://127.0.0.1:8000/mcp}"
KEY="$(tr -d '[:space:]' < "${NI_MCP_KEY_FILE:?set NI_MCP_KEY_FILE}")"
WORK="$(mktemp -d)"   # neutral cwd: no CLAUDE.md, no repo context
trap 'rm -rf "$WORK"' EXIT
# The config holds the key, so it lives in the temp dir, never in the repo.
# (Passed through the environment, not argv, so it stays out of `ps`.)
NI_URL="$URL" NI_KEY="$KEY" python3 -c 'import json, os
print(json.dumps({"mcpServers": {"nimbus": {
    "type": "http", "url": os.environ["NI_URL"],
    "headers": {"Authorization": "Bearer " + os.environ["NI_KEY"]}}}}))' \
  > "$WORK/mcp.json"
mkdir -p "$EVAL/runs"
rm -f "$EVAL"/runs/*.jsonl

# The read-only tools, plus ni_worker_interface (it registers a worker's
# interface, not the user's data). Not "mcp__nimbus", which would allow
# ni_worker_run, ni_property_compute and ni_annotations_tag unprompted.
READ_TOOLS="mcp__nimbus__ni_datasets_list mcp__nimbus__ni_dataset_info mcp__nimbus__ni_annotations_count mcp__nimbus__ni_annotations_summary mcp__nimbus__ni_annotations_list mcp__nimbus__ni_image_get_composite mcp__nimbus__ni_image_get_channel mcp__nimbus__ni_properties_list mcp__nimbus__ni_property_values_summary mcp__nimbus__ni_property_histogram mcp__nimbus__ni_workers_list mcp__nimbus__ni_job_wait mcp__nimbus__ni_help_topic mcp__nimbus__ni_worker_interface"

i=0
pids=()
while IFS= read -r task; do
  i=$((i + 1))
  # </dev/null matters: claude -p appends piped stdin to the prompt, which
  # would otherwise hand the rest of tasks.txt to the first session.
  (cd "$WORK" && claude -p "$task" \
      --mcp-config "$WORK/mcp.json" --strict-mcp-config \
      --setting-sources "" \
      --allowedTools "$READ_TOOLS" \
      --disallowedTools "Bash Read Write Edit Glob Grep WebFetch WebSearch Agent NotebookEdit Skill" \
      --output-format stream-json --verbose --max-turns 15 \
      < /dev/null > "$EVAL/runs/task$(printf %02d "$i").jsonl" 2>&1) &
  pids+=("$!")
done < "$EVAL/tasks.txt"

failed=0
for pid in "${pids[@]}"; do wait "$pid" || failed=$((failed + 1)); done
[ "$failed" -eq 0 ] || echo "WARNING: $failed claude run(s) exited non-zero" >&2

cd "$EVAL" && python3 summarize.py
