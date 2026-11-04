import crypto from 'crypto';
import { pgDbService } from './pgDatabase.js';
import { toMinorUnits, fromMinorUnits, SupportedCurrency, CanonicalReconciliationStatus } from './moneyUtils.js';
import { binanceProvider } from './binanceProvider.js';
import { reconciliationRepo, auditRepo, killSwitchRepo } from './repositories/index.js';
import { circuitBreakerService } from './circuitBreaker.js';
import { treasuryEngine } from './treasuryEngine.js';

export interface CanonicalReconciliationRun {
  runId: string;
  runAt: string;
  currency: SupportedCurrency;
  ledgerBalanceMinor: bigint;
  externalBalanceMinor: bigint | null;
  discrepancyMinor: bigint | null;
  status: CanonicalReconciliationStatus;
  autonomousCapitalDeploymentAllowed: boolean;
  reason: string;
  externalSource: string;
  verifiedBy: string;
  ageSeconds?: number;
}

export interface AuthoritativeReconciliationGateResult {
  isGreen: boolean;
  canDeployCapital: boolean;
  status: CanonicalReconciliationStatus;
  discrepancyCents: number;
  discrepancyUsd: number;
  lastReconciliationAt: string | null;
  ageSeconds: number | null;
  externalSource: string | null;
  reason: string;
  message: string;
}

/**
 * Canonical Reconciliation Service
 * Single consolidated authority for treasury reconciliation, ledger auditing,
 * and fail-closed gate evaluation.
 */
export class CanonicalReconciliationService {
  private static instance: CanonicalReconciliationService;
  private lastRun: CanonicalReconciliationRun | null = null;
  private readonly RECONCILIATION_FRESHNESS_SLA_SECONDS = 300; // 5 minutes max age for green gate

  public static getInstance(): CanonicalReconciliationService {
    if (!CanonicalReconciliationService.instance) {
      CanonicalReconciliationService.instance = new CanonicalReconciliationService();
    }
    return CanonicalReconciliationService.instance;
  }

