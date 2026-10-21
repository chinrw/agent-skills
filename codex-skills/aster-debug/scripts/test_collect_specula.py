#!/usr/bin/env python3
"""Validate read-only Specula intake through its command-line interface."""

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


COLLECTOR = Path(__file__).with_name("collect_specula.py")


class SpeculaIntakeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.run = self.root / "run"
        self.output = self.run / "target/.specula-output"
        self.output.mkdir(parents=True)
        self.report = self.output / "confirmed-bugs.md"
        self.report.write_text('''# Confirmation

## Entry 1: Short count
- **Finding ID**: MC-3
- **Source**: MC
- **Status**: REPRODUCED
## Reproduction result
PASS — the old kernel overwrote the tail.

```text
## Entry 99: this is raw log text
- **Finding ID**: fake
```

## Entry 2: Existing issue
| Finding | CR-7 |
| Status | DROPPED (code-review × known) |
''')
        (self.run / "run.json").write_text('{"run_id":"example","artifact_git_sha":"engine-revision"}')
        (self.run / "source-map.json").write_text('{"targets":{"target":{"baseline":"snapshot-revision"}}}')

    def collect(self, source=None, output=None, *extra):
        dest = output or self.root / "intake"
        result = subprocess.run([sys.executable, str(COLLECTOR), str(source or self.run),
                                 "--output", str(dest), *extra],
                                capture_output=True, text=True, timeout=10)
        index = json.loads((dest / "intake.json").read_text()) if (dest / "intake.json").exists() else {}
        return result, index, dest

    def test_hidden_run_outputs_preserve_ids_and_raw_status(self):
        before = hashlib.sha256(self.report.read_bytes()).hexdigest()
        result, index, dest = self.collect()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        report = next(r for r in index["reports"] if r["kind"] == "confirmation")
        sections = report["sections"]
        self.assertEqual([r["finding_id"] for r in sections], ["MC-3", "CR-7"])
        self.assertEqual(sections[0]["reported_fields"]["status"][0]["value"], "REPRODUCED")
        self.assertTrue(sections[0]["reported_fields"]["reproduction result"][0]["value"].startswith("PASS"))
        self.assertEqual(sections[0]["repair_status"], "UNASSESSED")
        self.assertEqual(sections[1]["repair_status"], "UNASSESSED")
        self.assertEqual((dest / report["snapshot"]).read_bytes(), self.report.read_bytes())
        self.assertEqual(hashlib.sha256(self.report.read_bytes()).hexdigest(), before)

    def test_related_reproducer_is_copied_but_never_executed(self):
        repro = self.output / "repro"
        repro.mkdir()
        marker = self.root / "executed"
        script = repro / "test_bugMC-3.sh"
        script.write_text("#!/bin/sh\ntouch '" + str(marker) + "'\n")
        script.chmod(0o755)
        result, index, dest = self.collect()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(marker.exists())
        artifact = next(r for r in index["artifacts"] if r["relative_path"].endswith(script.name))
        self.assertEqual((dest / artifact["snapshot"]).read_bytes(), script.read_bytes())

    def test_source_checkout_and_agent_activity_are_not_ingested(self):
        source = self.run / "target/source"
        source.mkdir()
        (source / "bug-report.md").write_text("not a pipeline result")
        (self.output / "agent.activity.jsonl").write_text("not confirmation evidence")
        result, index, _ = self.collect()
        self.assertEqual(result.returncode, 0, result.stderr)
        names = [a["relative_path"] for a in index["artifacts"]]
        self.assertFalse(any("/source/" in name or "activity.jsonl" in name for name in names))
        self.assertFalse("source_revision" in index)

    def test_output_inside_run_is_rejected(self):
        result, _, _ = self.collect(output=self.run / "new-intake")
        self.assertEqual(result.returncode, 2)
        self.assertFalse((self.run / "new-intake").exists())

    def test_size_limit_is_reported_as_partial(self):
        (self.output / "pipeline-summary.md").write_text("x" * 2000)
        result, index, _ = self.collect(None, None, "--max-file-bytes", "1000")
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertFalse(index["collection_complete"])
        self.assertTrue(any("size limit" in w for w in index["warnings"]))

    def test_child_symlink_is_not_followed(self):
        outside = self.root / "outside.txt"
        outside.write_text("private unrelated data")
        (self.output / "bug-report.md").symlink_to(outside)
        result, index, dest = self.collect()
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertFalse(any(outside.read_bytes() == p.read_bytes()
                             for p in (dest / "snapshots").rglob('*') if p.is_file()))
        self.assertTrue(any("symlink" in w for w in index["warnings"]))

    def test_packaged_description_file_is_an_input(self):
        description = self.root / "package/description.md"
        description.parent.mkdir()
        description.write_text("# RF-05 — read past EOF\n\nClaim and source anchors.\n")
        result, index, _ = self.collect(source=description)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(index["reports"][0]["sections"][0]["display_label"], "RF-05")
        self.assertIsNone(index["reports"][0]["sections"][0]["finding_id"])

    def test_descriptive_finding_text_is_not_an_identifier(self):
        investigation = self.output / "investigation.md"
        investigation.write_text(
            "# MC-3 — read beyond EOF\n\n- **Finding**: MC-3 — ramfs read beyond EOF\n")
        result, index, _ = self.collect()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = next(r for r in index["reports"] if r["kind"] == "investigation")
        self.assertIsNone(report["sections"][0]["finding_id"])
        self.assertEqual(report["sections"][0]["display_label"], "MC-3")

    def test_plain_report_file_protects_its_directory(self):
        report = self.run / "confirmed-bugs.md"
        report.write_bytes(self.report.read_bytes())
        result, _, _ = self.collect(source=report, output=self.run / "intake")
        self.assertEqual(result.returncode, 2)
        self.assertFalse((self.run / "intake").exists())

    def test_manifest_file_discovers_its_target_reports(self):
        result, index, _ = self.collect(source=self.run / 'run.json')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(any(r['kind'] == 'confirmation' for r in index['reports']))

    def test_manifest_input_also_protects_the_run_directory(self):
        result, _, _ = self.collect(source=self.run / 'run.json', output=self.run / 'intake')
        self.assertEqual(result.returncode, 2)
        self.assertFalse((self.run / 'intake').exists())

    def test_internal_alias_to_a_captured_trace_is_materialized(self):
        target = self.output / 'spec/output/counterexample.json'
        target.parent.mkdir(parents=True)
        target.write_text('{"states":[1,2]}')
        alias = target.parent / 'output/counterexample.json'
        alias.parent.mkdir()
        alias.symlink_to('../counterexample.json')
        result, index, dest = self.collect()
        self.assertEqual(result.returncode, 0, result.stderr)
        record = next(a for a in index['artifacts'] if a['source_path'] == str(alias))
        self.assertIn('alias_of', record)
        self.assertFalse((dest / record['snapshot']).is_symlink())
        self.assertEqual((dest / record['snapshot']).read_bytes(), target.read_bytes())

    def test_local_keys_keep_identical_reports_in_different_targets_separate(self):
        other = self.run / 'second/.specula-output'
        other.mkdir(parents=True)
        (other / 'confirmed-bugs.md').write_bytes(self.report.read_bytes())
        result, index, _ = self.collect()
        self.assertEqual(result.returncode, 0, result.stderr)
        reports = [r for r in index['reports'] if r['kind'] == 'confirmation']
        keys = [r['sections'][0]['local_key'] for r in reports]
        self.assertEqual(len(keys), 2)
        self.assertEqual(len(set(keys)), 2)


if __name__ == '__main__':
    unittest.main()
