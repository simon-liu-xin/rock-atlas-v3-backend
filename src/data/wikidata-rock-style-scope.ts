export interface ReviewedRockStyle {
  readonly qid: string;
  readonly label: string;
  readonly description: string;
  readonly parent_qids: readonly string[];
  readonly country_labels: readonly string[];
  readonly origin_date: string | null;
  readonly source_revision_id: string | null;
}

export interface ReviewedRockStyleCatalog {
  readonly schema_version: "1.0";
  readonly snapshot_id: string;
  readonly license: "CC0-1.0";
  readonly root_qid: "Q11399";
  readonly styles: readonly ReviewedRockStyle[];
}

export function parseReviewedRockStyleCatalog(value: unknown): ReviewedRockStyleCatalog {
  const catalog = asRecord(value);
  const source = asRecord(catalog.source);
  if (catalog.schema_version !== "1.0" || catalog.license !== "CC0-1.0" ||
      typeof catalog.snapshot_id !== "string" || !catalog.snapshot_id ||
      source.root_qid !== "Q11399" || !Array.isArray(catalog.styles) ||
      catalog.styles.length === 0) {
    throw new Error("Rock style catalog contract mismatch");
  }
  const seen = new Set<string>();
  const styles = catalog.styles.map((value): ReviewedRockStyle => {
    const style = asRecord(value);
    if (typeof style.qid !== "string" || !isQid(style.qid) || seen.has(style.qid) ||
        typeof style.label !== "string" || !style.label.trim() ||
        typeof style.description !== "string" || !validQidArray(style.parent_qids) ||
        !validStringArray(style.country_labels) ||
        (style.origin_date !== null && typeof style.origin_date !== "string") ||
        (style.source_revision_id !== null && style.source_revision_id !== undefined &&
          typeof style.source_revision_id !== "string")) {
      throw new Error("Rock style catalog contains an invalid or duplicate style");
    }
    seen.add(style.qid);
    return {
      qid: style.qid,
      label: style.label.trim(),
      description: style.description,
      parent_qids: [...style.parent_qids],
      country_labels: [...style.country_labels],
      origin_date: style.origin_date,
      source_revision_id: style.source_revision_id ?? null,
    };
  });
  if (!seen.has("Q11399")) throw new Error("Rock style catalog must include Q11399");
  return {
    schema_version: "1.0",
    snapshot_id: catalog.snapshot_id,
    license: "CC0-1.0",
    root_qid: "Q11399",
    styles,
  };
}

export function isQid(value: string): boolean {
  return /^Q[1-9][0-9]*$/u.test(value);
}

function validQidArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && isQid(item));
}

function validStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
