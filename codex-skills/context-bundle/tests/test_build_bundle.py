import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile


SPEC = importlib.util.spec_from_file_location(
    "build_bundle", Path(__file__).parents[1] / "scripts" / "build_bundle.py"
)
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


class BundleTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "staging"
        self.source.mkdir()
        (self.source / "HANDOFF.md").write_text(
            "# 交接\n\n继续检查 [数据](files/资料.bin)。\n", encoding="utf-8"
        )
        self.output = self.root / "handoff.zip"

    def test_portable_archive_contains_original_bytes_and_valid_manifest(self):
        (self.source / "files").mkdir()
        payload = bytes(range(256)) * 5000
        (self.source / "files" / "资料.bin").write_bytes(payload)
        os.utime(self.source / "files" / "资料.bin", (0, 0))
        result = BUILDER.build_bundle(self.source, self.output)
        self.assertEqual(result["files"], 2)
        self.assertEqual(result["size"], self.output.stat().st_size)
        with zipfile.ZipFile(self.output) as archive:
            self.assertIsNone(archive.testzip())
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["version"], 1)
            self.assertEqual(
                set(archive.namelist()), {"HANDOFF.md", "files/资料.bin", "manifest.json"}
            )
            for item in manifest["files"]:
                content = archive.read(item["path"])
                self.assertEqual(item["size"], len(content))
                self.assertEqual(item["sha256"], hashlib.sha256(content).hexdigest())
            archive.extractall(self.root / "extracted")
        self.assertEqual((self.root / "extracted/files/资料.bin").read_bytes(), payload)

    def test_existing_output_is_preserved(self):
        self.output.write_bytes(b"previous bundle")
        with self.assertRaisesRegex(ValueError, "already exists"):
            BUILDER.build_bundle(self.source, self.output)
        self.assertEqual(self.output.read_bytes(), b"previous bundle")

    def test_missing_or_empty_handoff_fails_without_output(self):
        for handoff in (None, " \n"):
            with self.subTest(handoff=handoff):
                path = self.source / "HANDOFF.md"
                if handoff is None:
                    path.unlink()
                else:
                    path.write_text(handoff)
                with self.assertRaisesRegex(ValueError, "HANDOFF.md"):
                    BUILDER.build_bundle(self.source, self.output)
                self.assertFalse(self.output.exists())

    def test_output_inside_staging_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "outside"):
            BUILDER.build_bundle(self.source, self.source / "handoff.zip")

    def test_symlinks_cannot_pull_in_unselected_material(self):
        private = self.root / "unselected"
        private.mkdir()
        (private / "secret.txt").write_text("fixture secret")
        for target in (private, private / "secret.txt", private / "missing"):
            with self.subTest(target=target):
                link = self.source / "link"
                link.symlink_to(target)
                with self.assertRaisesRegex(ValueError, "ordinary files"):
                    BUILDER.build_bundle(self.source, self.output)
                self.assertFalse(self.output.exists())
                link.unlink()

    def test_reserved_manifest_and_nonportable_paths_are_rejected(self):
        for name in ("Manifest.json", "files\\escape.txt", "newline\n.txt"):
            with self.subTest(name=name):
                path = self.source / name
                path.write_text("fixture")
                with self.assertRaises(ValueError):
                    BUILDER.build_bundle(self.source, self.output)
                self.assertFalse(self.output.exists())
                path.unlink()

    def test_changes_during_packaging_fail_without_publishing(self):
        original_write = zipfile.ZipFile.write

        def changed_write(archive, filename, *args, **kwargs):
            Path(filename).write_text("changed after hashing")
            return original_write(archive, filename, *args, **kwargs)

        with patch.object(zipfile.ZipFile, "write", changed_write):
            with self.assertRaisesRegex(ValueError, "Source changed"):
                BUILDER.build_bundle(self.source, self.output)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
