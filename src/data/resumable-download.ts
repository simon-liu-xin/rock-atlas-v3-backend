import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";

export interface BoundedDownloadOptions {
  expectedBytes: number;
  maxBytes: number;
  timeoutMs?: number;
}

export interface BoundedUnknownDownloadOptions {
  maxBytes: number;
  timeoutMs?: number;
}

export interface BoundedDownloadResult {
  bytes: number;
  resumedFrom: number;
  sha256: string;
}

export async function downloadBoundedFile(
  url: string,
  destination: string,
  options: BoundedDownloadOptions,
): Promise<BoundedDownloadResult> {
  validateBudget(options);
  await mkdir(dirname(destination), { recursive: true });

  const completedBytes = await fileSize(destination);
  if (completedBytes !== null) {
    if (completedBytes !== options.expectedBytes) {
      throw new Error(`Completed download has ${completedBytes} bytes, expected ${options.expectedBytes}`);
    }
    return {
      bytes: completedBytes,
      resumedFrom: completedBytes,
      sha256: await sha256File(destination),
    };
  }

  const partialPath = `${destination}.part`;
  const resumedFrom = (await fileSize(partialPath)) ?? 0;
  if (resumedFrom > options.expectedBytes) {
    throw new Error(`Partial download has ${resumedFrom} bytes, expected at most ${options.expectedBytes}`);
  }
  if (resumedFrom === options.expectedBytes) {
    await rename(partialPath, destination);
    return {
      bytes: resumedFrom,
      resumedFrom,
      sha256: await sha256File(destination),
    };
  }

  const request: RequestInit = {
    signal: AbortSignal.timeout(options.timeoutMs ?? 10 * 60_000),
  };
  if (resumedFrom > 0) request.headers = { range: `bytes=${resumedFrom}-` };
  const response = await fetch(url, request);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  validateResponse(response, resumedFrom, options);
  if (!response.body) throw new Error(`${url} returned an empty response body`);

  const file = await openPartialFile(partialPath, resumedFrom);
  const reader = response.body.getReader();
  let totalBytes = resumedFrom;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > options.maxBytes || totalBytes > options.expectedBytes) {
        await reader.cancel();
        throw new Error(`Download exceeded the ${options.maxBytes} byte budget`);
      }
      await writeAll(file, value);
    }
  } finally {
    await file.close();
  }

  if (totalBytes !== options.expectedBytes) {
    throw new Error(`Download stopped at ${totalBytes} bytes, expected ${options.expectedBytes}`);
  }
  await rename(partialPath, destination);
  return {
    bytes: totalBytes,
    resumedFrom,
    sha256: await sha256File(destination),
  };
}

export async function downloadBoundedUnknownFile(
  url: string,
  destination: string,
  options: BoundedUnknownDownloadOptions,
): Promise<BoundedDownloadResult> {
  validateUnknownBudget(options);
  await mkdir(dirname(destination), { recursive: true });

  const completedBytes = await fileSize(destination);
  if (completedBytes !== null) {
    if (completedBytes < 1 || completedBytes > options.maxBytes) {
      throw new Error(
        `Completed download has ${completedBytes} bytes, expected between 1 and ${options.maxBytes}`,
      );
    }
    return {
      bytes: completedBytes,
      resumedFrom: completedBytes,
      sha256: await sha256File(destination),
    };
  }

  const partialPath = `${destination}.part`;
  const resumedFrom = (await fileSize(partialPath)) ?? 0;
  if (resumedFrom > options.maxBytes) {
    throw new Error(`Partial download exceeds the ${options.maxBytes} byte budget`);
  }
  const request: RequestInit = {
    signal: AbortSignal.timeout(options.timeoutMs ?? 10 * 60_000),
  };
  if (resumedFrom > 0) request.headers = { range: `bytes=${resumedFrom}-` };
  const response = await fetch(url, request);
  if (
    response.status === 416 &&
    resumedFrom > 0 &&
    response.headers.get("content-range") === `bytes */${resumedFrom}`
  ) {
    await response.body?.cancel();
    await rename(partialPath, destination);
    return {
      bytes: resumedFrom,
      resumedFrom,
      sha256: await sha256File(destination),
    };
  }
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const declaredTotal = validateUnknownResponse(response, resumedFrom, options.maxBytes);
  if (!response.body) throw new Error(`${url} returned an empty response body`);

  const file = await openPartialFile(partialPath, resumedFrom);
  const reader = response.body.getReader();
  let totalBytes = resumedFrom;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > options.maxBytes) {
        await reader.cancel();
        throw new Error(`Download exceeded the ${options.maxBytes} byte budget`);
      }
      await writeAll(file, value);
    }
  } finally {
    await file.close();
  }

  if (totalBytes < 1) throw new Error("Download completed with zero bytes");
  if (declaredTotal !== null && totalBytes !== declaredTotal) {
    throw new Error(`Download stopped at ${totalBytes} bytes, expected ${declaredTotal}`);
  }
  await rename(partialPath, destination);
  return {
    bytes: totalBytes,
    resumedFrom,
    sha256: await sha256File(destination),
  };
}

