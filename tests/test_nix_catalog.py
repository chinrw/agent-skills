"""Check automatic skill discovery and native/shared routing without activation."""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(
    shutil.which("nix-instantiate"), "Nix is needed for catalog evaluation"
)
class CatalogTest(unittest.TestCase):
    def catalog(self, source):
        expression = (
            f"import {ROOT}/nix/catalog.nix {{ source = {json.dumps(str(source))}; }}"
        )
        result = subprocess.run(
            ["nix-instantiate", "--eval", "--strict", "--json", "--expr", expression],
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(result.stdout)

    def test_shared_and_native_entrypoints_keep_their_source_snapshot(self):
        catalog = self.catalog(ROOT)
        self.assertEqual(set(catalog["shared"]), {"context-bundle", "fable-writing"})
        self.assertEqual(
            set(catalog["claude-code"]), {"babysit-prs", "codex-implementation"}
        )
        self.assertEqual(set(catalog["codex"]), {"aster-debug", "babysit-prs-codex"})
        claude = Path(catalog["claude-code"]["babysit-prs"])
        codex = Path(catalog["codex"]["babysit-prs-codex"])
        self.assertEqual((claude / "scripts").resolve(), codex / "scripts")
        self.assertEqual(
            (ROOT / "codex-skills/context-bundle").resolve(),
            Path(catalog["shared"]["context-bundle"]),
        )

    def test_adding_a_skill_needs_no_catalog_edit(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            for group in ("skills", "codex-skills", "shared-skills"):
                (source / group).mkdir()
            skill = source / "shared-skills/new-report"
            skill.mkdir()
            (skill / "SKILL.md").write_text(
                "---\nname: new-report\ndescription: A new report skill.\n---\n"
            )
            (source / "codex-skills/new-report").symlink_to(
                "../shared-skills/new-report"
            )
            catalog = self.catalog(source)
            self.assertEqual(catalog["shared"], {"new-report": str(skill)})
            self.assertEqual(catalog["codex"], {})


if __name__ == "__main__":
    unittest.main()
