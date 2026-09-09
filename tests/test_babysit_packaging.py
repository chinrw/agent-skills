"""Native entrypoints share source resources and export without repo dependencies."""
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / "codex-skills/babysit-prs-codex"


class PackagingTests(unittest.TestCase):
    def test_claude_resources_are_the_same_source(self):
        for name in ("scripts", "schemas", "prompts", "references", "tests"):
            self.assertEqual((ROOT / "skills/babysit-prs" / name).resolve(), CORE / name)

    def test_both_exports_work_without_repository_or_sibling_skill(self):
        with tempfile.TemporaryDirectory(prefix="babysit-packages-") as scratch:
            for runtime, name in (("codex", "babysit-prs-codex"), ("claude", "babysit-prs")):
                target = Path(scratch) / (runtime + " standalone")
                subprocess.run(["python3", str(ROOT / "scripts/package-babysit.py"), runtime, str(target)], check=True)
                self.assertFalse(any(p.is_symlink() for p in target.rglob("*")))
                self.assertIn("name: " + name + "\n", (target / "SKILL.md").read_text())
                for resource in ("scripts", "schemas", "prompts", "references", "tests"):
                    for source in (CORE / resource).rglob("*"):
                        if source.is_file() and "__pycache__" not in source.parts:
                            self.assertEqual(source.read_bytes(), (target / source.relative_to(CORE)).read_bytes())
                contract = subprocess.run(["node", str(target / "scripts/validate-artifact.mjs"),
                                           "contract", "--task-type", "review"],
                                          cwd=scratch, text=True, capture_output=True, check=True)
                self.assertIn("resultCompleteness", contract.stdout)
                guard = subprocess.run(["node", str(target / "scripts/worktree-guard.mjs")],
                                       cwd=scratch, text=True, capture_output=True)
                self.assertEqual(guard.returncode, 2)
                self.assertIn("usage:", guard.stderr)
                # An export must never silently replace a previous package.
                retry = subprocess.run(["python3", str(ROOT / "scripts/package-babysit.py"), runtime, str(target)],
                                       capture_output=True)
                self.assertNotEqual(retry.returncode, 0)


if __name__ == "__main__":
    unittest.main()