  /**
   * Evaluates the single authoritative reconciliation gate for the entire system.
   * STRICT CRITERIA FOR GREEN:
   * 1. PostgreSQL live and connected
   * 2. Most recent reconciliation record exists in treasury_reconciliations table
   * 3. Status is strictly 'RECONCILED'
   * 4. Discrepancy is EXACTLY 0 cents
   * 5. Record was completed within the freshness SLA (< 300s)
   */
  public async evaluateGate(maxAgeSeconds: number = this.RECONCILIATION_FRESHNESS_SLA_SECONDS): Promise<AuthoritativeReconciliationGateResult> {
    if (!pgDbService.isLiveDatabaseConnected()) {
      return {
        isGreen: false,
        canDeployCapital: false,
        status: 'UNVERIFIED',
        discrepancyCents: 0,
        discrepancyUsd: 0,
        lastReconciliationAt: null,
        ageSeconds: null,
        externalSource: null,
        reason: 'POSTGRESQL_OFFLINE',
        message: 'PostgreSQL database offline. Cannot verify reconciliation against authoritative ledger. Live execution blocked.'
      };
    }

    try {
      const res = await pgDbService.query(
        `SELECT id, run_at, provider, external_balance_minor, internal_ledger_balance_minor,
                discrepancy_minor, status, reason
         FROM treasury_reconciliations
         ORDER BY run_at DESC
         LIMIT 1`
      );

      if (res.rows.length === 0) {
        return {
          isGreen: false,
          canDeployCapital: false,
          status: 'UNVERIFIED',
          discrepancyCents: 0,
          discrepancyUsd: 0,
          lastReconciliationAt: null,
          ageSeconds: null,
          externalSource: null,
          reason: 'NO_RECONCILIATION_HISTORY',
          message: 'No prior reconciliation record found in PostgreSQL ledger. Initial Binance-to-ledger reconciliation required before live capital deployment.'
        };
      }

      const row = res.rows[0];
      const runAt = new Date(row.run_at);
      const now = new Date();
      const ageSeconds = Math.max(0, (now.getTime() - runAt.getTime()) / 1000);

      const discrepancyMinor = BigInt(row.discrepancy_minor ?? '0');
      const rawStatus = (row.status || '').toUpperCase() as CanonicalReconciliationStatus;
      const discrepancyCents = Number(discrepancyMinor);
      const discrepancyUsd = fromMinorUnits(discrepancyMinor);

      if (rawStatus === 'DISCREPANCY' || discrepancyMinor !== 0n) {
        return {
          isGreen: false,
          canDeployCapital: false,
          status: 'DISCREPANCY',
          discrepancyCents,
          discrepancyUsd,
          lastReconciliationAt: row.run_at,
          ageSeconds,
          externalSource: row.provider,
          reason: 'LEDGER_DISCREPANCY_DETECTED',
          message: `Reconciliation discrepancy of $${Math.abs(discrepancyUsd).toFixed(2)} detected in authoritative ledger. Fail closed. Live capital deployment blocked.`
        };
      }

      if (rawStatus === 'UNVERIFIED') {
        return {
          isGreen: false,
          canDeployCapital: false,
          status: 'UNVERIFIED',
          discrepancyCents,
          discrepancyUsd,
          lastReconciliationAt: row.run_at,
          ageSeconds,
          externalSource: row.provider,
          reason: 'TREASURY_UNVERIFIED',
          message: `Authoritative treasury is UNVERIFIED (${row.reason || 'External feed unconfirmed'}). Live capital deployment blocked.`
        };
      }

      if (ageSeconds > maxAgeSeconds) {
        return {
          isGreen: false,
          canDeployCapital: false,
          status: 'STALE',
          discrepancyCents,
          discrepancyUsd,
          lastReconciliationAt: row.run_at,
          ageSeconds,
          externalSource: row.provider,
          reason: 'RECONCILIATION_STALE',
          message: `Last reconciliation is stale (${Math.round(ageSeconds)}s ago > ${maxAgeSeconds}s SLA). Fresh reconciliation required. Live execution blocked.`
        };
      }

      if (rawStatus !== 'RECONCILED') {
        return {
          isGreen: false,
          canDeployCapital: false,
          status: rawStatus,
          discrepancyCents,
          discrepancyUsd,
          lastReconciliationAt: row.run_at,
          ageSeconds,
          externalSource: row.provider,
          reason: `NON_RECONCILED_STATUS_${rawStatus}`,
          message: `Reconciliation status is '${rawStatus}', not 'RECONCILED'. Live capital deployment blocked.`
        };
      }

      // GREEN: All criteria satisfied
      return {
        isGreen: true,
        canDeployCapital: true,
        status: 'RECONCILED',
        discrepancyCents: 0,
        discrepancyUsd: 0,
        lastReconciliationAt: row.run_at,
        ageSeconds,
        externalSource: row.provider,
        reason: 'RECONCILED_ZERO_DISCREPANCY',
        message: `Authoritative reconciliation GREEN. 0 cents discrepancy against ${row.provider} within ${Math.round(ageSeconds)}s fresh window.`
      };
    } catch (err: any) {
      return {
        isGreen: false,
        canDeployCapital: false,
        status: 'ERROR',
        discrepancyCents: 0,
        discrepancyUsd: 0,
        lastReconciliationAt: null,
        ageSeconds: null,
        externalSource: null,
        reason: 'RECONCILIATION_QUERY_ERROR',
        message: `Failed querying treasury_reconciliations table: ${err.message}. Fail closed.`
      };
    }
  }

