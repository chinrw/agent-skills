#!/usr/bin/env python3
"""Validate the YAML frontmatter of SKILL.md and every babysit-pr-* agent.

The node contract test asserts *which* values the frontmatter carries; this
asserts that the block is well-formed YAML at all, using a real parser when one
is available. A frontmatter block that silently fails to parse would make Claude
Code drop the model/effort settings without any visible error.
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(HERE)
AGENT_DIR = os.path.join(os.path.expanduser("~"), ".claude", "agents")

AGENTS = [
    "babysit-pr-spec-selector",
    "babysit-pr-finding-judge",
    "babysit-pr-thread-judge",
    "babysit-pr-verifier",
    "babysit-pr-composition-verifier",
    "babysit-pr-critical-composition-verifier",
]

EXPECTED = {
    "babysit-pr-spec-selector": "xhigh",
    "babysit-pr-finding-judge": "max",
    "babysit-pr-thread-judge": "max",
    "babysit-pr-verifier": "max",
    "babysit-pr-composition-verifier": "xhigh",
    "babysit-pr-critical-composition-verifier": "max",
}

try:
    import yaml  # type: ignore
except ImportError:  # pragma: no cover - environment dependent
    yaml = None


def extract(path: str) -> str:
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    if not text.startswith("---\n"):
        raise SystemExit(f"{path}: does not start with a frontmatter block")
    end = text.find("\n---\n", 3)
    if end < 0:
        raise SystemExit(f"{path}: unterminated frontmatter block")
    return text[4:end]


def parse(block: str, path: str) -> dict:
    if yaml is None:
        # Fall back to a scalar-only reader; enough to check the fields below.
        data = {}
        for line in block.splitlines():
            if ":" in line and not line.startswith((" ", "\t", "-")):
                key, _, value = line.partition(":")
                value = value.strip()
                if value and not value.startswith((">", "|")):
                    data[key.strip()] = value
        return data
    try:
        return yaml.safe_load(block) or {}
    except yaml.YAMLError as error:  # pragma: no cover
        raise SystemExit(f"{path}: invalid YAML frontmatter: {error}") from error


def main() -> int:
    skill_path = os.path.join(SKILL_DIR, "SKILL.md")
    skill = parse(extract(skill_path), skill_path)

    assert skill.get("name") == "babysit-prs", skill.get("name")
    assert skill.get("model") == "best", f"controller model downgraded: {skill.get('model')}"
    assert skill.get("effort") == "xhigh", f"controller effort changed: {skill.get('effort')}"
    print(f"ok  SKILL.md              model={skill.get('model')} effort={skill.get('effort')}")

    for name in AGENTS:
        path = os.path.join(AGENT_DIR, f"{name}.md")
        if not os.path.exists(path):
            raise SystemExit(f"missing agent definition: {path}")
        data = parse(extract(path), path)
        assert data.get("name") == name, f"{name}: name mismatch ({data.get('name')})"
        assert data.get("model") == "inherit", f"{name}: model downgraded ({data.get('model')})"
        assert data.get("effort") == EXPECTED[name], f"{name}: effort changed ({data.get('effort')})"
        print(f"ok  {name:<42} model=inherit effort={data.get('effort')}")

    if yaml is None:
        print("note: PyYAML unavailable; used the scalar fallback reader")

    return 0


if __name__ == "__main__":
    sys.exit(main())
