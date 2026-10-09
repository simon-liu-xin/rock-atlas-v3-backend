const WIKIDATA_BATCH_SIZE = 50;
const RECENT_CHANGES_LIMIT = 500;

export interface WikidataRecentChangesWindow {
  start: string;
  end: string;
  continuation?: string;
}

export interface TrackedWikidataChangePage {
  changed_qids: string[];
  rccontinue: string | null;
  window_complete: boolean;
}

export function buildWikidataEntityUrlsForAll(
  qids: string[],
  endpoint = "https://www.wikidata.org/w/api.php",
): string[] {
  const normalized = normalizeAllQids(qids);
  const urls: string[] = [];
  for (let index = 0; index < normalized.length; index += WIKIDATA_BATCH_SIZE) {
    const url = new URL(endpoint);
    url.search = new URLSearchParams({
      action: "wbgetentities",
      format: "json",
      formatversion: "2",
      maxlag: "5",
      props: "info|labels|descriptions|aliases|claims",
      languages: "en|zh|zh-hans|zh-hant",
      languagefallback: "1",
      ids: normalized.slice(index, index + WIKIDATA_BATCH_SIZE).join("|"),
    }).toString();
    urls.push(url.toString());
  }
  return urls;
}

export function buildWikidataRecentChangesUrl(window: WikidataRecentChangesWindow): string {
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error("Wikidata RecentChanges requires a valid ascending time window");
  }
  if (end - start > 30 * 24 * 60 * 60 * 1000) {
    throw new Error("Wikidata RecentChanges window cannot exceed 30 days");
  }

  const parameters: Record<string, string> = {
    action: "query",
    format: "json",
    formatversion: "2",
    maxlag: "5",
    list: "recentchanges",
    rcnamespace: "0",
    rcdir: "newer",
    rcstart: window.start,
    rcend: window.end,
    rclimit: String(RECENT_CHANGES_LIMIT),
    rcprop: "title|ids|timestamp",
    rctype: "edit|new|log",
  };
  if (window.continuation) parameters.rccontinue = window.continuation;
  const url = new URL("https://www.wikidata.org/w/api.php");
  url.search = new URLSearchParams(parameters).toString();
  return url.toString();
}

export function readTrackedWikidataChanges(
  payload: unknown,
  trackedQids: string[],
): TrackedWikidataChangePage {
  const root = asRecord(payload);
  const query = asRecord(root.query);
  const changes = Array.isArray(query.recentchanges) ? query.recentchanges : [];
  const tracked = new Set(normalizeAllQids(trackedQids));
  const changed = new Set<string>();
  for (const rawChange of changes) {
    const change = asRecord(rawChange);
    const title = typeof change.title === "string" ? change.title.toUpperCase() : "";
    if (change.ns === 0 && /^Q[1-9]\d*$/.test(title) && tracked.has(title)) changed.add(title);
  }
  const continuation = asRecord(root.continue).rccontinue;
  return {
    changed_qids: [...changed].sort(compareQids),
    rccontinue: typeof continuation === "string" ? continuation : null,
    window_complete: typeof continuation !== "string",
  };
}

function normalizeAllQids(qids: string[]): string[] {
  const normalized = qids.map((qid) => qid.trim().toUpperCase());
  for (const qid of normalized) {
    if (!/^Q[1-9]\d*$/.test(qid)) throw new Error(`Invalid Wikidata QID: ${qid}`);
  }
  return [...new Set(normalized)].sort(compareQids);
}

function compareQids(left: string, right: string): number {
  const leftNumber = BigInt(left.slice(1));
  const rightNumber = BigInt(right.slice(1));
  return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
