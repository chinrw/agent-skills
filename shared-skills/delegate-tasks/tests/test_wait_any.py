import json
import os
from pathlib import Path
from select import select
import signal
import subprocess
import sys
import tempfile
import unittest

RUNNER = Path(__file__).resolve().parents[1] / "scripts/wait-any.mts"
GATED = """
import pathlib, sys, time
while not pathlib.Path(sys.argv[1]).exists():
    time.sleep(0.01)
print(13)
"""


class WaitAnyTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.runner = subprocess.Popen(
            ["node", RUNNER, self.root / "logs"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0,
        )
        self.addCleanup(self.stop)

    def stop(self):
        if self.runner.poll() is None:
            self.runner.terminate()
        self.runner.wait(timeout=10)
        self.runner.stdin.close()
        self.runner.stdout.close()

    def send(self, request):
        self.runner.stdin.write((json.dumps(request) + "\n").encode())

    def submit(self, job, code, *args):
        self.send(dict(id=job, argv=[sys.executable, "-c", code, *args], cwd=str(self.root)))

    def event(self):
        self.assertTrue(select([self.runner.stdout], [], [], 10)[0], "timed out waiting for an event")
        return json.loads(self.runner.stdout.readline())

    def test_followup_starts_while_nine_commands_are_running(self):
        for i in range(10):
            self.submit(str(i), GATED, "first" if i == 0 else "remaining")
        started = [self.event() for _ in range(10)]
        self.assertEqual({e["id"] for e in started if e["event"] == "started"}, set(map(str, range(10))))
        (self.root / "first").touch()
        self.assertEqual(self.event(), dict(event="exited", id="0", returncode=0))
        first = next(e for e in started if e["id"] == "0")
        value = int(Path(first["stdout"]).read_text())
        self.assertEqual(value, 13)

        self.submit("next", "import sys; print(int(sys.argv[1]) * 2)", str(value))
        followup = self.event()
        self.assertEqual((followup["event"], followup["id"]), ("started", "next"))
        for e in started:
            if e["id"] != "0":
                os.kill(e["pid"], 0)
        self.assertEqual(self.event(), dict(event="exited", id="next", returncode=0))
        self.assertEqual(Path(followup["stdout"]).read_text().strip(), "26")
        self.send({"op": "close"})
        (self.root / "remaining").touch()
        finished = [self.event() for _ in range(9)]
        self.assertCountEqual(finished, [dict(event="exited", id=str(i), returncode=0) for i in range(1, 10)])
        self.assertEqual(self.runner.wait(timeout=10), 0)
        self.assertEqual(self.runner.stdout.read(), b"")

    def test_rejection_and_command_failure_have_distinct_events(self):
        self.send(dict(id="missing", argv=[str(self.root / "absent")]))
        self.assertEqual(self.event()["event"], "rejected")
        self.submit("bad", "import sys; print(sys.argv[1], file=sys.stderr); sys.exit(7)", "a b;$HOME")
        launched = self.event()
        self.assertEqual(self.event(), dict(event="exited", id="bad", returncode=7))
        self.submit("bad", "print('second attempt')")
        self.assertEqual(self.event()["event"], "rejected")
        self.runner.stdin.close()
        self.assertEqual(self.runner.wait(timeout=10), 0)
        self.assertEqual(Path(launched["stderr"]).read_text(), "a b;$HOME\n")

    def test_termination_reaps_running_command(self):
        self.submit("blocked", GATED, "never")
        child = self.event()
        self.runner.terminate()
        self.assertEqual(self.runner.wait(timeout=10), 128 + signal.SIGTERM)
        with self.assertRaises(ProcessLookupError):
            os.kill(child["pid"], 0)


if __name__ == "__main__":
    unittest.main()
