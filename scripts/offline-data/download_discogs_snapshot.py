#!/usr/bin/env python3

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen


CONFIRMATION = "I_CONFIRM_DISCOGS_FULL_DOWNLOAD"
DEFAULT_BASE_URL = "https://data.discogs.com/"
DEFAULT_MINIMUM_FREE_BYTES = 80_000_000_000
CHECKSUM_MAX_BYTES = 1_000_000
ARTIFACT_MAX_BYTES = {
    "artists": 2_000_000_000,
    "labels": 1_000_000_000,
    "masters": 2_000_000_000,
    "releases": 20_000_000_000,
}
CHUNK_BYTES = 1024 * 1024


def main() -> None:
    args = parse_arguments()
    if args.confirm_full_download != CONFIRMATION:
        raise ValueError(f"--confirm-full-download must equal {CONFIRMATION}")
    snapshot = validate_snapshot(args.snapshot)
    data_root = validate_data_root(Path(args.data_root))
    validate_base_url(args.base_url)
    available_bytes = shutil.disk_usage(data_root).free
    if available_bytes < args.minimum_free_bytes:
        raise ValueError(
            "Discogs full-download capacity gate failed: "
            f"{available_bytes} bytes available, {args.minimum_free_bytes} required"
        )

    snapshot_dir = prepare_snapshot_directory(data_root, snapshot)
    checksum_filename = f"discogs_{snapshot}_CHECKSUM.txt"
    checksum_url = artifact_url(args.base_url, snapshot, checksum_filename)
    checksum_path = snapshot_dir / checksum_filename
    checksum_result = download_bounded_file(
        checksum_url,
        checksum_path,
        CHECKSUM_MAX_BYTES,
        None,
        args.timeout_seconds,
    )
    expected_checksums = parse_checksum_file(checksum_path)

    file_evidence = {}
    for kind in ("artists", "labels", "masters", "releases"):
        filename = f"discogs_{snapshot}_{kind}.xml.gz"
        expected_sha256 = expected_checksums.get(filename)
        if expected_sha256 is None:
            raise ValueError(f"Checksum manifest does not contain {filename}")
        url = artifact_url(args.base_url, snapshot, filename)
        result = download_bounded_file(
            url,
            snapshot_dir / filename,
            ARTIFACT_MAX_BYTES[kind],
            expected_sha256,
            args.timeout_seconds,
        )
        file_evidence[kind] = {
            "filename": filename,
            "bytes": result["bytes"],
            "sha256": result["sha256"],
            "source_url": url,
            "resumed_from": result["resumed_from"],
            "reused": result["reused"],
        }
        print(f"verified {kind}: {filename}", file=sys.stderr)

    manifest = {
        "manifest_version": "1.0",
        "source": "discogs",
        "snapshot": snapshot,
        "generated_at": datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "license_partition": "discogs-cc0",
        "verification_status": "verified",
        "network_source": args.base_url,
        "capacity_gate": {
            "available_bytes_before_download": available_bytes,
            "minimum_free_bytes": args.minimum_free_bytes,
            "status": "passed",
        },
        "checksum": {
            "filename": checksum_filename,
            "bytes": checksum_result["bytes"],
            "sha256": checksum_result["sha256"],
            "source_url": checksum_url,
        },
        "files": file_evidence,
    }
    manifest_path = snapshot_dir / "discogs-download-manifest.json"
    write_json_atomically(manifest_path, manifest)
    print(json.dumps(manifest, ensure_ascii=True, indent=2, sort_keys=True))


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download and SHA-256 verify one official Discogs monthly snapshot."
    )
    parser.add_argument("--snapshot", required=True, help="Snapshot date in YYYYMMDD form")
    parser.add_argument("--data-root", required=True, help="Existing absolute data directory")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument(
        "--minimum-free-bytes", type=positive_integer, default=DEFAULT_MINIMUM_FREE_BYTES
    )
    parser.add_argument("--timeout-seconds", type=positive_integer, default=60)
    parser.add_argument("--confirm-full-download", required=True)
    return parser.parse_args()


def validate_snapshot(value: str) -> str:
    if not re.fullmatch(r"20[0-9]{6}", value):
        raise ValueError("--snapshot must use YYYYMMDD")
    try:
        datetime.strptime(value, "%Y%m%d")
    except ValueError as error:
        raise ValueError("--snapshot is not a valid calendar date") from error
    return value


def validate_data_root(requested: Path) -> Path:
    if not requested.is_absolute():
        raise ValueError("--data-root must be absolute")
    if requested.is_symlink():
        raise ValueError("--data-root must be an existing non-symlink directory")
    resolved = requested.resolve(strict=True)
    if not resolved.is_dir():
        raise ValueError("--data-root must be an existing non-symlink directory")
    return resolved


