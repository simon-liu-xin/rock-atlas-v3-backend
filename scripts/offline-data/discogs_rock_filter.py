#!/usr/bin/env python3

import argparse
import gzip
import json
import xml.etree.ElementTree as ET
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--releases", required=True)
    parser.add_argument("--artists", required=True)
    parser.add_argument("--masters")
    parser.add_argument("--labels")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    qualifying_artist_ids: set[str] = set()
    rock_styles: set[str] = set()
    rock_seed_releases = 0
    releases_scanned = 0

    for release in iter_entities(args.releases, "release"):
        releases_scanned += 1
        genres = child_texts(release, "./genres/genre")
        if "Rock" not in genres:
            continue
        rock_seed_releases += 1
        qualifying_artist_ids.update(child_texts(release, "./artists/artist/id"))
        rock_styles.update(child_texts(release, "./styles/style"))

    selected_release_ids: set[str] = set()
    selected_master_ids: set[str] = set()
    selected_label_ids: set[str] = set()
    complete_artist_releases = 0
    second_pass_scanned = 0
    for release in iter_entities(args.releases, "release"):
        second_pass_scanned += 1
        release_artist_ids = set(child_texts(release, "./artists/artist/id"))
        if release_artist_ids.isdisjoint(qualifying_artist_ids):
            continue
        complete_artist_releases += 1
        release_id = release.get("id")
        if release_id:
            selected_release_ids.add(release_id)
        selected_master_ids.update(
            master_id for master_id in child_texts(release, "./master_id") if master_id != "0"
        )
        selected_label_ids.update(
            label_id
            for label in release.findall("./labels/label")
            if (label_id := (label.get("id") or "").strip())
        )

    selected_artists = []
    for artist in iter_entities(args.artists, "artist"):
        artist_id = child_text(artist, "./id")
        if artist_id not in qualifying_artist_ids:
            continue
        selected_artists.append({"id": artist_id, "name": child_text(artist, "./name")})

    selected_master_records = 0
    seen_master_ids: set[str] = set()
    if args.masters:
        for master in iter_entities(args.masters, "master"):
            if master.get("id") in selected_master_ids:
                selected_master_records += 1
                seen_master_ids.add(master.get("id"))

    seen_label_ids: set[str] = set()
    if args.labels:
        for label in iter_entities(args.labels, "label"):
            label_id = child_text(label, "./id")
            if label_id in selected_label_ids:
                seen_label_ids.add(label_id)

    selected_artist_ids = {artist["id"] for artist in selected_artists}
    reference_audit = {
        "missing_artists": len(qualifying_artist_ids - selected_artist_ids),
        "missing_masters": len(selected_master_ids - seen_master_ids),
        "missing_labels": len(selected_label_ids - seen_label_ids),
    }

    result = {
        "qualifying_artist_ids": sorted(qualifying_artist_ids, key=id_sort_key),
        "rock_styles": sorted(rock_styles),
        "selected_release_ids": sorted(selected_release_ids, key=id_sort_key),
        "selected_master_ids": sorted(selected_master_ids, key=id_sort_key),
        "selected_label_ids": sorted(selected_label_ids, key=id_sort_key),
        "selected_artists": sorted(selected_artists, key=lambda artist: id_sort_key(artist["id"])),
        "reference_audit": reference_audit,
        "counts": {
            "releases_scanned_per_pass": releases_scanned,
            "release_elements_read": releases_scanned + second_pass_scanned,
            "rock_seed_releases": rock_seed_releases,
            "qualifying_artists": len(qualifying_artist_ids),
            "complete_artist_releases": complete_artist_releases,
            "artists_selected": len(selected_artists),
            "masters_selected": selected_master_records,
        },
    }
    with open(args.output, "w", encoding="utf-8") as output:
        json.dump(result, output, ensure_ascii=True, indent=2, sort_keys=True)
        output.write("\n")


def iter_entities(path: str, entity_tag: str):
    source_path = Path(path)
    opener = gzip.open if source_path.suffix == ".gz" else open
    with opener(source_path, "rb") as source:
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
    return child.text.strip() if child is not None and child.text else ""


def child_texts(element: ET.Element, path: str) -> list[str]:
    return [child.text.strip() for child in element.findall(path) if child.text and child.text.strip()]


def id_sort_key(value: str):
    return (0, int(value)) if value.isdigit() else (1, value)


if __name__ == "__main__":
    main()
