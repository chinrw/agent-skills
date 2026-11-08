"""Exercise activation ownership, backups and dry-run behavior in temporary homes."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

INSTALLER = Path(__file__).resolve().parents[1] / "nix/install-skills.sh"


class SkillInstallTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.home = self.root / "home with spaces"
        self.home.mkdir()
        self.state = self.home / ".local/state/agent-skills"
        self.target = self.home / ".agents/skills/example"
        self.first = self.root / "version-1"
        self.second = self.root / "version-2"
        for source in (self.first, self.second):
            source.mkdir()
            (source / "SKILL.md").write_text(source.name)

    def activate(self, entries=(), dry=False):
        environment = os.environ.copy()
        environment.pop("DRY_RUN", None)
        if dry:
            environment["DRY_RUN"] = ""
        script = 'source "$1"; shift; run() { if [[ ! -v DRY_RUN ]]; then "$@"; fi; }; install_agent_skills "$@"'
        arguments = [str(value) for pair in entries for value in pair]
        return subprocess.run(
            [
                "bash",
                "-c",
                script,
                "fixture",
                str(INSTALLER),
                str(self.home),
                str(self.state),
                *arguments,
            ],
            env=environment,
            capture_output=True,
            text=True,
            check=True,
        )

    def test_existing_directory_is_backed_up_and_upgrade_is_idempotent(self):
        self.target.mkdir(parents=True)
        original = self.target / "personal-note.md"
        original.write_bytes(b"keep these exact bytes")
        self.activate([(self.target, self.first)])
        backups = list((self.state / "backups").glob("activation.*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(
            next(backups[0].rglob("personal-note.md")).read_bytes(),
            b"keep these exact bytes",
        )
        self.assertEqual(self.target.resolve(), self.first)
        self.activate([(self.target, self.second)])
        self.activate([(self.target, self.second)])
        self.assertEqual(self.target.resolve(), self.second)
        self.assertEqual(len(list((self.state / "backups").glob("activation.*"))), 1)

    def test_foreign_symlink_is_preserved_before_adoption(self):
        self.target.parent.mkdir(parents=True)
        self.target.symlink_to(self.first)
        self.activate([(self.target, self.second)])
        saved = next((self.state / "backups").rglob("example"))
        self.assertTrue(saved.is_symlink())
        self.assertEqual(saved.resolve(), self.first)
        self.assertEqual(self.target.resolve(), self.second)

    def test_dry_run_has_no_writes_and_disable_removes_only_owned_links(self):
        self.target.mkdir(parents=True)
        (self.target / "note").write_text("keep")
        self.activate([(self.target, self.first)], dry=True)
        self.assertFalse(self.state.exists())
        self.assertFalse(self.target.is_symlink())
        self.assertEqual((self.target / "note").read_text(), "keep")
        self.activate([(self.target, self.first)])
        self.activate((), dry=True)
        self.assertTrue(self.target.is_symlink())
        self.activate(())
        self.assertFalse(self.target.is_symlink())

    def test_user_replacement_survives_exclusion(self):
        self.activate([(self.target, self.first)])
        self.target.unlink()
        self.target.mkdir()
        (self.target / "note").write_text("user replacement")
        self.activate(())
        self.assertEqual((self.target / "note").read_text(), "user replacement")

    def test_unused_disabled_module_creates_no_state(self):
        self.activate(())
        self.assertFalse(self.state.exists())


if __name__ == "__main__":
    unittest.main()