def validate_base_url(value: str) -> None:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("--base-url must be an HTTP(S) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("--base-url must not contain credentials, query, or fragment")


def prepare_snapshot_directory(data_root: Path, snapshot: str) -> Path:
    discogs_root = data_root / "discogs"
    ensure_directory(discogs_root)
    snapshot_dir = discogs_root / snapshot
    ensure_directory(snapshot_dir)
    return snapshot_dir


def ensure_directory(path: Path) -> None:
    if path.is_symlink():
        raise ValueError(f"{path} must not be a symbolic link")
    path.mkdir(mode=0o700, exist_ok=True)
    if not path.is_dir():
        raise ValueError(f"{path} must be a directory")


def artifact_url(base_url: str, snapshot: str, filename: str) -> str:
    parsed = urlsplit(base_url)
    prefix = f"data/{snapshot[:4]}/"
    query = urlencode({"prefix": prefix, "download": prefix + filename})
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/", query, ""))


def download_bounded_file(
    url: str,
    destination: Path,
    max_bytes: int,
    expected_sha256: str | None,
    timeout_seconds: int,
) -> dict:
    completed = inspect_regular_file(destination)
    if completed is not None:
        if completed < 1 or completed > max_bytes:
            raise ValueError(f"Completed {destination.name} violates its byte budget")
        actual_sha256 = sha256_file(destination)
        if expected_sha256 is not None and actual_sha256 != expected_sha256:
            raise ValueError(f"Existing {destination.name} SHA-256 mismatch")
        return {
            "bytes": completed,
            "sha256": actual_sha256,
            "resumed_from": completed,
            "reused": True,
        }

    partial_path = destination.with_name(destination.name + ".part")
    resumed_from = inspect_regular_file(partial_path) or 0
    if resumed_from > max_bytes:
        raise ValueError(f"Partial {destination.name} exceeds its byte budget")
    headers = {"User-Agent": "rock-catalog-assessment/1.0"}
    if resumed_from > 0:
        headers["Range"] = f"bytes={resumed_from}-"
    request = Request(url, headers=headers, method="GET")
    try:
        response = urlopen(request, timeout=timeout_seconds)
    except HTTPError as error:
        raise ValueError(f"{url} returned HTTP {error.code}") from error
    except URLError as error:
        raise ValueError(f"Failed to download {url}: {error.reason}") from error

    with response:
        status = response.getcode()
        if resumed_from > 0:
            if status != 206:
                raise ValueError(
                    f"Server ignored Range request for {destination.name} at {resumed_from}"
                )
            validate_content_range(
                response.headers.get("Content-Range"), resumed_from, max_bytes
            )
        elif status != 200:
            raise ValueError(f"Fresh download expected HTTP 200, received {status}")
        declared_length = parse_content_length(response.headers.get("Content-Length"))
        if declared_length is not None and resumed_from + declared_length > max_bytes:
            raise ValueError(f"Response for {destination.name} exceeds its byte budget")

        total_bytes = resumed_from
        with open_partial_file(partial_path, resumed_from) as target:
            while True:
                chunk = response.read(CHUNK_BYTES)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if total_bytes > max_bytes:
                    raise ValueError(f"Download of {destination.name} exceeded its byte budget")
                target.write(chunk)
            target.flush()
            os.fsync(target.fileno())

    if declared_length is not None and total_bytes != resumed_from + declared_length:
        raise ValueError(f"Download of {destination.name} stopped before Content-Length")
    if total_bytes < 1:
        raise ValueError(f"Download of {destination.name} produced zero bytes")
    actual_sha256 = sha256_file(partial_path)
    if expected_sha256 is not None and actual_sha256 != expected_sha256:
        quarantine = partial_path.with_name(partial_path.name + ".sha256-mismatch")
        if quarantine.exists() or quarantine.is_symlink():
            raise ValueError(
                f"Downloaded {destination.name} SHA-256 mismatch; quarantine already exists"
            )
        os.rename(partial_path, quarantine)
        raise ValueError(f"Downloaded {destination.name} SHA-256 mismatch")
    os.rename(partial_path, destination)
    return {
        "bytes": total_bytes,
        "sha256": actual_sha256,
        "resumed_from": resumed_from,
        "reused": False,
    }


def validate_content_range(value: str | None, start: int, max_bytes: int) -> None:
    match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", value or "")
    if match is None:
        raise ValueError("Resumed download requires a complete Content-Range")
    actual_start, end, total = (int(part) for part in match.groups())
    if actual_start != start or end < actual_start or end != total - 1 or total > max_bytes:
        raise ValueError(f"Unexpected Content-Range: {value}")


def parse_content_length(value: str | None) -> int | None:
    if value is None:
        return None
    if not re.fullmatch(r"[0-9]+", value):
        raise ValueError("Invalid Content-Length")
    return int(value)


def inspect_regular_file(path: Path) -> int | None:
    try:
        state = path.lstat()
    except FileNotFoundError:
        return None
    if state.st_mode & 0o170000 == 0o120000:
        raise ValueError(f"{path} must not be a symbolic link")
    if not path.is_file():
        raise ValueError(f"{path} must be a regular file")
    return state.st_size


def open_partial_file(path: Path, resumed_from: int):
    flags = os.O_WRONLY | os.O_CREAT
    flags |= os.O_APPEND if resumed_from > 0 else os.O_TRUNC
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, 0o600)
    state = os.fstat(descriptor)
    if state.st_size != resumed_from:
        os.close(descriptor)
        raise ValueError(f"{path} changed before download")
    return os.fdopen(descriptor, "ab" if resumed_from > 0 else "wb")


def parse_checksum_file(path: Path) -> dict[str, str]:
    entries = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([0-9a-fA-F]{64})\s+\*?([^/\\]+)", line.strip())
        if match:
            entries[match.group(2)] = match.group(1).lower()
    if not entries:
        raise ValueError("Discogs checksum manifest contains no SHA-256 entries")
    return entries


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


def write_json_atomically(path: Path, value: dict) -> None:
    if path.is_symlink():
        raise ValueError(f"{path} must not be a symbolic link")
    payload = json.dumps(value, ensure_ascii=True, indent=2, sort_keys=True) + "\n"
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as target:
            target.write(payload)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def positive_integer(value: str) -> int:
    if not re.fullmatch(r"[1-9][0-9]*", value):
        raise argparse.ArgumentTypeError("must be a positive integer")
    return int(value)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
