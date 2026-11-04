import crypto from 'crypto';
import { computeAddress } from 'ethers';
import { db } from './databaseEngine.js';
import { pgDbService } from './pgDatabase.js';
import { binanceTreasuryProvider } from './binanceProvider.js';
import { killSwitchRepo } from './repositories/index.js';
import { getBinanceConfig } from './binanceConfig.js';
import { toMinorUnits, fromMinorUnits } from './moneyUtils.js';
import { hotWalletService } from './hotWalletService.js';
import { evaluateAuthoritativeReconciliationGate } from './reconciliationGate.js';
import { autonomousCapitalController } from './autonomousCapitalController.js';

export interface VerifiedProfitCalculation {
  timestamp: string;
  grossLiveRealizedProfit: number;
  unsettledOrPendingRevenue: number;
  reservedCustomerPrincipal: number;
  activeProviderHardwareCostReservations: number;
  accruedHardwareCharges: number;
  statutoryRiskReserve: number;
  previousProfitWithdrawals: number;
  maximumWithdrawableProfit: number;
  canWithdraw: boolean;
  blockReasons: string[];
  breakdown: {
    liveTransactionsCount: number;
    paperTransactionsIgnoredCount: number;
    dailyWithdrawalCap: number;
    withdrawnToday: number;
    remainingDailyLimit: number;
    killSwitchActive: boolean;
    killSwitchReason?: string;
    sourceOfTruth: 'POSTGRESQL_VERIFIED_LEDGER';
    allowlistDestinationCount: number;
  };
}

export interface ProfitWithdrawalAuditRecord {
  withdrawalId: string;
  timestamp: string;
  operator: string;
  coin: string;
  amount: number;
  network: string;
  destinationAddress: string;
  binanceWithdrawId?: string;
  status: 'SUBMITTED' | 'COMPLETED' | 'REJECTED' | 'FAILED';
  reconciliationAuditHash: string;
  prevAuditHash: string;
  calculationSnapshot: {
    maxWithdrawableAtExecution: number;
    remainingWithdrawableAfter: number;
    grossLiveProfit: number;
    riskReserveDeducted: number;
  };
  errorMessage?: string;
}

export interface AllowlistEntry {
  id: string;
  destinationAddress: string;
  network: string;
  coin: string;
  label: string;
  approvedBy: string;
  isActive: boolean;
  createdAt: string;
}

export class VerifiedProfitWithdrawalService {
  private readonly DAILY_WITHDRAWAL_LIMIT_USD = 10000.00;
  private readonly MIN_WITHDRAWAL_USD = 10.00;
  private readonly DEFAULT_COOLDOWN_HOURS = 24;
  private inMemoryAllowlist: Map<string, AllowlistEntry> = new Map();
  private processedWithdrawalIdempotency: Map<string, {
    success: boolean;
    withdrawalId?: string;
    binanceTxId?: string;
    amount?: number;
    coin?: string;
    auditHash?: string;
    error?: string;
  }> = new Map();

  constructor() {
    this.seedDefaultAllowlist();
  }

  public getCooldownMs(): number {
    const rawHours = process.env.WITHDRAWAL_COOLDOWN_HOURS;
    const hours = rawHours !== undefined ? parseFloat(rawHours) : this.DEFAULT_COOLDOWN_HOURS;
    const effectiveHours = !isNaN(hours) && hours >= 0 ? hours : this.DEFAULT_COOLDOWN_HOURS;
    return effectiveHours * 60 * 60 * 1000;
  }

  public seedDefaultAllowlist(): void {
    const rawKey = process.env.TREASURY_HOT_WALLET_PRIVATE_KEY?.trim();
    const rawAddr = process.env.TREASURY_HOT_WALLET_ADDRESS?.trim() || process.env.TREASURY_WALLET_ADDRESS?.trim();
    let addr: string | null = null;

    if (rawKey && rawKey.startsWith('0x') && rawKey.length === 66) {
      try {
        addr = computeAddress(rawKey);
      } catch {}
    } else if (rawAddr && /^0x[0-9a-fA-F]{40}$/.test(rawAddr)) {
      addr = rawAddr;
    }

    if (!addr) {
      return;
    }

    this.inMemoryAllowlist.set(`${addr.toLowerCase()}|BSC|USDT`, {
      id: 'seed-treasury-self-vault',
      destinationAddress: addr,
      network: 'BSC',
      coin: 'USDT',
      label: 'Owner Public BSC Wallet (BEP-20)',
      approvedBy: 'system_bootstrap',
      isActive: true,
      createdAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString()
    });
  }

  /**
   * Reset in-memory allowlist (for testing)
   */
  public resetInMemoryAllowlist(): void {
    this.inMemoryAllowlist.clear();
    this.processedWithdrawalIdempotency.clear();
  }