function validateBudget(options: BoundedDownloadOptions): void {
  for (const [name, value] of Object.entries({
    expectedBytes: options.expectedBytes,
    maxBytes: options.maxBytes,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}: ${value}`);
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
  ) {
    throw new Error(`Invalid timeoutMs: ${options.timeoutMs}`);
  }
  if (options.expectedBytes > options.maxBytes) {
    throw new Error(
      `Expected download size ${options.expectedBytes} exceeds the ${options.maxBytes} byte budget`,
    );
  }
}

function validateUnknownBudget(options: BoundedUnknownDownloadOptions): void {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new Error(`Invalid maxBytes: ${options.maxBytes}`);
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
  ) {
    throw new Error(`Invalid timeoutMs: ${options.timeoutMs}`);
  }
}

function validateResponse(
  response: Response,
  resumedFrom: number,
  options: BoundedDownloadOptions,
): void {
  if (resumedFrom > 0) {
    if (response.status !== 206) {
      throw new Error(`Server ignored Range request at byte ${resumedFrom}`);
    }
    const expectedRange = `bytes ${resumedFrom}-${options.expectedBytes - 1}/${options.expectedBytes}`;
    if (response.headers.get("content-range") !== expectedRange) {
      throw new Error(`Unexpected Content-Range: ${response.headers.get("content-range") ?? "missing"}`);
    }
  } else if (response.status !== 200) {
    throw new Error(`Fresh download expected HTTP 200, received ${response.status}`);
  }

  const declaredLength = response.headers.get("content-length");
  const expectedRemaining = options.expectedBytes - resumedFrom;
  if (declaredLength && Number(declaredLength) !== expectedRemaining) {
    throw new Error(`Response declares ${declaredLength} bytes, expected ${expectedRemaining}`);
  }
}

function validateUnknownResponse(
  response: Response,
  resumedFrom: number,
  maxBytes: number,
): number | null {
  const declaredLengthHeader = response.headers.get("content-length");
  const declaredLength = declaredLengthHeader === null ? null : Number(declaredLengthHeader);
  if (
    declaredLength !== null &&
    (!Number.isSafeInteger(declaredLength) || declaredLength < 0)
  ) {
    throw new Error(`Invalid Content-Length: ${declaredLengthHeader}`);
  }

  if (resumedFrom === 0) {
    if (response.status !== 200) {
      throw new Error(`Fresh download expected HTTP 200, received ${response.status}`);
    }
    if (declaredLength !== null && declaredLength > maxBytes) {
      throw new Error(`Response exceeds the ${maxBytes} byte budget`);
    }
    return declaredLength;
  }

  if (response.status !== 206) {
    throw new Error(`Server ignored Range request at byte ${resumedFrom}`);
  }
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
    response.headers.get("content-range") ?? "",
  );
  if (!range) throw new Error("Resumed metadata download requires a complete Content-Range");
  const start = Number(range[1]);
  const end = Number(range[2]);
  const total = Number(range[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start !== resumedFrom ||
    end < start ||
    end !== total - 1 ||
    total > maxBytes
  ) {
    throw new Error(`Unexpected Content-Range: ${response.headers.get("content-range")}`);
  }
  if (declaredLength !== null && declaredLength !== total - resumedFrom) {
    throw new Error(`Response declares ${declaredLength} bytes, expected ${total - resumedFrom}`);
  }
  return total;
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const state = await lstat(path);
    if (state.isSymbolicLink()) throw new Error(`${path} must not be a symbolic link`);
    if (!state.isFile()) throw new Error(`${path} must be a regular file`);
    return state.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function sha256File(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${path} must be a regular file`);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      hash.update(buffer);
    }
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes !== after.size
    ) {
      throw new Error(`${path} changed while its SHA-256 was calculated`);
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function openPartialFile(path: string, resumedFrom: number) {
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_NOFOLLOW |
    (resumedFrom > 0 ? constants.O_APPEND : constants.O_TRUNC);
  const handle = await open(path, flags, 0o600);
  const state = await handle.stat();
  if (!state.isFile() || state.size !== resumedFrom) {
    await handle.close();
    throw new Error(`${path} changed before the download opened it`);
  }
  return handle;
}

async function writeAll(
  file: Awaited<ReturnType<typeof open>>,
  value: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const { bytesWritten } = await file.write(
      value,
      offset,
      value.byteLength - offset,
      null,
    );
    if (bytesWritten < 1) throw new Error("Download file write stopped before the chunk completed");
    offset += bytesWritten;
  }
}
