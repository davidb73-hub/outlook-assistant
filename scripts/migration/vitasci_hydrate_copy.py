#!/usr/bin/env python3
"""Copy a FileProvider tree file-by-file with retry and byte-count verification."""

from __future__ import annotations

import argparse
import errno
import json
import os
import shutil
import sys
import time
from pathlib import Path


RETRY_ERRNOS = {errno.EAGAIN, errno.EDEADLK}


def retryable(exc: OSError) -> bool:
    return exc.errno in RETRY_ERRNOS


def copy_file(source: Path, destination: Path, attempts: int) -> int:
    last_error: OSError | None = None
    for attempt in range(1, attempts + 1):
        try:
            before = source.stat()
            destination.parent.mkdir(parents=True, exist_ok=True)
            copied = 0
            with source.open("rb", buffering=0) as source_handle:
                with destination.open("wb", buffering=0) as destination_handle:
                    while True:
                        chunk = source_handle.read(1024 * 1024)
                        if not chunk:
                            break
                        destination_handle.write(chunk)
                        copied += len(chunk)
                    destination_handle.flush()
                    os.fsync(destination_handle.fileno())
            after = source.stat()
            destination_size = destination.stat().st_size
            if before.st_size != after.st_size:
                raise OSError(errno.EAGAIN, "source size changed during copy")
            if copied != before.st_size or destination_size != before.st_size:
                raise OSError(
                    errno.EIO,
                    f"byte verification failed: source={before.st_size} "
                    f"read={copied} destination={destination_size}",
                )
            shutil.copystat(source, destination, follow_symlinks=False)
            return copied
        except OSError as exc:
            last_error = exc
            if not retryable(exc) or attempt == attempts:
                break
            delay = min(0.25 * (2 ** (attempt - 1)), 10.0)
            print(
                f"RETRY {attempt}/{attempts} errno={exc.errno} "
                f"delay={delay:.2f}s path={source}",
                flush=True,
            )
            time.sleep(delay)
    assert last_error is not None
    raise last_error


def copy_tree(source: Path, destination: Path, attempts: int) -> dict[str, object]:
    failures: list[dict[str, object]] = []
    copied_files = 0
    copied_bytes = 0
    copied_symlinks = 0
    directories: list[tuple[Path, Path]] = []

    destination.mkdir(parents=True, exist_ok=True)
    for root_text, dir_names, file_names in os.walk(source, followlinks=False):
        root = Path(root_text)
        relative_root = root.relative_to(source)
        destination_root = destination / relative_root
        destination_root.mkdir(parents=True, exist_ok=True)
        directories.append((root, destination_root))

        real_dir_names: list[str] = []
        for name in dir_names:
            source_path = root / name
            destination_path = destination_root / name
            if source_path.is_symlink():
                try:
                    if not destination_path.exists() and not destination_path.is_symlink():
                        destination_path.symlink_to(os.readlink(source_path))
                    copied_symlinks += 1
                except OSError as exc:
                    failures.append(
                        {"path": str(source_path), "errno": exc.errno, "error": str(exc)}
                    )
            else:
                destination_path.mkdir(parents=True, exist_ok=True)
                real_dir_names.append(name)
        dir_names[:] = real_dir_names

        for name in file_names:
            source_path = root / name
            destination_path = destination_root / name
            if source_path.is_symlink():
                try:
                    if not destination_path.exists() and not destination_path.is_symlink():
                        destination_path.symlink_to(os.readlink(source_path))
                    copied_symlinks += 1
                except OSError as exc:
                    failures.append(
                        {"path": str(source_path), "errno": exc.errno, "error": str(exc)}
                    )
                continue
            try:
                copied_bytes += copy_file(source_path, destination_path, attempts)
                copied_files += 1
                if copied_files % 250 == 0:
                    print(f"PROGRESS files={copied_files} bytes={copied_bytes}", flush=True)
            except OSError as exc:
                failures.append(
                    {"path": str(source_path), "errno": exc.errno, "error": str(exc)}
                )

    for source_dir, destination_dir in reversed(directories):
        try:
            shutil.copystat(source_dir, destination_dir, follow_symlinks=False)
        except OSError as exc:
            failures.append(
                {"path": str(source_dir), "errno": exc.errno, "error": str(exc)}
            )

    return {
        "source": str(source),
        "destination": str(destination),
        "copied_files": copied_files,
        "copied_bytes": copied_bytes,
        "copied_symlinks": copied_symlinks,
        "failures": failures,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--attempts", type=int, default=20)
    args = parser.parse_args()

    source = args.source.expanduser().resolve()
    destination = args.destination.expanduser().resolve()
    if not source.is_dir():
        parser.error(f"source is not a directory: {source}")
    if destination == source or source in destination.parents:
        parser.error("destination must be outside the source tree")
    if args.attempts < 1:
        parser.error("--attempts must be positive")

    summary = copy_tree(source, destination, args.attempts)
    print("SUMMARY " + json.dumps(summary, sort_keys=True), flush=True)
    return 1 if summary["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
