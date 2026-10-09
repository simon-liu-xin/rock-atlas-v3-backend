#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildCatalogPitrRecoveryPlan } from "../../src/data/recovery/catalog-postgres-pitr.ts";

const args = parseArgs(process.argv.slice(2));
if (!args.manifest || !args.targetTime || !args.restoreInstance) {
  process.stderr.write(
    "Usage: node scripts/offline-data/catalog_postgres_pitr_plan.mjs " +
    "--manifest <verified-backup.json> --target-time <ISO> --restore-instance <name>\n",
  );
  process.exitCode = 2;
} else {
  const manifestPath = resolve(args.manifest);
  const backup = JSON.parse(await readFile(manifestPath, "utf8"));
  const plan = buildCatalogPitrRecoveryPlan({
    backup,
    target_time: args.targetTime,
    restore_instance: args.restoreInstance,
  });
  process.stdout.write(`${JSON.stringify({
    mode: "read-only-recovery-plan",
    production_mutations_executed: 0,
    manifest_path: manifestPath,
    plan,
  }, null, 2)}\n`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === "--manifest") parsed.manifest = value;
    if (argv[index] === "--target-time") parsed.targetTime = value;
    if (argv[index] === "--restore-instance") parsed.restoreInstance = value;
    if (argv[index].startsWith("--")) index += 1;
  }
  return parsed;
}