  /**
   * Executes authoritative treasury reconciliation run strictly comparing Binance crypto spot balances
   * against PostgreSQL double-entry treasury accounts and ledger records.
   */
  public async runAuthoritativeReconciliation(options: {
    currency?: SupportedCurrency;
    verifiedBy: string;
    injectDiscrepancyMinor?: bigint;
  }): Promise<CanonicalReconciliationRun> {
    const currency = options.currency || 'USD';
    const runId = `rec_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const runAt = new Date().toISOString();

    // 1. Authoritative Ledger balance in minor units from PostgreSQL or in-memory treasury ledger
    let ledgerBalanceMinor = 0n;
    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        const acctRes = await pgDbService.query(
          `SELECT COALESCE(
             SUM(CASE WHEN direction = 'DEBIT' THEN quantity ELSE -quantity END), 0
           )::text as balance
           FROM treasury_ledger
           WHERE (asset = $1 OR ($1 = 'USD' AND asset IN ('USDT', 'USDC'))) AND provider = 'binance'`,
          [currency]
        );
        const balStr = acctRes.rows[0]?.balance || '0';
        ledgerBalanceMinor = toMinorUnits(balStr);
      } catch (err: any) {
        console.error('[CANONICAL RECONCILIATION] Failed querying treasury_ledger balance:', err.message);
      }
    } else {
      ledgerBalanceMinor = await treasuryEngine.getInternalLedgerBalance('binance', currency === 'USD' ? 'USDT' : currency);
    }

    let externalBalanceMinor: bigint | null = null;
    let externalSource = 'BINANCE';

    // 2. Authoritative check strictly via Binance institutional crypto treasury rail
    if (binanceProvider.isConfigured()) {
      try {
        const binanceConn = await binanceProvider.verifyConnection();
        if (binanceConn.connected && binanceConn.status === 'VERIFIED') {
          const binanceBalances = await binanceProvider.getBalances();
          const matchBal = binanceBalances.find(b =>
            b.asset.toUpperCase() === currency.toUpperCase() ||
            (currency.toUpperCase() === 'USD' && (b.asset.toUpperCase() === 'USDT' || b.asset.toUpperCase() === 'USDC'))
          );
          if (matchBal) {
            externalBalanceMinor = matchBal.totalMinor;
            externalSource = `BINANCE_SPOT_${matchBal.asset}`;
          } else {
            externalBalanceMinor = 0n;
            externalSource = 'BINANCE_SPOT_ZERO_BALANCE';
          }
        } else {
          console.warn('[CANONICAL RECONCILIATION] Binance preflight not verified:', binanceConn.error || binanceConn.status);
        }
      } catch (err: any) {
        console.warn('[CANONICAL RECONCILIATION] Binance query exception:', err.message);
      }
    }

    // Support test discrepancy injection for launch scenario verification
    const isSyntheticTestProbe = options.injectDiscrepancyMinor !== undefined && options.injectDiscrepancyMinor !== 0n;
    if (isSyntheticTestProbe) {
      externalBalanceMinor = (externalBalanceMinor ?? 0n) + options.injectDiscrepancyMinor!;
      externalSource = 'BINANCE_SPOT_TEST_DISC';
    }

    // 3. Fail closed if Binance external source is unavailable
    if (externalBalanceMinor === null) {
      const result: CanonicalReconciliationRun = {
        runId,
        runAt,
        currency,
        ledgerBalanceMinor,
        externalBalanceMinor: null,
        discrepancyMinor: null,
        status: 'UNVERIFIED',
        autonomousCapitalDeploymentAllowed: false,
        reason: 'CRITICAL AUDIT ENFORCEMENT: Primary Binance treasury rail is unreachable or unconfigured. External balance cannot be independently verified. Autonomous capital deployment is permanently locked.',
        externalSource: 'BINANCE_UNREACHABLE',
        verifiedBy: options.verifiedBy
      };
      if (!isSyntheticTestProbe) {
        this.lastRun = result;
        await this.persistReconciliationRecord(result);
      }
      return result;
    }

    // 4. Compare ledger balance with authoritative external balance in integer minor units
    const discrepancyMinor = externalBalanceMinor - ledgerBalanceMinor;

    if (discrepancyMinor !== 0n) {
      const result: CanonicalReconciliationRun = {
        runId,
        runAt,
        currency,
        ledgerBalanceMinor,
        externalBalanceMinor,
        discrepancyMinor,
        status: 'DISCREPANCY',
        autonomousCapitalDeploymentAllowed: false,
        reason: `Reconciliation discrepancy of $${fromMinorUnits(discrepancyMinor).toFixed(2)} ${currency} detected between ledger and ${externalSource}. Autonomous deployment locked pending manual audit.`,
        externalSource,
        verifiedBy: options.verifiedBy
      };
      if (!isSyntheticTestProbe) {
        this.lastRun = result;
        await this.persistReconciliationRecord(result);
      }

      // Trip circuit breaker immediately
      await circuitBreakerService.trip(
        'RECONCILIATION_DISCREPANCY_DETECTED',
        `Reconciliation discrepancy of $${fromMinorUnits(discrepancyMinor).toFixed(2)} ${currency} detected against ${externalSource}`
      );

      if (pgDbService.isLiveDatabaseConnected() && !isSyntheticTestProbe) {
        await auditRepo.recordEvent({
          eventType: 'RECONCILIATION_DISCREPANCY_ALERT',
          severity: 'CRITICAL',
          message: `Reconciliation discrepancy of $${fromMinorUnits(discrepancyMinor).toFixed(2)} ${currency} detected. Autonomous deployment locked.`,
          details: {
            runId,
            ledgerBalanceMinor: ledgerBalanceMinor.toString(),
            externalBalanceMinor: externalBalanceMinor.toString(),
            discrepancyMinor: discrepancyMinor.toString(),
            externalSource
          }
        });
      }

      return result;
    }

    // 5. Perfect 0 cents discrepancy match
    const result: CanonicalReconciliationRun = {
      runId,
      runAt,
      currency,
      ledgerBalanceMinor,
      externalBalanceMinor,
      discrepancyMinor: 0n,
      status: 'RECONCILED',
      autonomousCapitalDeploymentAllowed: true,
      reason: `Authoritative reconciliation verified. External ${externalSource} balance matches internal ledger within 0 cents precision.`,
      externalSource,
      verifiedBy: options.verifiedBy
    };
    this.lastRun = result;
    await this.persistReconciliationRecord(result);

    if (pgDbService.isLiveDatabaseConnected()) {
      await auditRepo.recordEvent({
        eventType: 'RECONCILIATION_SUCCEEDED',
        severity: 'INFO',
        message: `Authoritative reconciliation verified for ${currency}. 0 cents discrepancy against ${externalSource}.`,
        details: {
          runId,
          ledgerBalanceMinor: ledgerBalanceMinor.toString(),
          externalBalanceMinor: externalBalanceMinor.toString(),
          externalSource
        }
      });
    }

    return result;
  }

  private async persistReconciliationRecord(res: CanonicalReconciliationRun): Promise<void> {
    if (!pgDbService.isLiveDatabaseConnected()) return;
    try {
      const extMinor = res.externalBalanceMinor !== null ? res.externalBalanceMinor : 0n;
      const ledgerMinor = res.ledgerBalanceMinor;
      const discMinor = res.discrepancyMinor !== null ? res.discrepancyMinor : 0n;

      await pgDbService.query(
        `INSERT INTO treasury_reconciliations
          (id, run_at, provider, external_balance_minor, internal_ledger_balance_minor, discrepancy_minor, status, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          res.runId,
          res.runAt,
          res.externalSource,
          extMinor.toString(),
          ledgerMinor.toString(),
          discMinor.toString(),
          res.status,
          res.reason
        ]
      );

