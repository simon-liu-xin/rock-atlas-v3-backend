import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
const execute = promisify(execFile);

test.each([true, false])('preflight resolves JSON builder capability from the separate repository (available=%s)', async (available) => {
  const root = await mkdtemp(join(tmpdir(), 'rock-atlas-preflight-'));
  try {
    if (available) for (const file of ['scripts/offline-data/export_full_frontend_jsonl.mjs',
      'scripts/offline-data/publish_offline_generation.mjs', 'src/data/publication/catalog-jsonl-exporter-v3.ts']) {
      const path = join(root, file); await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, '// Existence probe fixture; not an executed publisher.\n');
    }
    const result = await execute(process.execPath, [resolve('scripts/offline-data/preflight_production.mjs'),
      '--plan', resolve('data/sources/offline-bootstrap-plan-v1.json')], {
      env: { ...process.env, ROCK_ATLAS_JSON_BUILDER_ROOT: root },
    });
    const report = JSON.parse(result.stdout);
    expect(report.stages.find((row: { stage_id: string }) => row.stage_id === 'publish').implemented).toBe(available);
    expect(report.network_requests_executed).toBe(0);
    expect(report.data_root_mutated).toBe(false);
    expect(report.full_archives_downloaded).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
