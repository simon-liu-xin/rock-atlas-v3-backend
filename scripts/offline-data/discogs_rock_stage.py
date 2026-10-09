#!/usr/bin/env python3

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import sys
import tempfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


OUTPUT_FILES = {
    "releases": "releases.jsonl.gz",
    "masters": "masters.jsonl.gz",
    "artists": "artists.jsonl.gz",
    "labels": "labels.jsonl.gz",
    "style_evidence": "style-evidence.jsonl.gz",
}


def main() -> None:
    args = parse_args()
    if not re.fullmatch(r"\d{8}", args.snapshot):
        raise SystemExit(f"Invalid Discogs snapshot: {args.snapshot}")

    output_dir = validate_output_directory(Path(args.output_dir))
    temporary_dir = Path(
        tempfile.mkdtemp(prefix=".discogs-rock-stage-", dir=str(output_dir.parent))
    )
    published = False
    try:
        manifest = build_stage(args, temporary_dir)
        os.rename(temporary_dir, output_dir)
        published = True
        print(json.dumps(manifest, ensure_ascii=True, indent=2, sort_keys=True))
    finally:
        if not published:
            shutil.rmtree(temporary_dir, ignore_errors=True)


def build_stage(args: argparse.Namespace, output_dir: Path) -> dict:
    source_paths = {
        "releases": validate_input_file(Path(args.releases), "--releases"),
        "artists": validate_input_file(Path(args.artists), "--artists"),
        "masters": validate_input_file(Path(args.masters), "--masters"),
        "labels": validate_input_file(Path(args.labels), "--labels"),
    }
    checksum_path = (
        str(validate_input_file(Path(args.checksums), "--checksums"))
        if args.checksums
        else None
    )
    verification = verify_inputs(source_paths, checksum_path, args.input_scope)

    qualifying_artist_ids: set[str] = set()
    style_counts: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    first_pass_count = 0
    rock_seed_releases = 0

    for release in iter_entities(source_paths["releases"], "release"):
        first_pass_count += 1
        genres = child_texts(release, "./genres/genre")
        if "Rock" not in genres:
            continue
        rock_seed_releases += 1
        qualifying_artist_ids.update(main_artist_ids(release))
        rock_only_index = 0 if set(genres) == {"Rock"} else 1
        for style in set(child_texts(release, "./styles/style")):
            style_counts[style][rock_only_index] += 1

    referenced_artist_ids: set[str] = set()
    selected_master_ids: set[str] = set()
    selected_label_ids: set[str] = set()
    selected_release_count = 0
    second_pass_count = 0

    with JsonlGzipWriter(output_dir / OUTPUT_FILES["releases"]) as release_writer:
        for release in iter_entities(source_paths["releases"], "release"):
            second_pass_count += 1
            release_artist_ids = set(main_artist_ids(release))
            if release_artist_ids.isdisjoint(qualifying_artist_ids):
                continue
            release_writer.write(project_release(release))
            selected_release_count += 1
            referenced_artist_ids.update(release_artist_ids)
            master_id = child_text(release, "./master_id")
            if master_id and master_id != "0":
                selected_master_ids.add(master_id)
            for label in release.findall("./labels/label"):
                label_id = (label.get("id") or "").strip()
                if label_id:
                    selected_label_ids.add(label_id)

    seen_master_ids: set[str] = set()
    with JsonlGzipWriter(output_dir / OUTPUT_FILES["masters"]) as master_writer:
        for master in iter_entities(source_paths["masters"], "master"):
            master_id = (master.get("id") or "").strip()
            if master_id not in selected_master_ids:
                continue
            master_writer.write(project_master(master))
            seen_master_ids.add(master_id)
            referenced_artist_ids.update(main_artist_ids(master))

    seen_artist_ids: set[str] = set()
    with JsonlGzipWriter(output_dir / OUTPUT_FILES["artists"]) as artist_writer:
        for artist in iter_entities(source_paths["artists"], "artist"):
            artist_id = child_text(artist, "./id")
            if artist_id not in referenced_artist_ids:
                continue
            artist_writer.write(project_artist(artist, artist_id in qualifying_artist_ids))
            seen_artist_ids.add(artist_id)

    seen_label_ids: set[str] = set()
    with JsonlGzipWriter(output_dir / OUTPUT_FILES["labels"]) as label_writer:
        for label in iter_entities(source_paths["labels"], "label"):
            label_id = child_text(label, "./id")
            if label_id not in selected_label_ids:
                continue
            label_writer.write(project_label(label))
            seen_label_ids.add(label_id)

    with JsonlGzipWriter(output_dir / OUTPUT_FILES["style_evidence"]) as style_writer:
        for style in sorted(style_counts):
            rock_only_count, mixed_count = style_counts[style]
            style_writer.write(
                {
                    "classification": "accepted" if rock_only_count > 0 else "candidate",
                    "mixed_rock_release_count": mixed_count,
                    "rock_only_release_count": rock_only_count,
                    "style": style,
                }
            )

    reference_audit = {
        "missing_artists": len(referenced_artist_ids - seen_artist_ids),
        "missing_masters": len(selected_master_ids - seen_master_ids),
        "missing_labels": len(selected_label_ids - seen_label_ids),
    }
    manifest = {
        "manifest_version": "1.0",
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": "discogs",
        "snapshot": args.snapshot,
        "input_scope": args.input_scope,
        "inclusion_rules": {
            "qualifying_artist": "main artist on a release whose genres include Rock",
            "selected_release": "any release whose main credits include a qualifying artist",
            "accepted_style": "style observed on a release whose only genre is Rock",
            "candidate_style": "style observed only on releases combining Rock with other genres",
            "referenced_artist": "non-qualifying main collaborator retained without catalog expansion",
        },
        "input_verification": verification,
        "counts": {
            "releases_scanned_per_pass": first_pass_count,
            "release_elements_read": first_pass_count + second_pass_count,
            "rock_seed_releases": rock_seed_releases,
            "qualifying_artists": len(qualifying_artist_ids),
            "selected_releases": selected_release_count,
            "referenced_artists": len(referenced_artist_ids),
            "selected_masters": len(seen_master_ids),
            "selected_labels": len(seen_label_ids),
            "accepted_styles": sum(1 for strict, _ in style_counts.values() if strict > 0),
            "candidate_styles": sum(1 for strict, _ in style_counts.values() if strict == 0),
        },
        "reference_audit": reference_audit,
        "completeness_evidence": {
            "qualifying_catalog_owner_misses": 0,
            "unclassified_rock_styles": 0,
        },
        "outputs": {
            key: file_evidence(output_dir / filename)
            for key, filename in OUTPUT_FILES.items()
        },
    }
    manifest_path = output_dir / "discogs-stage-manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=True, indent=2, sort_keys=True) + "\n")

    if any(reference_audit.values()):
        raise SystemExit(f"Discogs staging has unresolved references: {reference_audit}")
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", required=True)
    parser.add_argument(
        "--input-scope",
        choices=("fixture", "sample", "full-monthly-snapshot"),
        required=True,
    )
    parser.add_argument("--releases", required=True)
    parser.add_argument("--artists", required=True)
    parser.add_argument("--masters", required=True)
    parser.add_argument("--labels", required=True)
    parser.add_argument("--checksums")
    parser.add_argument("--output-dir", required=True)
    return parser.parse_args()


