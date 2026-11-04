import { CanonicalReconciliationStatus, fromMinorUnits } from './moneyUtils.js';
import { pgDbService } from './pgDatabase.js';

export const MAX_RECONCILIATION_AGE_SECONDS = 300; // 5 minute freshness SLA

export interface AuthoritativeReconciliationGateResult {
  status: CanonicalReconciliationStatus;
  isGreen: boolean; // STRICT: Only true when status === 'RECONCILED' and fresh within SLA and 0 discrepancy
  discrepancyMinor: bigint;
  discrepancyUsd: number;
  lastRunAt: string | null;
  ageSeconds: number | null;
  message: string;
}

/**
 * Single Authoritative Reconciliation Gate
 *
 * Rules:
 * - NO RECORD              → RED (RECONCILIATION_REQUIRED)
 * - RECONCILIATION_REQUIRED → RED
 * - UNVERIFIED             → RED
 * - ERROR                  → RED
 * - STALE                  → RED
 * - DISCREPANCY            → RED
 * - RECONCILED + FRESH     → GREEN
 *
 * No other component may independently decide that treasury is reconciled.
 */
export async function evaluateAuthoritativeReconciliationGate(
  maxAgeSeconds: number = MAX_RECONCILIATION_AGE_SECONDS
): Promise<AuthoritativeReconciliationGateResult> {
  if (!pgDbService.isLiveDatabaseConnected()) {
    return {
      status: 'ERROR',
      isGreen: false,
      discrepancyMinor: 0n,
      discrepancyUsd: 0,
      lastRunAt: null,
      ageSeconds: null,
      message: 'PostgreSQL database offline. Cannot verify reconciliation against authoritative ledger. Live execution blocked.'
    };
  }

  try {
    const reconRes = await pgDbService.query(
      `SELECT status, discrepancy_minor as "discMinor", run_at as "runAt", reason
       FROM treasury_reconciliations
       ORDER BY run_at DESC LIMIT 1`
    );

    if (reconRes.rows.length === 0) {
      return {
        status: 'RECONCILIATION_REQUIRED',
        isGreen: false,
        discrepancyMinor: 0n,
        discrepancyUsd: 0,
        lastRunAt: null,
        ageSeconds: null,
        message: 'No prior reconciliation record found in PostgreSQL ledger. Initial Binance-to-ledger reconciliation required before live capital deployment.'
      };
    }

    const row = reconRes.rows[0];
    const discMinor = BigInt(row.discMinor || '0');
    const discUsd = Number(fromMinorUnits(discMinor));
    const runAtDate = new Date(row.runAt);
    const ageSeconds = Math.max(0, (Date.now() - runAtDate.getTime()) / 1000);
    const rawStatus = (row.status || '').toUpperCase();

    // Map to canonical status
    let canonicalStatus: CanonicalReconciliationStatus;
    if (rawStatus === 'RECONCILED' || rawStatus === 'BALANCED') {
      canonicalStatus = 'RECONCILED';
    } else if (
      rawStatus === 'DISCREPANCY' ||
      rawStatus === 'DISCREPANCY_DETECTED' ||
      rawStatus === 'MISMATCH' ||
      rawStatus === 'BLOCKED_BY_DISCREPANCY'
    ) {
      canonicalStatus = 'DISCREPANCY';
    } else if (rawStatus === 'RECONCILIATION_REQUIRED') {
      canonicalStatus = 'RECONCILIATION_REQUIRED';
    } else if (rawStatus === 'STALE' || rawStatus === 'ORACLE_STALE') {
      canonicalStatus = 'STALE';
    } else if (rawStatus === 'ERROR' || rawStatus === 'QUERY_ERROR') {
      canonicalStatus = 'ERROR';
    } else {
      canonicalStatus = 'UNVERIFIED';
    }

    // Rule 1: Freshness SLA check -> STALE (RED)
    if (ageSeconds > maxAgeSeconds) {
      return {
        status: 'STALE',
        isGreen: false,
        discrepancyMinor: discMinor,
        discrepancyUsd: discUsd,
        lastRunAt: runAtDate.toISOString(),
        ageSeconds,
        message: `Last reconciliation is stale (${Math.round(ageSeconds)}s ago > ${maxAgeSeconds}s SLA). Fresh reconciliation required. Live execution blocked.`
      };
    }

    // Rule 2: Discrepancy -> DISCREPANCY (RED)
    if (discMinor !== 0n || canonicalStatus === 'DISCREPANCY') {
      return {
        status: 'DISCREPANCY',
        isGreen: false,
        discrepancyMinor: discMinor,
        discrepancyUsd: discUsd,
        lastRunAt: runAtDate.toISOString(),
        ageSeconds,
        message: `Reconciliation variance detected between Binance and ledger ($${discUsd.toFixed(2)} discrepancy). Live execution blocked.`
      };
    }

    // Rule 3: Explicit RECONCILIATION_REQUIRED -> RED
    if (canonicalStatus === 'RECONCILIATION_REQUIRED') {
      return {
        status: 'RECONCILIATION_REQUIRED',
        isGreen: false,
        discrepancyMinor: discMinor,
        discrepancyUsd: discUsd,
        lastRunAt: runAtDate.toISOString(),
        ageSeconds,
        message: 'Reconciliation is explicitly marked as required. Live capital deployment blocked.'
      };
    }

    // Rule 4: UNVERIFIED -> RED
    if (canonicalStatus === 'UNVERIFIED') {
      return {
        status: 'UNVERIFIED',
        isGreen: false,
        discrepancyMinor: discMinor,
        discrepancyUsd: discUsd,
        lastRunAt: runAtDate.toISOString(),
        ageSeconds,
        message: 'Binance external balance is unverified or unreachable. Live capital deployment blocked.'
      };
    }

    // Rule 5: ERROR -> RED
    if (canonicalStatus === 'ERROR') {
      return {
        status: 'ERROR',
        isGreen: false,
        discrepancyMinor: discMinor,
        discrepancyUsd: discUsd,
        lastRunAt: runAtDate.toISOString(),
        ageSeconds,
        message: `Reconciliation error: ${row.reason || 'Query or provider error'}. Live capital deployment blocked.`
      };
    }

    // Rule 6: RECONCILED + FRESH + 0 DISCREPANCY -> GREEN
    if (canonicalStatus === 'RECONCILED' && discMinor === 0n && ageSeconds <= maxAgeSeconds) {
      return {
        status: 'RECONCILED',
        isGreen: true,
        discrepancyMinor: 0n,
        discrepancyUsd: 0,
        lastRunAt: runAtDate.toISOString(),
        ageSeconds,
        message: `External Binance balance and internal PostgreSQL ledger verified in exact balance ($0.00 discrepancy, ${Math.round(ageSeconds)}s ago).`
      };
    }

    // Fail closed fallback -> RED
    return {
      status: 'UNVERIFIED',
      isGreen: false,
      discrepancyMinor: discMinor,
      discrepancyUsd: discUsd,
      lastRunAt: runAtDate.toISOString(),
      ageSeconds,
      message: `Reconciliation status '${canonicalStatus}' is not eligible for live execution. Fail-closed.`
    };
  } catch (err: any) {
    return {
      status: 'ERROR',
      isGreen: false,
      discrepancyMinor: 0n,
      discrepancyUsd: 0,
      lastRunAt: null,
      ageSeconds: null,
      message: `Failed querying treasury_reconciliations table: ${err.message}. Fail closed.`
    };
  }
}
