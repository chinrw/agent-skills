#!/usr/bin/env python3
"""Package reviewed staging files and verify the archived bytes."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import unicodedata
import zipfile


def collect_files(source):
    files = []
    names = set()

    def walk_error(error):
        raise error

    for root, directories, filenames in os.walk(source, onerror=walk_error):
        for name in directories + filenames:
            path = Path(root) / name
            relative = path.relative_to(source).as_posix()
            mode = path.lstat().st_mode
            if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                raise ValueError(f"Only ordinary files and directories are allowed: {relative}")
            if "\\" in relative or any(ord(char) < 32 for char in relative):
                raise ValueError(f"Unsupported archive path: {relative!r}")
            key = unicodedata.normalize("NFC", relative).casefold()
            if key == "manifest.json" or key in names:
                raise ValueError(f"Reserved or colliding archive path: {relative}")
            names.add(key)
            if stat.S_ISREG(mode):
                files.append((relative, path))

    if not any(name == "HANDOFF.md" for name, _ in files):
        raise ValueError("Staging must contain HANDOFF.md at its root")
    if not (source / "HANDOFF.md").read_text(encoding="utf-8").strip():
        raise ValueError("HANDOFF.md must contain the handoff instructions")
    return sorted(files)


def digest_stream(stream):
    digest = hashlib.sha256()
    size = 0
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        size += len(chunk)
        digest.update(chunk)
    return size, digest.hexdigest()


def build_bundle(source, output):
    source = Path(source).expanduser()
    output = Path(output).expanduser().absolute()
    if source.is_symlink() or not source.is_dir():
        raise ValueError("Source must be an ordinary staging directory")
    source = source.resolve()
    if output.exists() or output.is_symlink():
        raise ValueError("Output already exists; choose a fresh ZIP path")
    if output.resolve().is_relative_to(source):
        raise ValueError("Output must be outside the staging directory")
    if output.suffix.lower() != ".zip":
        raise ValueError("Output must have a .zip extension")
    files = collect_files(source)
    records = []

    # Publish only a verified archive; a failed build leaves no partial output.
    with tempfile.TemporaryDirectory(prefix="context-bundle-", dir=output.parent) as work:
        archive = Path(work) / "bundle.zip"
        # Nix source copies can retain epoch mtimes, before ZIP's 1980 minimum.
        with zipfile.ZipFile(
            archive, "w", compression=zipfile.ZIP_DEFLATED, strict_timestamps=False
        ) as bundle:
            for name, path in files:
                with path.open("rb") as content:
                    size, digest = digest_stream(content)
                records.append({"path": name, "size": size, "sha256": digest})
                bundle.write(path, name)
            manifest = {"version": 1, "files": records}
            bundle.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

        with zipfile.ZipFile(archive) as bundle:
            if set(bundle.namelist()) != {item["path"] for item in records} | {"manifest.json"}:
                raise ValueError("Archive membership verification failed")
            if json.loads(bundle.read("manifest.json")) != manifest:
                raise ValueError("Manifest verification failed")
            for item in records:
                with bundle.open(item["path"]) as content:
                    actual = digest_stream(content)
                if actual != (item["size"], item["sha256"]):
                    raise ValueError(f"Source changed or archived bytes differ: {item['path']}")
        os.chmod(archive, 0o600)
        os.link(archive, output)

    return {"output": str(output), "size": output.stat().st_size, "files": len(records)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="Reviewed staging directory with HANDOFF.md")
    parser.add_argument("--output", required=True, type=Path, help="New ZIP path outside staging; parent must exist")
    args = parser.parse_args()
    try:
        result = build_bundle(args.source, args.output)
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        parser.exit(1, f"context-bundle: {error}\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
