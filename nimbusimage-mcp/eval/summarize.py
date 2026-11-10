"""Summarize headless Claude Code runs: tool calls, turns, cost, answer.

Reads runs/taskNN.jsonl (stream-json output from run_eval.sh) and pairs
each with its line in tasks.txt.
"""

import json
from pathlib import Path

HERE = Path(__file__).parent
PREFIX = "mcp__nimbus__"


def summarize(path):
    calls, result = [], None
    for line in path.read_text().splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue  # stderr noise interleaved with the JSON stream
        if event.get("type") == "assistant":
            for block in event["message"].get("content", []):
                if block.get("type") == "tool_use":
                    name = block["name"].removeprefix(PREFIX)
                    calls.append(f"{name}({json.dumps(block['input'])})")
        elif event.get("type") == "result":
            result = event
    return calls, result


def main():
    tasks = (HERE / "tasks.txt").read_text().splitlines()
    for path in sorted((HERE / "runs").glob("task*.jsonl")):
        # taskNN is 1-based line NN of tasks.txt (see run_eval.sh), so a
        # missing run cannot shift the labels of the ones after it.
        task = tasks[int(path.stem.removeprefix("task")) - 1]
        calls, result = summarize(path)
        print(f"=== {path.stem}: {task}")
        for call in calls:
            print("   ->", call[:160])
        if result is None:
            print("   NO RESULT (run failed; see the jsonl)")
            continue
        print(
            f"   turns={result.get('num_turns')}"
            f" cost=${result.get('total_cost_usd', 0):.3f}"
            f" {result.get('duration_ms', 0) / 1000:.0f}s"
            f" error={result.get('is_error')}"
        )
        answer = (result.get("result") or "").replace("\n", " ")
        print("   ANSWER:", answer[:600])


if __name__ == "__main__":
    main()
