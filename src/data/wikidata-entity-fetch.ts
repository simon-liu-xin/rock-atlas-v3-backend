import { createHash } from "node:crypto";

import { readBoundedResponse } from "./bounded-fetch.ts";
import { buildWikidataEntityUrlsForAll } from "./wikidata-refresh.ts";

export interface WikidataEntityFetchInput {
  qids: string[];
  endpoint?: string;
  userAgent: string;
  maxBatchBytes: number;
  maxAttempts: number;
  timeoutMs: number;
  fetchFn?: typeof fetch;
  sleepFn?: (milliseconds: number) => Promise<void>;
}

export interface FetchedWikidataEntity {
  qid: string;
  revision_id: number;
  payload: Record<string, unknown>;
}

export interface WikidataEntityBatch {
  batch_index: number;
  source_url: string;
  qids: string[];
  attempts: number;
  retry_count: number;
  network_bytes: number;
  response_bytes: number;
  response_sha256: string;
  entities: FetchedWikidataEntity[];
}

export async function* fetchWikidataEntityBatches(
  input: WikidataEntityFetchInput,
): AsyncGenerator<WikidataEntityBatch> {
  validateInput(input);
  const urls = buildWikidataEntityUrlsForAll(input.qids, input.endpoint);
  if (urls.length === 0) throw new Error("Wikidata tracked fetch requires at least one QID");
  const fetchFn = input.fetchFn ?? fetch;
  const sleepFn = input.sleepFn ?? sleep;

  for (let batchIndex = 0; batchIndex < urls.length; batchIndex += 1) {
    const sourceUrl = urls[batchIndex]!;
    const qids = new URL(sourceUrl).searchParams.get("ids")?.split("|") ?? [];
    let networkBytes = 0;
    let lastRetryReason = "retryable response";
    let completed = false;

    for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
      const response = await fetchFn(sourceUrl, {
        headers: {
          accept: "application/json",
          "user-agent": input.userAgent,
        },
        signal: AbortSignal.timeout(input.timeoutMs),
      });

      if (response.status === 429 || response.status === 503) {
        lastRetryReason = `HTTP ${response.status}`;
        await response.body?.cancel();
        if (attempt === input.maxAttempts) break;
        await sleepFn(retryDelayMs(response.headers.get("retry-after"), attempt));
        continue;
      }
      if (!response.ok) {
        throw new Error(`Wikidata batch ${batchIndex + 1} returned HTTP ${response.status}`);
      }

      const bytes = await readBoundedResponse(response, input.maxBatchBytes);
      networkBytes += bytes.byteLength;
      const payload = parseJson(bytes, batchIndex);
      const apiError = asRecord(payload.error);
      if (apiError.code === "maxlag") {
        lastRetryReason = `Wikidata maxlag: ${String(apiError.info ?? "unspecified")}`;
        if (attempt === input.maxAttempts) break;
        await sleepFn(retryDelayMs(null, attempt));
        continue;
      }

      const entities = readEntities(payload, qids);
      completed = true;
      yield {
        batch_index: batchIndex + 1,
        source_url: sourceUrl,
        qids,
        attempts: attempt,
        retry_count: attempt - 1,
        network_bytes: networkBytes,
        response_bytes: bytes.byteLength,
        response_sha256: createHash("sha256").update(bytes).digest("hex"),
        entities,
      };
      break;
    }
    if (!completed) {
      throw new Error(
        `Wikidata batch ${batchIndex + 1} failed after ${input.maxAttempts} attempts: ${lastRetryReason}`,
      );
    }
  }
}

function readEntities(
  payload: Record<string, unknown>,
  qids: string[],
): FetchedWikidataEntity[] {
  const entityMap = asRecord(payload.entities);
  return qids.map((qid) => {
    if (!(qid in entityMap)) throw new Error(`Wikidata response is missing requested entity ${qid}`);
    const entity = asRecord(entityMap[qid]);
    if (entity.missing === true) throw new Error(`Wikidata entity ${qid} is marked missing`);
    if (entity.id !== qid) throw new Error(`Wikidata entity ${qid} identity mismatch`);
    if (!Number.isSafeInteger(entity.lastrevid) || Number(entity.lastrevid) < 1) {
      throw new Error(`Wikidata entity ${qid} requires a positive lastrevid`);
    }
    return {
      qid,
      revision_id: Number(entity.lastrevid),
      payload: entity,
    };
  });
}

function parseJson(bytes: Uint8Array, batchIndex: number): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new Error(`Wikidata batch ${batchIndex + 1} returned invalid JSON`);
  }
}

function retryDelayMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    return Math.min(Number(retryAfter) * 1_000, 30_000);
  }
  return Math.min(1_000 * 2 ** (attempt - 1), 30_000);
}

function validateInput(input: WikidataEntityFetchInput): void {
  if (!Array.isArray(input.qids) || input.qids.length === 0) {
    throw new Error("Wikidata tracked fetch requires at least one QID");
  }
  if (!/^MusicWiki\/\d+(?:\.\d+)*(?:\s|$)/.test(input.userAgent) || input.userAgent.length < 16) {
    throw new Error("Wikidata production fetch requires a descriptive MusicWiki User-Agent");
  }
  assertPositiveInteger(input.maxBatchBytes, "maxBatchBytes");
  assertPositiveInteger(input.maxAttempts, "maxAttempts");
  assertPositiveInteger(input.timeoutMs, "timeoutMs");
  if (input.maxAttempts > 10) throw new Error("maxAttempts cannot exceed 10");
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