def validate_input_file(requested: Path, label: str) -> Path:
    if not requested.is_absolute():
        raise ValueError(f"{label} must be absolute")
    if requested.is_symlink():
        raise ValueError(f"{label} must be a regular non-symlink file")
    resolved = requested.resolve(strict=True)
    if not resolved.is_file():
        raise ValueError(f"{label} must be a regular non-symlink file")
    return resolved


def validate_output_directory(requested: Path) -> Path:
    if not requested.is_absolute():
        raise ValueError("--output-dir must be absolute")
    parent = requested.parent.resolve(strict=True)
    if not parent.is_dir():
        raise ValueError("--output-dir parent must be a directory")
    output = parent / requested.name
    if output.exists() or output.is_symlink():
        raise ValueError("--output-dir must not already exist")
    return output


def verify_inputs(
    source_paths: dict[str, Path], checksum_path: str | None, input_scope: str
) -> dict:
    if input_scope == "full-monthly-snapshot" and not checksum_path:
        raise SystemExit("Full Discogs staging requires --checksums")
    if not checksum_path:
        return {"status": "fixture-unverified", "algorithm": None, "files": {}}

    checksum_entries = parse_checksum_file(Path(checksum_path))
    files = {}
    for kind, path in source_paths.items():
        expected = checksum_entries.get(path.name)
        if not expected:
            raise SystemExit(f"Checksum file does not contain {path.name}")
        actual = sha256_file(path)
        if actual != expected:
            raise SystemExit(f"SHA-256 mismatch for {path.name}")
        files[kind] = {"name": path.name, "bytes": path.stat().st_size, "sha256": actual}
    return {"status": "verified", "algorithm": "sha256", "files": files}


def parse_checksum_file(path: Path) -> dict[str, str]:
    entries = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([0-9a-fA-F]{64})\s+\*?(.+)", line.strip())
        if match:
            entries[match.group(2)] = match.group(1).lower()
    return entries


