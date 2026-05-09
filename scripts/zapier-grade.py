#!/usr/bin/env python3
"""
Zapier grader bridge for differential testing.

Reads JSONL from stdin: {idx, assertion, world}
Writes JSONL to stdout: {idx, satisfied, error?}

One subprocess invocation grades thousands of cases — much cheaper than
spawning Python per case. Pure passthrough to AutomationBench's official
AssertionRegistry, so by definition this IS Zapier's grading.

Errors (e.g. unhandled assertion type, schema validation failure) are
reported per-case and do not crash the whole batch.
"""
import json
import os
import sys

# Run with strict mode off — we want errors as data, not exceptions.
os.environ["AUTOMATIONBENCH_STRICT_ASSERTIONS"] = "0"

from automationbench.schema.world import WorldState
from automationbench.rubric.registry import AssertionRegistry
import automationbench.rubric.assertions  # noqa: F401  (registers handlers)


def grade_one(case: dict) -> dict:
    idx = case["idx"]
    try:
        world = WorldState.model_validate(case["world"])
    except Exception as e:
        return {"idx": idx, "satisfied": None, "error": f"world_parse: {type(e).__name__}: {e}"}
    try:
        satisfied = AssertionRegistry.check(world, case["assertion"])
        return {"idx": idx, "satisfied": bool(satisfied)}
    except Exception as e:
        return {"idx": idx, "satisfied": None, "error": f"check: {type(e).__name__}: {e}"}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        case = json.loads(line)
        result = grade_one(case)
        sys.stdout.write(json.dumps(result) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
