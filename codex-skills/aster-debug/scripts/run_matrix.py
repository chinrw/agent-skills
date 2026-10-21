#!/usr/bin/env python3
"""Run a reproducer/regression matrix against before, after, and Linux targets."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


ROLES = ("before", "after", "linux")
TESTS = ("reproducer", "regression")
EXIT_CODES = {"PASS": 0, "FAIL": 1, "ERROR": 2, "INCONCLUSIVE": 3}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    temporary.replace(path)


def resolve(path, base):
    value = Path(path)
    return (base / value).resolve() if not value.is_absolute() else value.resolve()


def input_identity(plan, base):
    records = {}
    for kind in TESTS:
        records[kind] = [
            {"path": str(path), "sha256": file_hash(path)}
            for path in sorted({resolve(item, base) for item in plan["inputs"][kind]})
        ]
    encoded = json.dumps(records, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest(), records


def validate_plan(plan):
    require(isinstance(plan, dict), "plan must be a JSON object")
    require(plan.get("schema_version") == 1, "unsupported plan schema")
    require(isinstance(plan.get("case_id"), str) and plan["case_id"], "case_id is required")
    require(isinstance(plan.get("failure_signature"), str) and plan["failure_signature"],
            "failure_signature is required")
    require(isinstance(plan.get("targets"), dict), "targets must be an object")
    require(set(plan["targets"]) == set(ROLES), "before, after, and linux targets are required")
    require(isinstance(plan.get("inputs"), dict), "inputs must be an object")
    for kind in TESTS:
        paths = plan.get("inputs", {}).get(kind)
        require(isinstance(paths, list) and paths and all(isinstance(p, str) for p in paths),
                "input files are required for " + kind)
    environment = plan.get("environment", {})
    require(isinstance(environment, dict), "environment must be an object")
    for key in ("architecture", "syscall", "filesystem", "io_mode"):
        require(isinstance(environment.get(key), str) and environment[key], "missing environment: " + key)
    checks = plan.get("preconditions", [])
    require(isinstance(checks, list) and all(isinstance(c, str) and c for c in checks),
            "preconditions must be names of observed conditions")
    for role in ROLES:
        target = plan["targets"][role]
        require(isinstance(target, dict), "target must be an object: " + role)
        require(isinstance(target.get("source_id"), str) and target["source_id"], "missing source_id: " + role)
        require(isinstance(target.get("cwd"), str), "missing cwd: " + role)
        for stage in ("prepare", "command", "cleanup"):
            if stage == "command" or stage in target:
                argv = target.get(stage)
                require(isinstance(argv, list) and argv and all(isinstance(arg, str) for arg in argv),
                        role + " " + stage + " must be an argv array")
        timeout = target.get("timeout_seconds", 600)
        require(type(timeout) in (int, float) and math.isfinite(timeout) and timeout > 0,
                "timeout_seconds must be finite and positive")
        attempts = target.get("attempts", 1)
        require(type(attempts) is int and attempts > 0, "attempts must be positive")
    require(plan["targets"]["before"]["source_id"] != plan["targets"]["after"]["source_id"],
            "before and after must identify distinct source states")


def stop_process(process):
    interrupted = False
    try:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass
    except KeyboardInterrupt:
        interrupted = True
    finally:
        # Finish terminating the owned group even if cancellation interrupts
        # the grace period or the group leader exits before its descendants.
        while True:
            try:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
                break
            except KeyboardInterrupt:
                interrupted = True
    return interrupted


def run_command(argv, cwd, env, timeout, log_path):
    started = time.monotonic()
    record = {"argv": argv, "cwd": str(cwd), "log": str(log_path)}
    process = None
    try:
        with log_path.open("wb") as stream:
            process = subprocess.Popen(argv, cwd=cwd, env=env, stdout=stream,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            try:
                record["exit"] = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                interrupted = stop_process(process)
                record.update(exit=process.returncode, timed_out=True, interrupted=interrupted)
            except KeyboardInterrupt:
                stop_process(process)
                record.update(exit=process.returncode, interrupted=True)
            except BaseException:
                stop_process(process)
                raise
    except (OSError, ValueError) as error:
        record.update(exit=None, error=str(error))
    finally:
        record["seconds"] = round(time.monotonic() - started, 3)
    return record


def command_ok(record):
    return (record.get("exit") == 0 and not record.get("timed_out")
            and not record.get("interrupted") and not record.get("error"))


def validate_report(report, plan, role, target, digest, run, directory):
    require(isinstance(report, dict), "adapter report must be a JSON object")
    require(report.get("schema_version") == 1, "unsupported adapter report schema")
    require(report.get("source_id") == target["source_id"], "source identity mismatch")
    expected_platform = "linux" if role == "linux" else "asterinas"
    require(report.get("platform") == expected_platform, "platform mismatch")
    require(report.get("input_digest") == digest, "test input identity mismatch")
    environment = report.get("environment", {})
    require(isinstance(environment, dict), "reported environment must be an object")
    for key, value in plan["environment"].items():
        require(environment.get(key) == value and type(environment.get(key)) is type(value),
                "environment mismatch: " + key)
    preconditions = report.get("preconditions", {})
    require(isinstance(preconditions, dict), "reported preconditions must be an object")
    unmet = [key for key in plan.get("preconditions", []) if preconditions.get(key) is not True]
    rows = report.get("tests", {})
    require(isinstance(rows, dict), "tests must be an object")
    require(set(rows) == set(TESTS), "missing or unexpected test results")
    log = Path(run["log"]).read_text(errors="replace")
    for name, row in rows.items():
        require(isinstance(row, dict), "test result must be an object: " + name)
        status = row.get("status")
        require(status in ("PASS", "FAIL", "SKIP"), "unusable test status: " + name)
        checks, failures = row.get("checks"), row.get("failures")
        require(type(checks) is int and type(failures) is int and 0 <= failures <= checks,
                "invalid assertion counts: " + name)
        if status != "SKIP":
            require(checks > 0, "zero assertions cannot validate " + name)
        require((status == "FAIL") == (failures > 0), "status/assertion mismatch: " + name)
        if status == "FAIL":
            require(row.get("failure_signature") == plan["failure_signature"],
                    "failure does not match the target bug: " + name)
        else:
            require(row.get("failure_signature", "") == "", "failure signature on " + status + ": " + name)
        evidence = row.get("evidence")
        require(isinstance(evidence, str) and evidence.strip() and evidence in log,
                "missing raw output evidence: " + name)
    statuses = {row["status"] for row in rows.values()}
    expected_exit = 1 if "FAIL" in statuses else 77 if "SKIP" in statuses else 0
    require(run.get("exit") == expected_exit, "adapter exit masks or contradicts test results")
    artifacts = {}
    require(isinstance(report.get("artifacts"), dict), "artifacts must be an object")
    for name in ("kernel", *TESTS):
        path = resolve(report.get("artifacts", {})[name], directory)
        require(path.is_file(), "missing runtime artifact: " + name)
        artifacts[name] = {"path": str(path), "sha256": file_hash(path)}
    return {"tests": rows, "artifacts": artifacts, "unmet_preconditions": unmet}


def run_target(plan, role, target, attempt, output, base, digest):
    directory = output / role / ("attempt-" + str(attempt))
    directory.mkdir(parents=True)
    report_path = directory / "adapter-result.json"
    env = dict(os.environ, ASTER_DEBUG_OUTPUT=str(directory),
               ASTER_DEBUG_RESULT=str(report_path), ASTER_DEBUG_INPUT_DIGEST=digest)
    cwd = resolve(target["cwd"], base)
    timeout = target.get("timeout_seconds", 600)
    record = {"role": role, "attempt": attempt, "source_id": target["source_id"],
              "stages": {}, "errors": []}
    try:
        require(input_identity(plan, base)[0] == digest, "inputs changed before target")
        if "prepare" in target:
            setup = run_command(target["prepare"], cwd, env, timeout, directory / "prepare.log")
            record["stages"]["prepare"] = setup
            if setup.get("interrupted"):
                record["interrupted"] = True
            require(command_ok(setup), "prepare failed; runtime was not started")
        run = run_command(target["command"], cwd, env, timeout, directory / "run.log")
        record["stages"]["run"] = run
        if run.get("interrupted"):
            record["interrupted"] = True
        require(not run.get("interrupted"), "runtime interrupted")
        require(not run.get("timed_out"), "runtime timed out")
        require(not run.get("error"), run.get("error", "runtime launch failed"))
        report = json.loads(report_path.read_text())
        record.update(validate_report(report, plan, role, target, digest, run, directory))
    except KeyboardInterrupt:
        record["errors"].append("interrupted")
        record["interrupted"] = True
    except (OSError, ValueError, TypeError, KeyError) as error:
        record["errors"].append(str(error))
    finally:
        if "cleanup" in target:
            cleanup = run_command(target["cleanup"], cwd, env, timeout, directory / "cleanup.log")
            record["stages"]["cleanup"] = cleanup
            if cleanup.get("interrupted"):
                record["interrupted"] = True
            if not command_ok(cleanup):
                record["errors"].append("cleanup failed; original stage results retained")
        try:
            require(input_identity(plan, base)[0] == digest, "test inputs changed during target")
        except (OSError, ValueError, TypeError, KeyError) as error:
            record["errors"].append(str(error))
        write_json(directory / "run.json", record)
    return record


def verdict(runs):
    if any(run["errors"] for run in runs):
        return "ERROR", [error for run in runs for error in run["errors"]]
    require({run["role"] for run in runs} == set(ROLES), "matrix lacks a required target")
    hashes = {}
    for role in ROLES:
        for name in ("kernel", *TESTS):
            values = {run["artifacts"][name]["sha256"] for run in runs if run["role"] == role}
            if len(values) != 1:
                return "ERROR", [role + " " + name + " artifact changed between attempts"]
            hashes[role, name] = values
    if hashes["before", "kernel"] == hashes["after", "kernel"]:
        return "ERROR", ["before and after used the same kernel artifact"]
    for name in TESTS:
        if hashes["before", name] != hashes["after", name]:
            return "ERROR", ["before and after executed different " + name + " binaries"]
    for run in runs:
        if run["role"] != "before" and any(row["status"] == "FAIL" for row in run["tests"].values()):
            return "FAIL", [run["role"] + " still fails the target oracle"]
    gaps = []
    for run in runs:
        if run["unmet_preconditions"]:
            gaps.append(run["role"] + " lacks preconditions: " + ", ".join(run["unmet_preconditions"]))
        if any(row["status"] == "SKIP" for row in run["tests"].values()):
            gaps.append(run["role"] + " skipped a required test")
    for kind in TESTS:
        if not any(run["role"] == "before" and run["tests"][kind]["status"] == "FAIL" for run in runs):
            gaps.append("before did not reproduce the target failure in " + kind)
    return ("INCONCLUSIVE", gaps) if gaps else ("PASS", [])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    def interrupt(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupt)
    output = args.output.resolve()
    try:
        output.mkdir(parents=True, exist_ok=False)
    except OSError as error:
        print(str(error), file=sys.stderr)
        return 2
    summary = {"schema_version": 1, "status": "ERROR", "runs": [], "notes": []}
    try:
        raw = args.plan.read_bytes()
        plan = json.loads(raw)
        validate_plan(plan)
        digest, inputs = input_identity(plan, args.plan.resolve().parent)
        summary.update(case_id=plan["case_id"], plan_sha256=hashlib.sha256(raw).hexdigest(),
                       input_digest=digest, inputs=inputs)
        (output / "plan.json").write_bytes(raw)
        for role in ROLES:
            target = plan["targets"][role]
            for attempt in range(1, target.get("attempts", 1) + 1):
                print(role + " attempt " + str(attempt), flush=True)
                record = run_target(plan, role, target, attempt, output,
                                    args.plan.resolve().parent, digest)
                summary["runs"].append(record)
                write_json(output / "matrix.json", summary)
                if record["errors"]:
                    break
            if record["errors"]:
                break
        summary["status"], summary["notes"] = verdict(summary["runs"])
    except KeyboardInterrupt:
        summary["notes"].append("interrupted")
        summary["interrupted"] = True
    except (OSError, ValueError, TypeError, KeyError) as error:
        summary["notes"].append(str(error))
    write_json(output / "matrix.json", summary)
    print(json.dumps({"status": summary["status"], "notes": summary["notes"],
                      "report": str(output / "matrix.json")}), flush=True)
    if summary.get("interrupted") or any(run.get("interrupted") for run in summary["runs"]):
        return 130
    return EXIT_CODES[summary["status"]]


if __name__ == "__main__":
    raise SystemExit(main())