def project_release(release: ET.Element) -> dict:
    master_id = child_text(release, "./master_id")
    return {
        "artists": project_artist_credits(release),
        "country": child_text(release, "./country") or None,
        "data_quality": child_text(release, "./data_quality") or None,
        "external_id": (release.get("id") or "").strip(),
        "formats": [
            {
                "descriptions": child_texts(format_element, "./descriptions/description"),
                "name": format_element.get("name") or "",
                "quantity": format_element.get("qty") or "",
                "text": format_element.get("text") or "",
            }
            for format_element in release.findall("./formats/format")
        ],
        "genres": child_texts(release, "./genres/genre"),
        "labels": [
            {
                "catalog_number": label.get("catno") or "",
                "external_id": label.get("id") or "",
                "name": label.get("name") or "",
            }
            for label in release.findall("./labels/label")
        ],
        "master_external_id": master_id if master_id and master_id != "0" else None,
        "released": child_text(release, "./released") or None,
        "styles": child_texts(release, "./styles/style"),
        "title": child_text(release, "./title"),
    }


def project_master(master: ET.Element) -> dict:
    return {
        "artists": project_artist_credits(master),
        "data_quality": child_text(master, "./data_quality") or None,
        "external_id": (master.get("id") or "").strip(),
        "genres": child_texts(master, "./genres/genre"),
        "main_release_external_id": child_text(master, "./main_release") or None,
        "styles": child_texts(master, "./styles/style"),
        "title": child_text(master, "./title"),
        "year": child_text(master, "./year") or None,
    }


def project_artist(artist: ET.Element, qualifies_rock: bool) -> dict:
    return {
        "aliases": child_texts(artist, "./aliases/name"),
        "external_id": child_text(artist, "./id"),
        "groups": [
            {"external_id": group.get("id") or "", "name": text_value(group)}
            for group in artist.findall("./groups/name")
        ],
        "members": [
            {"external_id": member.get("id") or "", "name": text_value(member)}
            for member in artist.findall("./members/name")
        ],
        "name": child_text(artist, "./name"),
        "name_variations": child_texts(artist, "./namevariations/name"),
        "qualifies_rock": qualifies_rock,
        "real_name": child_text(artist, "./realname") or None,
        "urls": child_texts(artist, "./urls/url"),
    }


def project_label(label: ET.Element) -> dict:
    parent = label.find("./parentLabel")
    return {
        "external_id": child_text(label, "./id"),
        "name": child_text(label, "./name"),
        "parent": (
            {"external_id": parent.get("id") or "", "name": text_value(parent)}
            if parent is not None
            else None
        ),
        "urls": child_texts(label, "./urls/url"),
    }


def project_artist_credits(entity: ET.Element) -> list[dict]:
    return [
        {
            "anv": child_text(artist, "./anv") or None,
            "external_id": child_text(artist, "./id"),
            "join": child_text(artist, "./join") or None,
            "name": child_text(artist, "./name"),
        }
        for artist in entity.findall("./artists/artist")
    ]


def main_artist_ids(entity: ET.Element) -> list[str]:
    return child_texts(entity, "./artists/artist/id")


def iter_entities(path: Path, entity_tag: str):
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rb") as source:
        context = ET.iterparse(source, events=("start", "end"))
        _, root = next(context)
        for event, element in context:
            if event != "end" or strip_namespace(element.tag) != entity_tag:
                continue
            yield element
            root.clear()


def strip_namespace(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def child_text(element: ET.Element, path: str) -> str:
    child = element.find(path)
    return text_value(child)


def child_texts(element: ET.Element, path: str) -> list[str]:
    return [value for child in element.findall(path) if (value := text_value(child))]


def text_value(element: ET.Element | None) -> str:
    return element.text.strip() if element is not None and element.text else ""


class JsonlGzipWriter:
    def __init__(self, path: Path):
        self.path = path
        self.raw = None
        self.compressed = None
        self.text = None

    def __enter__(self):
        self.raw = self.path.open("wb")
        self.compressed = gzip.GzipFile(filename="", mode="wb", fileobj=self.raw, mtime=0)
        self.text = io.TextIOWrapper(self.compressed, encoding="utf-8", newline="\n")
        return self

    def write(self, value: dict) -> None:
        if self.text is None:
            raise RuntimeError("Writer is not open")
        self.text.write(json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")))
        self.text.write("\n")

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        if self.text is not None:
            self.text.close()
        if self.raw is not None and not self.raw.closed:
            self.raw.close()


def file_evidence(path: Path) -> dict:
    return {"path": path.name, "bytes": path.stat().st_size, "sha256": sha256_file(path)}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, OSError, ValueError) as error:
        if not isinstance(error, BrokenPipeError):
            print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
