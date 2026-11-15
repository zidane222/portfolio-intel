#!/usr/bin/env python3
"""Fail if a workflow run: script contains an inputs expression (KAN-109).

Inputs must reach a shell through env: and be quoted there. Usage:
    python3 scripts/lint_workflow_inputs.py [workflow.yml ...]
With no arguments it checks every file in .github/workflows.
"""
import glob
import re
import sys

import yaml

BAD = re.compile(r"\$\{\{[^}]*\b(github\.event\.inputs|inputs)\b[^}]*\}\}")


def check(path):
    with open(path) as f:
        doc = yaml.safe_load(f) or {}
    found = []
    for job_name, job in (doc.get("jobs") or {}).items():
        for i, step in enumerate((job or {}).get("steps") or []):
            run = step.get("run")
            if isinstance(run, str) and BAD.search(run):
                found.append(f"{path}: job {job_name}, step {i + 1}: inputs expression in run:")
    return found


def main(argv):
    files = argv or sorted(glob.glob(".github/workflows/*.yml"))
    problems = [p for f in files for p in check(f)]
    for p in problems:
        print("::error::" + p)
    if problems:
        print("Pass inputs through env: and quote them in the script.")
        return 1
    print(f"ok: {len(files)} workflow files, no inputs expression in a run: block")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
