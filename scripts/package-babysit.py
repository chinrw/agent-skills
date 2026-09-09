#!/usr/bin/env python3
"""Export one native entrypoint with its shared resources materialized."""

import argparse
from pathlib import Path
import shutil


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runtime", choices=("codex", "claude"))
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    sources = {
        "codex": root / "codex-skills/babysit-prs-codex",
        "claude": root / "skills/babysit-prs",
    }
    destination = args.destination.resolve()
    if destination.is_relative_to(root):
        parser.error("export outside the source checkout")
    # copytree refuses an existing destination, preserving previous exports.
    shutil.copytree(sources[args.runtime], destination, symlinks=False,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))


if __name__ == "__main__":
    main()
