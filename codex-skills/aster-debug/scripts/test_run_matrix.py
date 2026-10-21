#!/usr/bin/env python3
"""Exercise the matrix CLI with synthetic adapter processes, not kernel tests."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest


RUNNER = Path(__file__).with_name("run_matrix.py")
ADAPTER = r'''
import json, os, sys, time
from pathlib import Path
cfg = json.loads(Path(sys.argv[1]).read_text())
out = Path(os.environ["ASTER_DEBUG_OUTPUT"])
if cfg.get("term_marker"):
    import signal
    Path(cfg["term_marker"]).with_name("term-pid").write_text(str(os.getpid()))
    signal.signal(signal.SIGTERM, lambda *_: Path(cfg["term_marker"]).write_text("term"))
    for index in range(1000):
        Path(cfg["term_heartbeat"]).write_text(str(index))
        time.sleep(.03)
if cfg.get("ready_marker"):
    Path(cfg["ready_marker"]).write_text("started")
if cfg.get("heartbeat"):
    import subprocess
    child_code = "import signal,sys,time; from pathlib import Path; signal.signal(signal.SIGTERM, signal.SIG_IGN); p=Path(sys.argv[1]); i=0\nwhile True:\n p.write_text(str(i)); i+=1; time.sleep(.03)\n"
    child = subprocess.Popen([sys.executable, "-c", child_code, cfg["heartbeat"]])
    Path(cfg["child_pid"]).write_text(str(child.pid))
    time.sleep(30)
if cfg.get("sleep"):
    print("adapter started", flush=True)
    time.sleep(30)
status = cfg.get("status", "FAIL" if cfg["role"] == "before" else "PASS")
if cfg.get("status_sequence"):
    counter = Path(cfg["counter"])
    index = int(counter.read_text()) if counter.exists() else 0
    status = cfg["status_sequence"][index]
    counter.write_text(str(index + 1))
artifacts = {}
for name in ("kernel", "reproducer", "regression"):
    artifact = out / (name + ".bin")
    artifact.write_text(cfg.get("kernel_payload", cfg["role"]) if name == "kernel"
                        else cfg.get("binary_payload", name))
    if cfg.get("binary_drift") and name != "kernel":
        artifact.write_text(name + out.name)
    artifacts[name] = str(artifact)
tests = {}
for name in ("reproducer", "regression"):
    evidence = name + " observed " + status
    print(evidence, flush=True)
    tests[name] = {"status": status, "checks": 0 if status == "SKIP" else 1,
                   "failures": 1 if status == "FAIL" else 0,
                   "failure_signature": "wrong-byte-count" if status == "FAIL" else "",
                   "evidence": evidence}
report = {"schema_version": 1, "source_id": cfg["source_id"],
          "platform": "linux" if cfg["role"] == "linux" else "asterinas",
          "input_digest": os.environ["ASTER_DEBUG_INPUT_DIGEST"],
          "environment": cfg["environment"], "preconditions": {"worker_started": True},
          "artifacts": artifacts, "tests": tests}
if cfg.get("report_updates"):
    report.update(cfg["report_updates"])
if cfg.get("remove_test"):
    del report["tests"]["regression"]
if cfg.get("zero_checks"):
    report["tests"]["regression"]["checks"] = 0
if cfg.get("wrong_signature"):
    report["tests"]["regression"]["failure_signature"] = "unrelated-failure"
if cfg.get("phantom_evidence"):
    report["tests"]["regression"]["evidence"] = "this assertion was never printed"
if cfg.get("pass_signature"):
    report["tests"]["regression"]["failure_signature"] = "wrong-byte-count"
if cfg.get("null_row"):
    report["tests"]["regression"] = None
if cfg.get("report_array"):
    report = []
if cfg.get("mutate_input"):
    Path(cfg["mutate_input"]).write_text("changed while running")
Path(os.environ["ASTER_DEBUG_RESULT"]).write_text(json.dumps(report))
default_exit = {"PASS": 0, "FAIL": 1, "SKIP": 77}[status]
sys.exit(cfg.get("exit_override", default_exit))
'''


class MatrixCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.run_number = 0
        self.adapter = self.root / "adapter.py"
        self.adapter.write_text(ADAPTER)
        self.source = self.root / "test-input.c"
        self.source.write_text("/* Synthetic fixture for runner validation. */\n")
        self.environment = {
            "architecture": "x86_64", "syscall": "preadv",
            "filesystem": "ext2", "io_mode": "buffered",
        }
        self.plan = {
            "schema_version": 1, "case_id": "synthetic-byte-count",
            "inputs": {"reproducer": [str(self.source)], "regression": [str(self.source)]},
            "environment": self.environment, "preconditions": ["worker_started"],
            "failure_signature": "wrong-byte-count", "targets": {},
        }
        for role in ("before", "after", "linux"):
            config = self.root / (role + ".json")
            config.write_text(json.dumps({"role": role, "source_id": role + "-source",
                                         "environment": self.environment}))
            self.plan["targets"][role] = {
                "source_id": role + "-source", "cwd": str(self.root),
                "command": [sys.executable, str(self.adapter), str(config)],
                "timeout_seconds": 5,
            }

    def configure(self, role, **changes):
        path = self.root / (role + ".json")
        config = json.loads(path.read_text())
        config.update(changes)
        path.write_text(json.dumps(config))

    def run_matrix(self):
        plan = self.root / "plan.json"
        plan.write_text(json.dumps(self.plan))
        self.run_number += 1
        out = self.root / ("result-" + str(self.run_number))
        result = subprocess.run(
            [sys.executable, str(RUNNER), str(plan), "--output", str(out)],
            capture_output=True, text=True, timeout=20,
        )
        report = json.loads((out / "matrix.json").read_text()) if (out / "matrix.json").exists() else {}
        return result, report

    def test_complete_before_after_linux_matrix(self):
        process, report = self.run_matrix()
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
        self.assertEqual(report["status"], "PASS")
        self.assertEqual(len(report["runs"]), 3)

    def test_baseline_that_does_not_fail_is_inconclusive(self):
        self.configure("before", status="PASS")
        process, report = self.run_matrix()
        self.assertEqual(process.returncode, 3, process.stdout + process.stderr)
        self.assertEqual(report["status"], "INCONCLUSIVE")

    def test_fixed_kernel_failure_is_a_failed_matrix(self):
        self.configure("after", status="FAIL")
        process, report = self.run_matrix()
        self.assertEqual(process.returncode, 1, process.stdout + process.stderr)
        self.assertEqual(report["status"], "FAIL")

    def test_linux_must_pass_the_same_oracle(self):
        self.configure("linux", status="FAIL")
        process, report = self.run_matrix()
        self.assertEqual(process.returncode, 1, process.stdout + process.stderr)
        self.assertEqual(report["status"], "FAIL")

    def test_skip_is_not_a_pass(self):
        self.configure("linux", status="SKIP")
        process, report = self.run_matrix()
        self.assertEqual(process.returncode, 3, process.stdout + process.stderr)
        self.assertEqual(report["status"], "INCONCLUSIVE")

    def test_swallowed_failure_is_an_error(self):
        self.configure("before", exit_override=0)
        process, report = self.run_matrix()
        self.assertEqual(process.returncode, 2, process.stdout + process.stderr)
        self.assertIn("masks", " ".join(report["notes"]))

    def test_unrelated_failure_does_not_establish_red(self):
        self.configure("before", wrong_signature=True)
        process, report = self.run_matrix()
        self.assertEqual(process.returncode, 2, process.stdout + process.stderr)
        self.assertIn("target bug", " ".join(report["notes"]))

    def test_zero_assertions_and_missing_tests_are_rejected(self):
        for mode in ("zero_checks", "remove_test", "phantom_evidence"):
            with self.subTest(mode=mode):
                self.configure("after", **{"zero_checks": False, "remove_test": False,
                                           "phantom_evidence": False, mode: True})
                process, report = self.run_matrix()
                self.assertEqual(process.returncode, 2, process.stdout + process.stderr)
                self.assertEqual(report["status"], "ERROR")

    def test_source_and_environment_must_match_the_plan(self):
        for update in ({"source_id": "stale-source"},
                       {"input_digest": "stale-inputs"},
                       {"environment": dict(self.environment, filesystem="tmpfs")}):
            with self.subTest(update=update):
                self.configure("linux", report_updates=update)
                process, report = self.run_matrix()
                self.assertEqual(process.returncode, 2, process.stdout + process.stderr)
                self.assertEqual(report["status"], "ERROR")

    def test_input_mutation_invalidates_the_run(self):
        self.configure("before", mutate_input=str(self.source))
        process, report = self.run_matrix()
        self.assertEqual(process.returncode, 2, process.stdout + process.stderr)
        self.assertIn("inputs changed", " ".join(report["notes"]))

    def add_cleanup(self, role, code=0):
        marker = self.root / (role + "-cleaned")
        script = self.root / (role + "-cleanup.py")
        script.write_text("from pathlib import Path\nimport sys\n"
                          + "Path(sys.argv[1]).write_text('cleaned')\n"
                          + "raise SystemExit(" + str(code) + ")\n")
        self.plan["targets"][role]["cleanup"] = [sys.executable, str(script), str(marker)]
        return marker

    def test_prepare_failure_stops_execution_and_cleans_up(self):
        marker = self.add_cleanup("before")
        self.plan["targets"]["before"]["prepare"] = [sys.executable, "-c", "raise SystemExit(9)"]
        process, report = self.run_matrix()
        self.assertEqual(process.returncode, 2, process.stdout + process.stderr)
        self.assertTrue(marker.exists())
        self.assertNotIn("run", report["runs"][0]["stages"])
        self.assertEqual(len(report["runs"]), 1)

    def test_timeout_is_recorded_and_cleanup_runs(self):
        marker = self.add_cleanup("before")
        self.configure("before", sleep=True)
        self.plan["targets"]["before"]["timeout_seconds"] = 0.2
        process, report = self.run_matrix()
        self.assertEqual(process.returncode, 2, process.stdout + process.stderr)
        self.assertTrue(marker.exists())
        self.assertTrue(report["runs"][0]["stages"]["run"]["timed_out"])

    def test_cleanup_failure_preserves_the_test_exit(self):
        self.add_cleanup("before", code=7)
        process, report = self.run_matrix()
        self.assertEqual(process.returncode, 2, process.stdout + process.stderr)
        stages = report["runs"][0]["stages"]
        self.assertEqual(stages["run"]["exit"], 1)
        self.assertEqual(stages["cleanup"]["exit"], 7)

    def test_identical_kernel_artifacts_do_not_prove_a_fix(self):
        self.configure("before", kernel_payload="same kernel")
        self.configure("after", kernel_payload="same kernel")
        process, report = self.run_matrix()
        self.assertEqual(process.returncode, 2, process.stdout + process.stderr)
        self.assertIn("same kernel", " ".join(report["notes"]))

    def test_later_success_does_not_hide_a_fixed_kernel_failure(self):
        self.plan["targets"]["after"]["attempts"] = 2
        self.configure("after", status_sequence=["FAIL", "PASS"], counter=str(self.root / "counter"))
        process, report = self.run_matrix()
        self.assertEqual(process.returncode, 1, process.stdout + process.stderr)
        self.assertEqual(report["status"], "FAIL")

    def test_bounded_race_baseline_keeps_all_attempts(self):
        self.plan["targets"]["before"]["attempts"] = 2
        self.configure("before", status_sequence=["PASS", "FAIL"], counter=str(self.root / "counter"))
        process, report = self.run_matrix()
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
        self.assertEqual(len(report["runs"]), 4)

    def test_pass_cannot_carry_a_failure_signature(self):
        self.configure("after", pass_signature=True)
        process, report = self.run_matrix()
        self.assertEqual(process.returncode, 2, process.stdout + process.stderr)
        self.assertEqual(report["status"], "ERROR")

    def test_test_binaries_must_stay_fixed_between_attempts(self):
        self.plan["targets"]["after"]["attempts"] = 2
        self.configure("after", binary_drift=True)
        process, report = self.run_matrix()
        self.assertEqual(process.returncode, 2, process.stdout + process.stderr)
        self.assertEqual(report["status"], "ERROR")

    def test_before_and_after_execute_the_same_tests(self):
        self.configure("after", binary_payload="a different test program")
        process, report = self.run_matrix()
        self.assertEqual(process.returncode, 2, process.stdout + process.stderr)
        self.assertEqual(report["status"], "ERROR")

    def test_malformed_json_shapes_produce_error_reports(self):
        for mode in ("report_array", "null_row"):
            with self.subTest(mode=mode):
                self.configure("after", **{"report_array": False, "null_row": False, mode: True})
                process, report = self.run_matrix()
                self.assertEqual(process.returncode, 2, process.stdout + process.stderr)
                self.assertEqual(report["status"], "ERROR")

    def test_invalid_plan_shape_produces_an_error_report(self):
        self.plan["environment"] = []
        process, report = self.run_matrix()
        self.assertEqual(process.returncode, 2, process.stdout + process.stderr)
        self.assertEqual(report["status"], "ERROR")

    def test_timeout_stops_an_ignoring_child_in_the_owned_group(self):
        heartbeat, pid_file = self.root / "heartbeat", self.root / "child-pid"
        self.configure("before", heartbeat=str(heartbeat), child_pid=str(pid_file))
        self.plan["targets"]["before"]["timeout_seconds"] = 0.3
        try:
            process, report = self.run_matrix()
            self.assertEqual(process.returncode, 2, process.stdout + process.stderr)
            self.assertTrue(heartbeat.exists())
            first = heartbeat.read_text()
            time.sleep(0.2)
            self.assertEqual(first, heartbeat.read_text(), "child continued after timeout")
        finally:
            if pid_file.exists():
                try:
                    os.kill(int(pid_file.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def interrupt_stage(self, stage):
        marker = self.root / "stage-ready"
        if stage == "run":
            self.configure("before", ready_marker=str(marker), sleep=True)
            cleanup_marker = self.add_cleanup("before")
        else:
            cleanup_marker = self.add_cleanup("before")
            (self.root / "before-cleanup.py").write_text(
                "from pathlib import Path\nimport sys,time\n"
                + "Path(sys.argv[1]).write_text('started')\ntime.sleep(30)\n")
            marker = cleanup_marker
        plan = self.root / "plan.json"
        plan.write_text(json.dumps(self.plan))
        out = self.root / "result"
        process = subprocess.Popen([sys.executable, str(RUNNER), str(plan), "--output", str(out)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 4
            while not marker.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(marker.exists(), "stage did not start")
            process.send_signal(signal.SIGINT)
            stdout, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 130, stdout + stderr)
            report = json.loads((out / "matrix.json").read_text())
            stages = report["runs"][0]["stages"]
            self.assertTrue(stages[stage]["interrupted"])
            self.assertTrue(cleanup_marker.exists())
            self.assertTrue((out / "before/attempt-1/run.json").exists())
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()

    def test_runtime_interrupt_preserves_stage_and_cleanup(self):
        self.interrupt_stage("run")

    def test_cleanup_interrupt_preserves_result_files(self):
        self.interrupt_stage("cleanup")

    def test_interrupt_during_timeout_still_finishes_termination(self):
        marker, heartbeat = self.root / "term", self.root / "term-heartbeat"
        self.configure("before", term_marker=str(marker), term_heartbeat=str(heartbeat))
        self.plan["targets"]["before"]["timeout_seconds"] = 0.3
        plan = self.root / "plan.json"
        plan.write_text(json.dumps(self.plan))
        out = self.root / "result"
        process = subprocess.Popen([sys.executable, str(RUNNER), str(plan), "--output", str(out)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 4
            while not marker.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(marker.exists(), "adapter did not receive SIGTERM")
            process.send_signal(signal.SIGINT)
            stdout, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 130, stdout + stderr)
            report = json.loads((out / "matrix.json").read_text())
            stage = report["runs"][0]["stages"]["run"]
            self.assertTrue(stage["timed_out"])
            self.assertTrue(stage["interrupted"])
            old_heartbeat = heartbeat.read_text()
            time.sleep(.15)
            self.assertEqual(old_heartbeat, heartbeat.read_text())
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            # The synthetic adapter has no external resources; stop it if the
            # deliberately faulty runner left it running during a red control.
            pid_path = self.root / "term-pid"
            if pid_path.exists():
                try:
                    os.kill(int(pid_path.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass


if __name__ == "__main__":
    unittest.main()
