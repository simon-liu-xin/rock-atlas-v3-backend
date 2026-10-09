export interface CatalogBaseBackupManifest {
  readonly backup_id: string;
  readonly postgres_major: number;
  readonly started_at: string;
  readonly completed_at: string;
  readonly first_wal_time: string;
  readonly last_wal_time: string;
  readonly backup_sha256: string;
  readonly verification_status: "verified" | "failed" | "pending";
}

export interface CatalogPitrRecoveryPlan {
  readonly backup_id: string;
  readonly target_time: string;
  readonly restore_instance: string;
  readonly steps: readonly {
    readonly kind: "verify-backup" | "restore-isolated" | "replay-wal" | "validate-catalog" | "authorize-switch";
    readonly destructive_to_production: false;
  }[];
}

export function buildCatalogPitrRecoveryPlan(input: {
  readonly backup: CatalogBaseBackupManifest;
  readonly target_time: string;
  readonly restore_instance: string;
}): CatalogPitrRecoveryPlan {
  if (input.backup.postgres_major !== 18) throw new Error("Catalog PITR requires PostgreSQL 18");
  if (input.backup.verification_status !== "verified") throw new Error("Catalog base backup is not verified");
  if (!/^[a-f0-9]{64}$/u.test(input.backup.backup_sha256)) {
    throw new Error("Catalog base backup SHA-256 is invalid");
  }
  const target = timestamp(input.target_time, "target_time");
  const firstWal = timestamp(input.backup.first_wal_time, "first_wal_time");
  const lastWal = timestamp(input.backup.last_wal_time, "last_wal_time");
  if (target < firstWal || target > lastWal) {
    throw new Error("Catalog PITR target is outside the archived WAL interval");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(input.restore_instance)) {
    throw new Error("Catalog PITR restore instance name is unsafe");
  }
  return {
    backup_id: input.backup.backup_id,
    target_time: input.target_time,
    restore_instance: input.restore_instance,
    steps: [
      { kind: "verify-backup", destructive_to_production: false },
      { kind: "restore-isolated", destructive_to_production: false },
      { kind: "replay-wal", destructive_to_production: false },
      { kind: "validate-catalog", destructive_to_production: false },
      { kind: "authorize-switch", destructive_to_production: false },
    ],
  };
}

export function assessCatalogPitrRehearsal(input: {
  readonly incident_time: string;
  readonly recovered_through: string;
  readonly rehearsal_started_at: string;
  readonly validation_completed_at: string;
  readonly checks: Readonly<Record<"checksums" | "schema" | "registry" | "counts" | "canonical_hash_sample", boolean>>;
}): {
  readonly passed: boolean;
  readonly rpo_minutes: number;
  readonly rto_minutes: number;
  readonly failed_checks: readonly string[];
} {
  const rpoMinutes = minutesBetween(input.recovered_through, input.incident_time);
  const rtoMinutes = minutesBetween(input.rehearsal_started_at, input.validation_completed_at);
  const failedChecks = Object.entries(input.checks)
    .filter(([, passed]) => !passed)
    .map(([check]) => check)
    .sort();
  return {
    passed: rpoMinutes <= 15 && rtoMinutes <= 240 && failedChecks.length === 0,
    rpo_minutes: rpoMinutes,
    rto_minutes: rtoMinutes,
    failed_checks: failedChecks,
  };
}

function minutesBetween(start: string, end: string): number {
  return Math.round((timestamp(end, "end") - timestamp(start, "start")) / 60_000);
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be an ISO timestamp`);
  return parsed;
}