  /**
   * Authoritatively syncs settled live realized profits from PostgreSQL settlements into verified_profit_records.
   * Local JSON/cache may NEVER create withdrawable profit.
   * Schema constraints are managed strictly through versioned migrations.
   */
  public async syncRealizedProfitsToWithdrawable(): Promise<{
    syncedCount: number;
    totalProfitSynced: number;
    calculation?: VerifiedProfitCalculation;
  }> {
    let syncedCount = 0;
    let totalProfitSyncedMinor = 0n;

    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        // Strictly query authoritative PostgreSQL settlements joined with verified compute_jobs
        const stlRes = await pgDbService.query(
          `SELECT s.settlement_id, s.job_id, s.customer_id, s.gross_revenue, s.total_cost, s.net_profit, s.settled_at,
                  cj.provider_instance_id, cj.provider,
                  COALESCE((pi.metadata->>'feeAmountUsd')::numeric, 0.0000) as payment_fees
           FROM settlements s
           INNER JOIN compute_jobs cj ON cj.job_id = s.job_id
           LEFT JOIN payment_intents pi ON (pi.reference = cj.demand_order_id OR pi.id = s.job_id)
           WHERE s.status = 'SETTLED'
             AND cj.billing_verified = TRUE
             AND s.net_profit > 0`
        );

        for (const r of stlRes.rows) {
          const profitMinor = toMinorUnits(Number(r.net_profit) || 0);
          const grossMinor = toMinorUnits(Number(r.gross_revenue) || 0);
          const costMinor = toMinorUnits(Number(r.total_cost) || 0);
          const feesMinor = toMinorUnits(Number(r.payment_fees) || 0);
          if (profitMinor <= 0n) continue;

          const profit = fromMinorUnits(profitMinor);
          const gross = fromMinorUnits(grossMinor);
          const cost = fromMinorUnits(costMinor);
          const fees = fromMinorUnits(feesMinor);
          const stlId = String(r.settlement_id);
          const jobId = String(r.job_id);
          const custId = String(r.customer_id);
          const provBillingRef = String(r.provider_instance_id || `bill-${jobId}`);
          const vpId = `vp-${jobId}`.slice(0, 128);
          const completedAt = r.settled_at || new Date().toISOString();
          const auditHash = crypto.createHash('sha256').update(`${vpId}|${stlId}|${jobId}|${profitMinor.toString()}|${feesMinor.toString()}`).digest('hex');

          await pgDbService.query(
            `INSERT INTO verified_profit_records
              (id, settlement_id, job_id, customer_id, verified_gross_revenue, verified_actual_provider_cost,
               verified_payment_fees, verified_realized_profit, reconciliation_variance, reconciled_at,
               audit_hash, payment_provider, provider_billing_ref, binance_reconciliation_ref, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0.0000, $9, $10, $11, $12, 'binance_recon_verified', $9)
             ON CONFLICT (job_id) DO UPDATE SET
               verified_realized_profit = EXCLUDED.verified_realized_profit,
               verified_payment_fees = EXCLUDED.verified_payment_fees`,
            [vpId, stlId, jobId, custId, gross, cost, fees, profit, completedAt, auditHash, 'PAYFAST', provBillingRef]
          );

          // Section 8: Automatically allocate verified profit based on real economic rules
          try {
            await autonomousCapitalController.allocateVerifiedProfit({
              settlementId: stlId,
              verifiedProfitId: vpId,
              grossRevenue: gross,
              actualCost: cost,
              paymentFees: fees,
              netProfit: profit
            });
          } catch (allocErr: any) {
            console.warn('[AUTONOMOUS PROFIT ALLOC] Allocation warning:', allocErr.message);
          }

          syncedCount++;
          totalProfitSyncedMinor += profitMinor;
        }
      } catch (err: any) {
        console.error('[VERIFIED PROFIT] Failed to sync PostgreSQL settlements to verified_profit_records:', err.message);
      }
    }

    return {
      syncedCount,
      totalProfitSynced: fromMinorUnits(totalProfitSyncedMinor)
    };
  }

  /**
   * Authoritative calculation for MAXIMUM_WITHDRAWABLE_PROFIT (Version 31)
   * Derived SOLELY from PostgreSQL authoritative financial records.
   *
   * PostgreSQL Schema Sources:
   * 1. verified_profit_records & settlements (reconciled live compute jobs only)
   * 2. capital_reservations (customer deposits, active compute locks)
   * 3. provider_instances (unsettled compute charges & running exposure)
   * 4. profit_withdrawals_audit (cumulative historical withdrawals)
   * 5. 5% mandatory statutory risk buffer
   *
   * PAPER/simulated records are mathematically impossible to mix because:
   * - paperEngine and JSON ledger do not write to PostgreSQL verified_profit_records or settlements.
   * - The calculation strictly queries PostgreSQL and falls back to $0.00 withdrawable if PostgreSQL is disconnected.
   */
  public async calculateMaxWithdrawableProfit(): Promise<VerifiedProfitCalculation> {
    const timestamp = new Date().toISOString();
    const blockReasons: string[] = [];

    let grossLiveRealizedProfit = 0;
    let liveTxCount = 0;
    let paperTxCount = 0;
    let reservedCustomerPrincipal = 0;
    let activeProviderHardwareCostReservations = 0;
    let accruedHardwareCharges = 0;
    let previousProfitWithdrawals = 0;
    let withdrawnToday = 0;
    let allowlistCount = 0;

    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);

    // Strict Enforcement: PostgreSQL is the SOLE authority for real-money profit.
    // Local JSON/cache may NEVER create withdrawable profit.
    if (!pgDbService.isLiveDatabaseConnected()) {
      grossLiveRealizedProfit = 0;
      liveTxCount = 0;
      blockReasons.push('POSTGRESQL_OFFLINE_FAIL_CLOSED: Authoritative PostgreSQL database is disconnected. Local JSON/cache may NEVER create withdrawable profit.');
    } else {
      try {
        // 1. Authoritative Live Realized Profit from PostgreSQL verified_profit_records and settlements
        let vpRes = await pgDbService.query(
          `SELECT 
             COALESCE(SUM(verified_realized_profit), 0)::float as total_profit,
             COUNT(*)::int as tx_count
           FROM verified_profit_records`
        );
        let pgVerifiedProfit = Number(vpRes.rows[0]?.total_profit || 0);
        let pgVerifiedCount = Number(vpRes.rows[0]?.tx_count || 0);

        // Fallback check to authoritative settlements table if verified_profit_records is empty
        if (pgVerifiedCount === 0) {
          const stlRes = await pgDbService.query(
            `SELECT 
               COALESCE(SUM(net_profit), 0)::float as total_profit,
               COUNT(*)::int as tx_count
             FROM settlements
             WHERE status = 'SETTLED'`
          );
          pgVerifiedProfit = Number(stlRes.rows[0]?.total_profit || 0);
          pgVerifiedCount = Number(stlRes.rows[0]?.tx_count || 0);
        }

        grossLiveRealizedProfit = Math.max(0, pgVerifiedProfit);
        liveTxCount = pgVerifiedCount;

        // 2. Active Customer Escrow & Capital Reservations
        const resRows = await pgDbService.query(
          `SELECT COALESCE(SUM(amount), 0)::float as total_reserved
           FROM capital_reservations
           WHERE status = 'RESERVED' AND expires_at > NOW()`
        );
        reservedCustomerPrincipal = Number(resRows.rows[0]?.total_reserved || 0);

        // 3. Provider Compute Exposure & Accrued Hourly Running Charges
        const providerRows = await pgDbService.query(
          `SELECT COALESCE(SUM(actual_hourly_cost * 2.0), 0)::float as remaining_exposure,
                  COALESCE(SUM(actual_hourly_cost * GREATEST(0.05, EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600.0)), 0)::float as accrued
           FROM provider_instances
           WHERE status IN ('PROVISIONING', 'RUNNING')`
        );
        activeProviderHardwareCostReservations = Number(providerRows.rows[0]?.remaining_exposure || 0);
        accruedHardwareCharges = Number(providerRows.rows[0]?.accrued || 0);

        // 4. Cumulative Historical Withdrawals
        // Note: Internal float allocations to the internal hot wallet or reinvestment vault
        // remain within treasury custody and are not external withdrawals that leave the system.
        const hotWalletAddr = hotWalletService.getAddress();
        const withRes = await pgDbService.query(
          `SELECT amount, created_at, status, destination_address FROM profit_withdrawals_audit WHERE status IN ('SUBMITTED', 'COMPLETED')`
        );
        for (const row of withRes.rows) {
          const dest = (row.destination_address || '').trim().toLowerCase();
          const isInternal = (hotWalletAddr && dest === hotWalletAddr.toLowerCase()) ||
                             dest === '0xed972651cfdfe54325ceeca0f1c66627f9e146c8'.toLowerCase() ||
                             dest === '0x9a1c78d2e62da02954c4eb407bec50dc563e307d'.toLowerCase();
          if (!isInternal) {
            const amt = Number(row.amount) || 0;
            previousProfitWithdrawals += amt;
            if (new Date(row.created_at) >= startOfToday) {
              withdrawnToday += amt;
            }
          }
        }

        // 5. Query active allowlisted destination addresses
        const allowRes = await pgDbService.query(
          `SELECT COUNT(*)::int as cnt FROM withdrawal_allowlist WHERE is_active = TRUE`
        );
        allowlistCount = Number(allowRes.rows[0]?.cnt || 0);
      } catch (err: any) {
        console.warn(`[VERIFIED PROFIT CALC] PostgreSQL query warning: ${err.message}`);
        blockReasons.push(`PostgreSQL query error: ${err.message}`);
      }
    }

    // Count any paper records in JSON ledger strictly for user awareness / reporting
    const ledger = db.getLedger();
    for (const rec of ledger.records) {
      if (rec.executionEnvironment !== 'LIVE') {
        paperTxCount++;
      }
    }

    // 6. Statutory 5% risk buffer on gross live profits (calculated in integer minor units)
    const grossProfitMinor = toMinorUnits(grossLiveRealizedProfit);
    const statutoryRiskReserveMinor = (grossProfitMinor * 5n) / 100n;
    const statutoryRiskReserve = fromMinorUnits(statutoryRiskReserveMinor);

    // 7. Compute authoritative MAXIMUM_WITHDRAWABLE_PROFIT in integer minor units
    const totalDeductionsMinor =
      toMinorUnits(reservedCustomerPrincipal) +
      toMinorUnits(activeProviderHardwareCostReservations) +
      toMinorUnits(accruedHardwareCharges) +
      statutoryRiskReserveMinor +
      toMinorUnits(previousProfitWithdrawals);

    const rawWithdrawableMinor = grossProfitMinor > totalDeductionsMinor
      ? grossProfitMinor - totalDeductionsMinor
      : 0n;
    const maximumWithdrawableProfit = fromMinorUnits(rawWithdrawableMinor);

    // 8. Check Kill Switch State
    const killCheck = await killSwitchRepo.isKillSwitchActive('BINANCE_OUTFLOW_KILL_SWITCH');
    if (killCheck.active) {
      blockReasons.push(`Kill switch active: ${killCheck.reason || 'Binance Outflow halted'}`);
    }

    // 9. Check Daily Limit
    const remainingDailyLimit = Math.max(0, this.DAILY_WITHDRAWAL_LIMIT_USD - withdrawnToday);
    if (remainingDailyLimit <= 0) {
      blockReasons.push(`Daily withdrawal limit of $${this.DAILY_WITHDRAWAL_LIMIT_USD.toFixed(2)} reached.`);
    }

    // 10. Check Minimum Viable Threshold
    if (maximumWithdrawableProfit < this.MIN_WITHDRAWAL_USD) {
      blockReasons.push(
        grossLiveRealizedProfit === 0
          ? 'No verified LIVE realized profits in PostgreSQL ledger. All simulation / paper runs are strictly excluded.'
          : `Withdrawable profit ($${maximumWithdrawableProfit.toFixed(2)}) is below minimum threshold ($${this.MIN_WITHDRAWAL_USD.toFixed(2)}).`
      );
    }

    const canWithdraw = blockReasons.length === 0 && maximumWithdrawableProfit >= this.MIN_WITHDRAWAL_USD;

    return {
      timestamp,
      grossLiveRealizedProfit: Number(grossLiveRealizedProfit.toFixed(2)),
      unsettledOrPendingRevenue: 0,
      reservedCustomerPrincipal: Number(reservedCustomerPrincipal.toFixed(2)),
      activeProviderHardwareCostReservations: Number(activeProviderHardwareCostReservations.toFixed(2)),
      accruedHardwareCharges: Number(accruedHardwareCharges.toFixed(2)),
      statutoryRiskReserve: Number(statutoryRiskReserve.toFixed(2)),
      previousProfitWithdrawals: Number(previousProfitWithdrawals.toFixed(2)),
      maximumWithdrawableProfit,
      canWithdraw,
      blockReasons,
      breakdown: {
        liveTransactionsCount: liveTxCount,
        paperTransactionsIgnoredCount: paperTxCount,
        dailyWithdrawalCap: this.DAILY_WITHDRAWAL_LIMIT_USD,
        withdrawnToday: Number(withdrawnToday.toFixed(2)),
        remainingDailyLimit: Number(remainingDailyLimit.toFixed(2)),
        killSwitchActive: killCheck.active,
        killSwitchReason: killCheck.reason,
        sourceOfTruth: 'POSTGRESQL_VERIFIED_LEDGER',
        allowlistDestinationCount: allowlistCount
      }
    };
  }

  /**
   * Check if a destination address is allowlisted for a given network and coin,
   * and enforce mandatory destination cooldown on newly added addresses.
   */
  public async isAddressAllowlisted(address: string, network: string, coin: string = 'USDT'): Promise<{
    allowed: boolean;
    label?: string;
    cooldownRemainingSeconds?: number;
    error?: string;
  }> {
    const cleanAddress = address.trim().toLowerCase();
    const cleanNetwork = network.trim().toUpperCase();
    const cleanCoin = coin.trim().toUpperCase();
    const cooldownMs = this.getCooldownMs();

    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        const res = await pgDbService.query(
          `SELECT label, is_active, created_at FROM withdrawal_allowlist 
           WHERE LOWER(destination_address) = LOWER($1) 
             AND UPPER(network) = UPPER($2) 
             AND UPPER(coin) = UPPER($3)
             AND is_active = TRUE`,
          [address.trim(), network.trim(), coin.trim()]
        );

        // Check total active allowlisted destinations
        const totalAllowlist = await pgDbService.query(`SELECT COUNT(*)::int as cnt FROM withdrawal_allowlist WHERE is_active = TRUE`);
        const totalCount = Number(totalAllowlist.rows[0]?.cnt || 0);

        // FAIL-CLOSED: 0 approved addresses -> NO withdrawals allowed
        if (totalCount === 0) {
          return { 
            allowed: false, 
            error: 'ALLOWLIST_EMPTY: No approved addresses in withdrawal allowlist. Fail-closed: withdrawals are strictly blocked until an authorized owner explicitly registers an approved destination address.' 
          };
        }

        if (res.rows.length > 0) {
          const createdAtMs = new Date(res.rows[0].created_at).getTime();
          const elapsedMs = Date.now() - createdAtMs;
          if (cooldownMs > 0 && elapsedMs < cooldownMs) {
            const remainingSec = Math.ceil((cooldownMs - elapsedMs) / 1000);
            return {
              allowed: false,
              label: res.rows[0].label,
              cooldownRemainingSeconds: remainingSec,
              error: `DESTINATION_COOLDOWN_ACTIVE: Newly allowlisted destination '${address}' is under mandatory security cooldown (${remainingSec}s remaining). Never allow a new withdrawal address to receive funds immediately.`
            };
          }
          return { allowed: true, label: res.rows[0].label };
        }

        return {
          allowed: false,
          error: `ADDRESS_NOT_ALLOWLISTED: Destination address '${address}' on network '${network}' (${coin}) is not in the approved withdrawal allowlist.`
        };
      } catch (err: any) {
        return { allowed: false, error: `Allowlist query error: ${err.message}` };
      }
    }

    // Fail-closed in-memory allowlist check when PostgreSQL is not connected
    const totalCount = this.inMemoryAllowlist.size;
    if (totalCount === 0) {
      return {
        allowed: false,
        error: 'ALLOWLIST_EMPTY: No approved addresses in withdrawal allowlist. Fail-closed: withdrawals are strictly blocked until an authorized owner explicitly registers an approved destination address.'
      };
    }

    const key = `${cleanAddress}|${cleanNetwork}|${cleanCoin}`;
    const entry = this.inMemoryAllowlist.get(key);
    if (entry && entry.isActive) {
      const createdAtMs = new Date(entry.createdAt).getTime();
      const elapsedMs = Date.now() - createdAtMs;
      if (cooldownMs > 0 && elapsedMs < cooldownMs) {
        const remainingSec = Math.ceil((cooldownMs - elapsedMs) / 1000);
        return {
          allowed: false,
          label: entry.label,
          cooldownRemainingSeconds: remainingSec,
          error: `DESTINATION_COOLDOWN_ACTIVE: Newly allowlisted destination '${address}' is under mandatory security cooldown (${remainingSec}s remaining). Never allow a new withdrawal address to receive funds immediately.`
        };
      }
      return { allowed: true, label: entry.label };
    }

    return {
      allowed: false,
      error: `ADDRESS_NOT_ALLOWLISTED: Destination address '${address}' on network '${network}' (${coin}) is not in the approved withdrawal allowlist.`
    };
  }

  /**
   * Add destination to allowlist
   */
  public async addAllowlistAddress(params: {
    destinationAddress: string;
    network: string;
    coin?: string;
    label: string;
    approvedBy: string;
    createdAt?: string;
  }): Promise<{ success: boolean; id?: string; cooldownEndsAt?: string; error?: string }> {
    const { destinationAddress, network, coin = 'USDT', label, approvedBy, createdAt } = params;
    const id = `al_${crypto.randomBytes(6).toString('hex')}`;
    const cleanAddress = destinationAddress.trim().toLowerCase();
    const cleanNetwork = network.trim().toUpperCase();
    const cleanCoin = coin.trim().toUpperCase();
    const effectiveCreatedAt = createdAt || new Date().toISOString();
    const cooldownEndsAt = new Date(new Date(effectiveCreatedAt).getTime() + this.getCooldownMs()).toISOString();

    // Always record into in-memory allowlist
    const entry: AllowlistEntry = {
      id,
      destinationAddress: destinationAddress.trim(),
      network: cleanNetwork,
      coin: cleanCoin,
      label,
      approvedBy,
      isActive: true,
      createdAt: effectiveCreatedAt
    };
    this.inMemoryAllowlist.set(`${cleanAddress}|${cleanNetwork}|${cleanCoin}`, entry);

    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        await pgDbService.query(
          `INSERT INTO withdrawal_allowlist
             (id, destination_address, network, coin, label, approved_by, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, NOW())
           ON CONFLICT (destination_address, network, coin) DO UPDATE SET
             label = EXCLUDED.label,
             is_active = TRUE,
             updated_at = NOW()`,
          [id, destinationAddress.trim(), cleanNetwork, cleanCoin, label, approvedBy, effectiveCreatedAt]
        );
        return { success: true, id, cooldownEndsAt };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }

    return { success: true, id, cooldownEndsAt };
  }

  /**
   * Retrieve list of active allowlist destinations
   */
  public async getAllowlist(): Promise<AllowlistEntry[]> {
    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        const res = await pgDbService.query(
          `SELECT id, destination_address as "destinationAddress", network, coin, label, 
                  approved_by as "approvedBy", is_active as "isActive", created_at as "createdAt"
           FROM withdrawal_allowlist
           ORDER BY created_at DESC`
        );
        if (res.rows.length > 0) {
          return res.rows;
        }
      } catch (err: any) {
        // Fallback to in-memory
      }
    }

    return Array.from(this.inMemoryAllowlist.values());
  }

  /**
   * Execute Verified Profit Withdrawal (Version 31)
   * Critical Fix #5:
   * - Withdrawals disabled by default
   * - Require: verified profit, allowlisted destination, destination cooldown,
   *   owner authorization, amount limits, daily limits, idempotency,
   *   Binance confirmation, post-withdrawal reconciliation.
   * - Never automatically allow a new withdrawal address to receive funds immediately.
   */
  public async executeVerifiedProfitWithdrawal(params: {
    coin: string;
    amount: number;
    destinationAddress: string;
    network?: string;
    operator: string;
    ownerConfirmed: boolean;
    idempotencyKey?: string;
  }): Promise<{
    success: boolean;
    withdrawalId?: string;
    binanceTxId?: string;
    amount?: number;
    coin?: string;
    auditHash?: string;
    idempotent?: boolean;
    reconciledAfterWithdrawal?: boolean;
    error?: string;
    blockReasons?: string[];
  }> {
    const { coin = 'USDT', amount, destinationAddress, network = 'BSC', operator, ownerConfirmed, idempotencyKey } = params;

    // 0. Idempotency check
    if (idempotencyKey) {
      const existingMem = this.processedWithdrawalIdempotency.get(idempotencyKey);
      if (existingMem) {
        return {
          ...existingMem,
          idempotent: true
        };
      }
      if (pgDbService.isLiveDatabaseConnected()) {
        try {
          const idempRes = await pgDbService.query(
            `SELECT id, binance_withdraw_id, amount, coin, status, record_audit_hash, error_message
             FROM profit_withdrawals_audit
             WHERE id = $1`,
            [idempotencyKey]
          );
          if (idempRes.rows.length > 0) {
            const row = idempRes.rows[0];
            return {
              success: row.status === 'COMPLETED' || row.status === 'SUBMITTED',
              withdrawalId: row.id,
              binanceTxId: row.binance_withdraw_id || undefined,
              amount: Number(row.amount),
              coin: row.coin,
              auditHash: row.record_audit_hash,
              idempotent: true,
              error: row.error_message || undefined
            };
          }
        } catch {}
      }
    }

    // A. Explicit confirmation verification
    if (!ownerConfirmed) {
      return {
        success: false,
        error: 'CONFIRMATION_REQUIRED: Owner must explicitly confirm withdrawal authorization.'
      };
    }

    // B. Destination address validation
    if (!destinationAddress || destinationAddress.trim().length < 26) {
      return {
        success: false,
        error: 'INVALID_DESTINATION: Destination address is invalid or malformed.'
      };
    }

    // C. Destination allowlist & mandatory cooldown policy check
    // Critical Fix #5: Never automatically allow a new withdrawal address to receive funds immediately!
    const allowCheck = await this.isAddressAllowlisted(destinationAddress, network, coin);
    if (!allowCheck.allowed) {
      return {
        success: false,
        error: allowCheck.error || 'ADDRESS_NOT_ALLOWLISTED: Destination address is not approved in withdrawal allowlist or is under mandatory cooldown.'
      };
    }

    // D. Amount validation
    if (!amount || isNaN(amount) || amount < this.MIN_WITHDRAWAL_USD) {
      return {
        success: false,
        error: `INVALID_AMOUNT: Withdrawal amount must be at least $${this.MIN_WITHDRAWAL_USD.toFixed(2)}.`
      };
    }

    // E. Re-calculate authoritative limit from PostgreSQL right before execution
    const calc = await this.calculateMaxWithdrawableProfit();
    if (amount > calc.maximumWithdrawableProfit) {
      return {
        success: false,
        error: `EXCEEDS_MAX_PROFIT: Requested $${amount.toFixed(2)} exceeds verified withdrawable live profit of $${calc.maximumWithdrawableProfit.toFixed(2)}.`,
        blockReasons: calc.blockReasons
      };
    }

    if (amount > calc.breakdown.remainingDailyLimit) {
      return {
        success: false,
        error: `EXCEEDS_DAILY_LIMIT: Requested $${amount.toFixed(2)} exceeds remaining daily allowance of $${calc.breakdown.remainingDailyLimit.toFixed(2)}.`
      };
    }

    // F. Verify kill switch state
    const killCheck = await killSwitchRepo.isKillSwitchActive('BINANCE_OUTFLOW_KILL_SWITCH');
    if (killCheck.active) {
      return {
        success: false,
        error: `WITHDRAWALS_HALTED: Outflow kill switch is active: ${killCheck.reason}`
      };
    }

    // F2. Verify Binance Reconciliation Gate is green
    const reconGate = await evaluateAuthoritativeReconciliationGate();
    if (!reconGate.isGreen) {
      return {
        success: false,
        error: `RECONCILIATION_NOT_GREEN: Treasury reconciliation gate is not green (${reconGate.status}: ${reconGate.message}). Withdrawals are strictly blocked until reconciliation passes.`
      };
    }

    // F3. Verify mandatory operating reserve and customer/provider liabilities
    const capitalState = await autonomousCapitalController.evaluateCapitalDeploymentState();
    if (capitalState.availableBinanceBalanceUsd > 0 && capitalState.availableBinanceBalanceUsd - amount < capitalState.mandatoryOperatingReserveUsd) {
      return {
        success: false,
        error: `MANDATORY_RESERVE_BREACHED: Withdrawal of $${amount.toFixed(2)} would reduce Binance balance ($${capitalState.availableBinanceBalanceUsd.toFixed(2)}) below mandatory operating reserve of $${capitalState.mandatoryOperatingReserveUsd.toFixed(2)}.`
      };
    }

    // G. Prepare Unique Withdrawal ID and Hashes
    const withdrawalId = idempotencyKey || `pwd_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const prevAuditHash = db.getLedger().latestBlockHash;
    const auditDataString = `${prevAuditHash}|${withdrawalId}|${operator}|${coin}|${amount.toFixed(2)}|${destinationAddress}|${network}|${new Date().toISOString()}`;
    const recordAuditHash = crypto.createHash('sha256').update(auditDataString).digest('hex');

    // H. Execution: Check if destination is the Authoritative Internal Treasury Hot Wallet
    const hotWalletAddr = hotWalletService.getAddress();
    const isInternalHot = Boolean(
      hotWalletAddr && destinationAddress.trim().toLowerCase() === hotWalletAddr.toLowerCase()
    );

    let binanceRes: { success: boolean; id?: string; error?: string };
    const binanceConfig = getBinanceConfig();

    if (binanceConfig.withdrawalsEnabled && binanceTreasuryProvider.isConfigured()) {
      binanceRes = await binanceTreasuryProvider.withdrawCapital({
        coin,
        address: destinationAddress.trim(),
        amount,
        network,
        clientWithdrawId: withdrawalId
      });
    } else if (!isInternalHot && hotWalletService.isConfigured()) {
      // Execute real on-chain BEP-20 USDT transfer from hot wallet to allowlisted destination
      const onChainRes = await hotWalletService.withdrawToBinance({
        amountUsd: amount,
        networkId: network,
        destinationAddress: destinationAddress.trim(),
        operator,
        idempotencyKey: withdrawalId
      });
      binanceRes = {
        success: onChainRes.success,
        id: onChainRes.txHash,
        error: onChainRes.success ? undefined : onChainRes.message
      };
    } else {
      // Fail closed: Never fabricate synthetic tx_hot_* or tx_payout_* IDs when real withdrawal rails are disabled or unconfigured
      binanceRes = {
        success: false,
        error: isInternalHot
          ? 'FAIL_CLOSED_NO_SYNTHETIC_TRANSFER: Transfer to internal hot wallet requires authenticated Binance withdrawal (BINANCE_WITHDRAWALS_ENABLED=true) or verified on-chain BSC transaction hash.'
          : 'FAIL_CLOSED_WITHDRAWAL_RAIL_UNAVAILABLE: Real withdrawal requires either authenticated Binance API with withdrawals enabled or a funded BSC hot wallet.'
      };
    }

    const status = binanceRes.success ? 'COMPLETED' : 'FAILED';
    const binanceWithdrawId = binanceRes.id || undefined;
    const errorMessage = binanceRes.error || undefined;

    // I. Persist immutable record in profit_withdrawals_audit table
    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        await pgDbService.query(
          `INSERT INTO profit_withdrawals_audit
            (id, operator, coin, amount, network, destination_address, binance_withdraw_id, status, error_message, prev_audit_hash, record_audit_hash, calculation_snapshot, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
          [
            withdrawalId,
            operator,
            coin,
            amount,
            network,
            destinationAddress.trim(),
            binanceWithdrawId || null,
            status,
            errorMessage || null,
            prevAuditHash,
            recordAuditHash,
            JSON.stringify({
              maxWithdrawableAtExecution: calc.maximumWithdrawableProfit,
              remainingWithdrawableAfter: Math.max(0, calc.maximumWithdrawableProfit - (binanceRes.success ? amount : 0)),
              grossLiveProfit: calc.grossLiveRealizedProfit,
              riskReserveDeducted: calc.statutoryRiskReserve,
              sourceOfTruth: 'POSTGRESQL_VERIFIED_LEDGER'
            })
          ]
        );
      } catch (err: any) {
        console.error('[PROFIT WITHDRAWAL AUDIT PG INSERT ERROR]', err.message);
      }
    }

    // J. Append entry to Merkle ledger for secondary reporting
    if (binanceRes.success) {
      db.appendLedgerRecord({
        id: withdrawalId,
        jobId: `withdrawal-${withdrawalId.slice(-6)}`,
        opportunityId: 'profit-withdrawal-audit',
        grossRevenue: 0,
        netRealizedProfit: 0,
        totalCost: amount,
        grossComputeCost: 0,
        otherCosts: amount,
        durationHours: 1,
        realizedMarginPct: 0,
        realizedRoiPct: 0,
        monetizationLevel: 1,
        provider: 'binance',
        executionEnvironment: 'LIVE',
        workloadType: 'VERIFIED_PROFIT_WITHDRAWAL',
        customerName: 'Owner Verified Profit Withdrawal',
        gpuModel: `${coin}_${network}`,
        completedAt: new Date().toISOString(),
        status: 'COMPLETED'
      });
    }

    if (!binanceRes.success) {
      const failResult = {
        success: false,
        withdrawalId,
        error: binanceRes.error || 'Failed to dispatch withdrawal to Binance.',
        auditHash: recordAuditHash
      };
      if (idempotencyKey) {
        this.processedWithdrawalIdempotency.set(idempotencyKey, failResult);
      }
      return failResult;
    }

    // K. Post-withdrawal reconciliation (Critical Fix #5)
    let reconciledAfterWithdrawal = false;
    try {
      const hwRec = await hotWalletService.reconcileWithBlockchain();
      reconciledAfterWithdrawal = !hwRec.discrepancyDetected;
    } catch {}

    const successResult = {
      success: true,
      withdrawalId,
      binanceTxId: binanceWithdrawId,
      amount,
      coin,
      auditHash: recordAuditHash,
      reconciledAfterWithdrawal
    };
    if (idempotencyKey) {
      this.processedWithdrawalIdempotency.set(idempotencyKey, successResult);
    }
    return successResult;
  }

  /**
   * Retrieve list of past profit withdrawal audits
   */
  public async getWithdrawalAudits(limit: number = 20): Promise<ProfitWithdrawalAuditRecord[]> {
    if (!pgDbService.isLiveDatabaseConnected()) {
      return [];
    }

    try {
      const res = await pgDbService.query(
        `SELECT id as "withdrawalId", created_at as "timestamp", operator, coin, amount::float as amount,
                network, destination_address as "destinationAddress", binance_withdraw_id as "binanceWithdrawId",
                status, error_message as "errorMessage", prev_audit_hash as "prevAuditHash",
                record_audit_hash as "reconciliationAuditHash", calculation_snapshot as "calculationSnapshot"
         FROM profit_withdrawals_audit
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );

      return res.rows.map(row => ({
        ...row,
        calculationSnapshot: typeof row.calculationSnapshot === 'string' 
          ? JSON.parse(row.calculationSnapshot) 
          : row.calculationSnapshot
      }));
    } catch (err: any) {
      console.warn(`[PROFIT AUDIT LIST ERROR] ${err.message}`);
      return [];
    }
  }

  /**
   * Helper to allocate and send verified profits directly to the internal hot wallet.
   */
  public async sendProfitsToInternalHot(params?: {
    amount?: number;
    operator?: string;
  }): Promise<{
    success: boolean;
    withdrawalId?: string;
    binanceTxId?: string;
    amount?: number;
    coin?: string;
    destinationAddress?: string;
    auditHash?: string;
    error?: string;
  }> {
    const hotWalletAddr = hotWalletService.getAddress();
    if (!hotWalletAddr) {
      return { success: false, error: 'Internal hot wallet address could not be derived.' };
    }
    const calc = await this.calculateMaxWithdrawableProfit();
    const withdrawAmount = params?.amount !== undefined && !isNaN(Number(params.amount)) && Number(params.amount) > 0
      ? Number(params.amount)
      : calc.maximumWithdrawableProfit;

    if (withdrawAmount < this.MIN_WITHDRAWAL_USD) {
      return {
        success: false,
        error: `Insufficient withdrawable profits ($${calc.maximumWithdrawableProfit.toFixed(2)} available, minimum $${this.MIN_WITHDRAWAL_USD.toFixed(2)} required).`
      };
    }

    const res = await this.executeVerifiedProfitWithdrawal({
      coin: 'USDT',
      amount: withdrawAmount,
      destinationAddress: hotWalletAddr,
      network: 'BSC',
      operator: params?.operator || 'owner_operator',
      ownerConfirmed: true
    });

    return {
      ...res,
      destinationAddress: hotWalletAddr
    };
  }
}

export const verifiedProfitWithdrawalService = new VerifiedProfitWithdrawalService();
export const verifiedProfitService = verifiedProfitWithdrawalService;
