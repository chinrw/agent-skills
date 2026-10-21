#!/usr/bin/env python3
"""Snapshot Specula result artifacts without executing scripts or changing the run."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys


REPORTS = {
    "confirmed-bugs.md": "confirmation", "bug-report.md": "model_or_review",
    "bug-severity.md": "severity", "summary.md": "summary",
    "pipeline-summary.md": "summary", ".summary-findings.md": "summary",
    "modeling-brief.md": "modeling", "investigation.md": "investigation",
    "description.md": "packaged_finding", "instrumentation.md": "mapping",
    "convergence-report.md": "modeling",
}
METADATA = {"run.json", "source-map.json", "input.json", "contract.json", "cases.json",
            "evidence.json", "source-identity.json", "source-info.json"}
SKIP_DIRS = {".git", "baseline.git", "source", "node_modules", "build", "states",
             ".specula-resume", ".resource-summary-invocations", ".stop-gate",
             ".agent-cwd", "__pycache__"}
RELATED_DIRS = {"spec", "repro", "harness", "traces", ".specula-output"}
FIELDS = {"finding id", "finding", "status", "source", "novelty", "severity",
          "location", "reproduction result"}
TEXT_SUFFIXES = {".md", ".txt", ".json", ".jsonl", ".ndjson", ".log", ".out",
                 ".tla", ".cfg", ".c", ".rs", ".py", ".sh", ".patch"}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def artifact_kind(path, base):
    name = path.name.lower()
    if name in REPORTS:
        return REPORTS[name]
    if name in METADATA:
        return "metadata"
    if path.suffix.lower() in (".tla", ".cfg"):
        return "model"
    parts = set(path.relative_to(base).parts[:-1])
    if parts & {"repro", "harness", "traces"} and path.suffix.lower() in TEXT_SUFFIXES:
        return "reproducer_or_trace"
    if name.startswith(("repro.", "counterexample")) and path.suffix.lower() in TEXT_SUFFIXES:
        return "reproducer_or_trace"
    if name == "run.sh":
        return "driver"
    if name in ("spec-validation.log", "model-checking.log", "bug-confirmation.log", "pipeline.log"):
        return "log"
    if "spec" in parts and "output" in parts and path.suffix.lower() in (".out", ".log", ".json"):
        return "counterexample_or_log"
    return None


def visible_lines(text):
    fence = None
    for number, line in enumerate(text.splitlines(), 1):
        match = re.match(r"^\s{0,3}(`{3,}|~{3,})(.*)$", line)
        if match:
            marker, rest = match.groups()
            if fence is None:
                fence = (marker[0], len(marker))
            elif marker[0] == fence[0] and len(marker) >= fence[1] and not rest.strip():
                fence = None
            continue
        if fence is None:
            yield number, line


def section_index(text, report_hash, origin):
    lines = list(visible_lines(text))
    headers = []
    for number, line in lines:
        match = re.match(r"^#{1,6}\s+(.+?)\s*#*\s*$", line)
        if match:
            headers.append((number, match.group(1)))
    selected = []
    for pattern in (r"^(Entry\s+\d+)\b", r"^(Bug\s+\d+)\b",
                    r"^((?:MC|CR|AST|RF)-\d+)\b"):
        selected = [(n, title, re.match(pattern, title).group(1))
                    for n, title in headers if re.match(pattern, title)]
        if selected:
            break
    sections = []
    for index, (start, title, label) in enumerate(selected):
        end = selected[index + 1][0] - 1 if index + 1 < len(selected) else len(text.splitlines())
        fields = {}
        pending_heading = None
        for number, line in lines:
            if not start < number <= end:
                continue
            plain = line.replace("**", "").strip()
            field = re.match(r"^(?:[-*]\s+)?([^:]+):\s*(.*)$", plain)
            if plain.startswith('|'):
                cells = [cell.strip() for cell in plain.strip('|').split('|')]
                if len(cells) == 2 and cells[0].lower() in FIELDS:
                    field = re.match(r"^([^:]+):\s*(.*)$", cells[0] + ": " + cells[1])
            if field and field.group(1).lower() in FIELDS:
                key = field.group(1).lower()
                fields.setdefault(key, []).append({"line": number, "value": field.group(2)})
            heading = re.match(r"^#{1,6}\s+(.+)$", plain)
            if heading:
                pending_heading = heading.group(1).lower() if heading.group(1).lower() in FIELDS else None
            elif pending_heading and plain:
                fields.setdefault(pending_heading, []).append({"line": number, "value": plain})
                pending_heading = None
        ids = set()
        for key in ("finding id", "finding"):
            for value in fields.get(key, []):
                candidate = value['value'].strip().strip('`')
                explicit_id = key == 'finding id' and re.fullmatch(
                    r'[A-Za-z0-9][A-Za-z0-9_.:/#-]*', candidate)
                short_id = re.fullmatch(r'(?:MC|CR|AST|RF)-\d+[A-Za-z0-9_.-]*', candidate)
                uuid = re.fullmatch(
                    r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', candidate)
                if explicit_id or short_id or uuid:
                    ids.add(candidate)
        sections.append({"local_key": digest((origin + ":" + report_hash + ":" + str(start)).encode())[:16],
                         "display_label": label, "title": title, "start_line": start, "end_line": end,
                         "finding_id": next(iter(ids)) if len(ids) == 1 else None,
                         "reported_fields": fields, "repair_status": "UNASSESSED"})
    return sections


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-file-bytes", type=int, default=8 * 1024 * 1024)
    parser.add_argument("--max-total-bytes", type=int, default=64 * 1024 * 1024)
    parser.add_argument("--max-depth", type=int, default=6)
    args = parser.parse_args()
    source, output = args.input.resolve(), args.output.resolve()
    index = {"schema_version": 1, "source_argument": str(args.input.absolute()),
             "source": str(source), "artifacts": [], "reports": [], "warnings": [],
             "pruned_directories": [], "collection_complete": False,
             "interpretation": "Reported fields are claims, not current repair or test verdicts."}
    try:
        if not source.exists() or not (source.is_dir() or source.suffix.lower() in TEXT_SUFFIXES):
            raise ValueError("input must be a result directory or a supported text artifact")
        if min(args.max_file_bytes, args.max_total_bytes, args.max_depth) <= 0:
            raise ValueError("collection limits must be positive")
        base = source if source.is_dir() else source.parent
        for ancestor in (base, *base.parents):
            if (ancestor / 'run.json').is_file():
                base = ancestor
                break
        input_container = args.input.absolute() if source.is_dir() else args.input.absolute().parent
        if output.is_relative_to(base) or output.is_relative_to(input_container.resolve()):
            raise ValueError("output must be outside the Specula run being read")
        candidates = {source} if source.is_file() else set()
        if source.is_dir():
            roots = [source]
        elif source.name == 'run.json':
            roots = [source.parent]
        else:
            roots = [source.parent / d for d in RELATED_DIRS if (source.parent / d).is_dir()]
        for directory in {base, source.parent if source.is_file() else source}:
            for path in directory.iterdir():
                if path.name.lower() in REPORTS or path.name.lower() in METADATA:
                    candidates.add(path)
        for root in roots:
            if root.is_symlink():
                index['warnings'].append('symlink directory not followed: ' + str(root))
                continue
            def onerror(error):
                index['warnings'].append(str(error))
            for current, dirs, names in os.walk(root, followlinks=False, onerror=onerror):
                current = Path(current)
                depth = len(current.relative_to(root).parts)
                for directory in list(dirs):
                    path = current / directory
                    if directory in SKIP_DIRS or (directory == 'target' and
                                                  set(current.relative_to(base).parts) & {'repro', 'harness'}):
                        dirs.remove(directory)
                        index['pruned_directories'].append(str(path))
                    elif path.is_symlink():
                        dirs.remove(directory)
                        index['warnings'].append('symlink directory not followed: ' + str(path))
                if depth >= args.max_depth and dirs:
                    index['warnings'].append('depth limit at: ' + str(current))
                    dirs[:] = []
                for name in sorted(names):
                    path = current / name
                    if artifact_kind(path, base):
                        candidates.add(path)
        if not candidates:
            raise ValueError("no recognized Specula artifacts found")
        output.mkdir(parents=True, exist_ok=False)
        index['base_directory'] = str(base)
        total = 0
        aliases = []
        for path in sorted(candidates):
            relative = path.relative_to(base)
            record = {"source_path": str(path), "relative_path": str(relative),
                      "kind": artifact_kind(path, base) or "provided", "snapshot": None}
            index['artifacts'].append(record)
            if path.is_symlink():
                aliases.append(record)
                continue
            if not path.is_file():
                index['warnings'].append('non-regular artifact not copied: ' + str(path))
                continue
            before = path.stat()
            record['bytes'] = before.st_size
            if before.st_size > args.max_file_bytes or total + before.st_size > args.max_total_bytes:
                index['warnings'].append('size limit; artifact not copied: ' + str(path))
                continue
            data = path.read_bytes()
            after = path.stat()
            stamp = lambda st: (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)
            if stamp(before) != stamp(after):
                index['warnings'].append('artifact changed during capture: ' + str(path))
                continue
            snapshot = Path('snapshots') / relative
            destination = output / snapshot
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            total += len(data)
            record.update(snapshot=str(snapshot), sha256=digest(data), mtime_ns=after.st_mtime_ns)
            if path.suffix.lower() == '.md':
                report = dict(record)
                report['sections'] = section_index(data.decode('utf-8', errors='replace'),
                                                   record['sha256'], str(path))
                index['reports'].append(report)
        captured = {a['source_path']: a for a in index['artifacts'] if a.get('sha256')}
        for record in aliases:
            path = Path(record['source_path'])
            target = path.resolve()
            original = captured.get(str(target)) if target.is_relative_to(base) else None
            if original is None or Path(original['source_path']).is_symlink():
                index['warnings'].append('symlink not followed outside captured artifacts: ' + str(path))
                continue
            data = (output / original['snapshot']).read_bytes()
            if total + len(data) > args.max_total_bytes:
                index['warnings'].append('size limit; alias not copied: ' + str(path))
                continue
            snapshot = Path('snapshots') / record['relative_path']
            destination = output / snapshot
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            total += len(data)
            record.update(snapshot=str(snapshot), sha256=digest(data), bytes=len(data),
                          alias_of=original['relative_path'], resolved_source_path=str(target))
            if path.suffix.lower() == '.md':
                report = dict(record)
                report['sections'] = section_index(data.decode('utf-8', errors='replace'),
                                                   record['sha256'], str(path))
                index['reports'].append(report)
        for artifact in index['artifacts']:
            path = Path(artifact['source_path'])
            if artifact.get('alias_of'):
                if str(path.resolve()) != artifact['resolved_source_path']:
                    index['warnings'].append('alias changed after capture: ' + str(path))
                continue
            if artifact.get('sha256') and digest(path.read_bytes()) != artifact['sha256']:
                index['warnings'].append('artifact changed after capture: ' + artifact['source_path'])
        index['reports'].sort(key=lambda r: (r['kind'] != 'confirmation', r['relative_path']))
        index['collection_complete'] = not index['warnings']
        (output / 'intake.json').write_text(json.dumps(index, indent=2) + '\n')
        print(json.dumps({'index': str(output / 'intake.json'), 'reports': len(index['reports']),
                          'sections': sum(len(r['sections']) for r in index['reports']),
                          'collection_complete': index['collection_complete'], 'warnings': index['warnings']}))
        return 0 if index['collection_complete'] else 3
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
