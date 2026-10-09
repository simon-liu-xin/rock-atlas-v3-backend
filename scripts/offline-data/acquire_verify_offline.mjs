import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  acquireAndVerifyOfflineArtifacts,
  OFFLINE_FULL_ARCHIVE_DOWNLOAD_CONFIRMATION,
} from "../../src/data/offline-acquire-verify.ts";

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const plan = JSON.parse(await readFile(resolve(options.plan), "utf8"));
  const result = await acquireAndVerifyOfflineArtifacts(plan, {
    timeoutMs: options.timeoutMs,
    gnupgHome: options.gnupgHome,
    downloadAuthorization: options.downloadAuthorization,
  });
  process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
}

function parseArguments(argv) {
  const options = {
    plan: null,
    timeoutMs: undefined,
    gnupgHome: undefined,
    downloadAuthorization: undefined,
  };
  const definitions = {
    "--plan": ["plan", "string"],
    "--timeout-ms": ["timeoutMs", "integer"],
    "--gnupg-home": ["gnupgHome", "string"],
    "--download-authorization": ["downloadAuthorization", "string"],
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const definition = definitions[argument];
    if (!definition) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (seen.has(argument)) throw new Error(`${argument} may only be provided once`);
    const [key, kind] = definition;
    options[key] = kind === "integer" ? positiveInteger(value, argument) : value;
    seen.add(argument);
    index += 1;
  }
  if (options.plan === null) throw new Error("--plan is required");
  if (
    options.downloadAuthorization !== undefined &&
    options.downloadAuthorization !== OFFLINE_FULL_ARCHIVE_DOWNLOAD_CONFIRMATION
  ) {
    throw new Error(
      `--download-authorization must equal ${OFFLINE_FULL_ARCHIVE_DOWNLOAD_CONFIRMATION}`,
    );
  }
  return options;
}

function positiveInteger(value, argument) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error(`${argument} must be a positive integer`);
  }
  return Number(value);
}
