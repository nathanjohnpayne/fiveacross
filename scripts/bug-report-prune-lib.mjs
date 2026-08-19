const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const CLEANUP_LEASE_MS = 10 * 60 * 1_000;

function timeMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return Date.parse(value);
  try {
    const date = typeof value?.toDate === 'function' ? value.toDate() : null;
    return date instanceof Date && Number.isFinite(date.getTime()) ? date.getTime() : null;
  } catch {
    return null;
  }
}

function validBase(row) {
  return (
    row &&
    typeof row.id === 'string' &&
    /^[a-f0-9]{64}$/.test(row.id) &&
    typeof row.reporterHash === 'string' &&
    /^[a-f0-9]{20}$/.test(row.reporterHash) &&
    typeof row.submissionId === 'string' &&
    /^[A-Za-z0-9_-]{8,64}$/.test(row.submissionId) &&
    row.requestHashVersion === 1 &&
    typeof row.requestHash === 'string' &&
    /^[a-f0-9]{64}$/.test(row.requestHash) &&
    timeMs(row.intakeStartedAt) !== null
  );
}

function validPending(row) {
  return validBase(row) && row.intakeState === 'pending' && typeof row.leaseId === 'string' && timeMs(row.leaseExpiresAt) !== null;
}

function validDeleting(row) {
  return (
    validBase(row) &&
    row.intakeState === 'deleting' &&
    typeof row.cleanupLeaseId === 'string' &&
    timeMs(row.cleanupLeaseExpiresAt) !== null
  );
}

async function scanPages(store, state, pageSize, visit) {
  let cursor = null;
  while (true) {
    const rows = await store.list(state, cursor, pageSize);
    if (!Array.isArray(rows)) throw new Error(`${state} scan returned an invalid page`);
    if (rows.length === 0) return;
    for (const row of rows) await visit(row);
    cursor = rows.at(-1)?.id ?? null;
    if (rows.length < pageSize) return;
  }
}

export async function prunePendingBugReports({
  store,
  nowMs,
  apply = false,
  pageSize = 100,
  randomUUID,
}) {
  if (!Number.isFinite(nowMs)) throw new Error('A finite retention time is required.');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('Page size must be 1-100.');
  const summary = { scanned: 0, eligible: 0, claimed: 0, resumed: 0, deleted: 0, skippedRace: 0, failed: [] };
  const newlyClaimed = new Set();
  const ownedLeases = new Map();
  const cutoff = nowMs - RETENTION_MS;

  await scanPages(store, 'pending', pageSize, async (row) => {
    summary.scanned += 1;
    if (!validPending(row)) {
      summary.failed.push({ id: row?.id ?? 'unknown', error: 'invalid pending coordination' });
      return;
    }
    if (timeMs(row.intakeStartedAt) > cutoff || timeMs(row.leaseExpiresAt) > nowMs) return;
    summary.eligible += 1;
    if (!apply) return;
    const cleanupLeaseId = randomUUID();
    try {
      const claimed = await store.claimPending(row, cleanupLeaseId, nowMs + CLEANUP_LEASE_MS);
      if (!claimed) {
        summary.skippedRace += 1;
        return;
      }
      newlyClaimed.add(row.id);
      ownedLeases.set(row.id, cleanupLeaseId);
      summary.claimed += 1;
    } catch (error) {
      summary.failed.push({ id: row.id, error: error instanceof Error ? error.message : String(error) });
    }
  });

  await scanPages(store, 'deleting', pageSize, async (row) => {
    summary.scanned += 1;
    if (!validDeleting(row)) {
      summary.failed.push({ id: row?.id ?? 'unknown', error: 'invalid deleting coordination' });
      return;
    }
    const ownedFromPending = newlyClaimed.has(row.id);
    if (!ownedFromPending && timeMs(row.cleanupLeaseExpiresAt) > nowMs) return;
    if (!ownedFromPending) summary.eligible += 1;
    if (!apply) return;

    let cleanupLeaseId = ownedLeases.get(row.id);
    try {
      if (!cleanupLeaseId) {
        cleanupLeaseId = randomUUID();
        const claimed = await store.claimDeleting(row, cleanupLeaseId, nowMs + CLEANUP_LEASE_MS);
        if (!claimed) {
          summary.skippedRace += 1;
          return;
        }
        summary.resumed += 1;
      }
      const evidencePath = `bug-reports/${row.reporterHash}/${row.id}/screenshot.png`;
      await store.deleteEvidence(evidencePath);
      const deleted = await store.deleteIfOwned(row, cleanupLeaseId);
      if (!deleted) {
        summary.skippedRace += 1;
        return;
      }
      summary.deleted += 1;
    } catch (error) {
      summary.failed.push({ id: row.id, error: error instanceof Error ? error.message : String(error) });
    }
  });

  return summary;
}