      await reconciliationRepo.recordRun({
        provider: res.externalSource,
        asset: res.currency,
        externalBalance: res.externalBalanceMinor !== null ? fromMinorUnits(res.externalBalanceMinor) : 0,
        internalBalance: fromMinorUnits(res.ledgerBalanceMinor),
        discrepancy: res.discrepancyMinor !== null ? fromMinorUnits(res.discrepancyMinor) : 0,
        status: res.status === 'RECONCILED' ? 'RECONCILED' : res.status === 'DISCREPANCY' ? 'MISMATCH' : 'ERROR',
        reason: res.reason
      });
    } catch (err: any) {
      console.error('[CANONICAL RECONCILIATION] Failed to persist run in PostgreSQL:', err.message);
    }
  }

  public getLastRun(): CanonicalReconciliationRun {
    if (this.lastRun) return this.lastRun;
    return {
      runId: 'initial',
      runAt: new Date().toISOString(),
      currency: 'USD',
      ledgerBalanceMinor: 0n,
      externalBalanceMinor: null,
      discrepancyMinor: null,
      status: 'UNVERIFIED',
      autonomousCapitalDeploymentAllowed: false,
      reason: 'Reconciliation has not yet been executed with external Binance treasury feed. System starts in UNVERIFIED mode.',
      externalSource: 'INITIAL',
      verifiedBy: 'system'
    };
  }
}

export const canonicalReconciliationService = CanonicalReconciliationService.getInstance();
export const evaluateAuthoritativeReconciliationGate = (maxAgeSeconds?: number) =>
  canonicalReconciliationService.evaluateGate(maxAgeSeconds);
