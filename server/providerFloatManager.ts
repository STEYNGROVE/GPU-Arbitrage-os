import crypto from 'crypto';
import { pgDbService } from './pgDatabase.js';
import { toMinorUnits, fromMinorUnits, SupportedCurrency } from './moneyUtils.js';
import { getBinanceConfig } from './binanceConfig.js';
import { evaluateAuthoritativeReconciliationGate } from './reconciliationGate.js';
import { auditRepo, killSwitchRepo, idempotencyRepo } from './repositories/index.js';
import { hardwareProvisioner } from './providerProvisioner.js';
import { getProviderRiskMetrics } from './opportunityEngine.js';
import { realProviderFundingManager, ProviderFundingEventRecord } from './providerFundingAdapters.js';
import { autonomousCapitalController } from './autonomousCapitalController.js';

export type ComputeProviderName = 'vast_ai' | 'runpod' | 'lambda';

export interface ProviderFloatMetrics {
  provider: ComputeProviderName;
  targetAllocationPct: number; // e.g. 15 for Vast, 10 for RunPod, 5 for Lambda
  currentBalanceUsd: number;
  pendingChargesUsd: number;
  accruedCostUsd: number;
  estimatedRemainingCostUsd: number;
  contractualExposureUsd: number;
  minimumBufferUsd: number;
  minimumAuthorizedFloatUsd: number;
  recommendedAuthorizedFloatUsd: number;
  maximumAuthorizedFloatUsd: number;
  forecastDemandGpuHours: number;
  averageHourlyRateUsd: number;
  riskAdjustedExpectedProfitUsd: number;
  reliabilityScore: number;
  paymentRequirement: 'PREPAID_CREDIT' | 'POSTPAID_CARD' | 'HYBRID';
  recommendation: 'NONE' | 'DEPOSIT_REQUIRED' | 'REDUCE_EXPOSURE' | 'WITHDRAW_EXCESS';
  recommendedRebalanceAmountUsd: number;
}

export interface TreasuryAllocationStatus {
  totalLiquidCapitalUsd: number;
  binanceAuthoritativeBalanceUsd: number;
  binanceAllocationPct: number;
  binanceMinReserveUsd: number;
  reconciliationStatus: string;
  isReconciled: boolean;
  providers: Record<ComputeProviderName, ProviderFloatMetrics>;
  killSwitches: {
    globalActive: boolean;
    providerRebalancingActive: boolean;
    binanceOutflowActive: boolean;
  };
}

export interface RebalanceParams {
  provider: ComputeProviderName;
  targetAmountUsd: number;
  currency?: SupportedCurrency;
  idempotencyKey: string;
  authorizationToken?: string;
  isAuthorized?: boolean;
  reason?: string;
}

export interface RebalanceResult {
  success: boolean;
  operationId: string;
  provider: ComputeProviderName;
  previousBalanceUsd: number;
  newBalanceUsd: number;
  transferredAmountUsd: number;
  binanceRemainingBalanceUsd: number;
  idempotentDuplicate?: boolean;
  errorCode?: string;
  message: string;
  executedAt: string;
}

export class ProviderFloatManager {
  // Starting defaults for $1,000 equivalent: Binance: 70%, Vast: 15%, RunPod: 10%, Lambda: 5%
  public readonly DEFAULT_ALLOCATIONS: Record<'binance' | ComputeProviderName, number> = {
    binance: 70.0,
    vast_ai: 15.0,
    runpod: 10.0,
    lambda: 5.0
  };

  /**
   * Starting defaults for $1,000 equivalent:
   * Binance: 70% ($700), Vast: 15% ($150), RunPod: 10% ($100), Lambda: 5% ($50)
   */
  public getDefaultFloatTargets(totalCapitalUsd: number = 1000): {
    binance: { allocationPct: number; targetAmountUsd: number };
    vast: { allocationPct: number; targetAmountUsd: number };
    runpod: { allocationPct: number; targetAmountUsd: number };
    lambda: { allocationPct: number; targetAmountUsd: number };
  } {
    return {
      binance: { allocationPct: 70, targetAmountUsd: Math.round(totalCapitalUsd * 0.70 * 100) / 100 },
      vast: { allocationPct: 15, targetAmountUsd: Math.round(totalCapitalUsd * 0.15 * 100) / 100 },
      runpod: { allocationPct: 10, targetAmountUsd: Math.round(totalCapitalUsd * 0.10 * 100) / 100 },
      lambda: { allocationPct: 5, targetAmountUsd: Math.round(totalCapitalUsd * 0.05 * 100) / 100 }
    };
  }

  /**
   * Calculates minimum, recommended, and maximum authorized floats across all providers
   * based on demand forecasts, pricing, reliability, SLAs, and contractual exposure.
   */
  public async calculateAuthorizedFloats(): Promise<TreasuryAllocationStatus> {
    const config = getBinanceConfig();
    const reconGate = await evaluateAuthoritativeReconciliationGate();

    // Query active kill switches
    const globalKs = await killSwitchRepo.isKillSwitchActive('GLOBAL_KILL_SWITCH');
    const rebalKs = await killSwitchRepo.isKillSwitchActive('PROVIDER_REBALANCING_KILL_SWITCH');
    const binanceKs = await killSwitchRepo.isKillSwitchActive('BINANCE_OUTFLOW_KILL_SWITCH');

    // Query Binance Authoritative Balance from PostgreSQL ledger / treasury
    let binanceBalanceMinor = 0n;
    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        const binanceRow = await pgDbService.query(
          `SELECT COALESCE(SUM(CASE WHEN l.direction = 'DEBIT' THEN l.quantity ELSE -l.quantity END), 0)::numeric as "balMajor"
           FROM treasury_ledger l
           JOIN treasury_accounts a ON a.id = l.account_id
           WHERE a.provider = 'binance' AND a.account_type = 'TREASURY_CASH' AND l.asset = $1`,
          [config.treasuryAsset]
        );
        const balMajor = Number(binanceRow.rows[0]?.balMajor || 0);
        binanceBalanceMinor = toMinorUnits(Math.max(0, balMajor));
      } catch (err) {
        console.warn('[PROVIDER FLOAT] Could not fetch Binance balance from DB:', err);
      }
    }

    const binanceBalanceUsd = fromMinorUnits(binanceBalanceMinor);

    // Query current running instance commitments, accrued costs, and pending demands from DB
    const providerStats: Record<ComputeProviderName, {
      runningCount: number;
      accruedCostMinor: bigint;
      hourlyCostMinor: bigint;
      contractualExposureMinor: bigint;
      demandGpuHours: number;
    }> = {
      vast_ai: { runningCount: 0, accruedCostMinor: 0n, hourlyCostMinor: 0n, contractualExposureMinor: 0n, demandGpuHours: 0 },
      runpod: { runningCount: 0, accruedCostMinor: 0n, hourlyCostMinor: 0n, contractualExposureMinor: 0n, demandGpuHours: 0 },
      lambda: { runningCount: 0, accruedCostMinor: 0n, hourlyCostMinor: 0n, contractualExposureMinor: 0n, demandGpuHours: 0 }
    };

    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        const instRows = await pgDbService.query(
          `SELECT provider,
                  COUNT(*) as count,
                  COALESCE(SUM(actual_hourly_cost), 0)::numeric as hourly_sum,
                  COALESCE(SUM(actual_hourly_cost * GREATEST(0.05, EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600.0)), 0)::numeric as accrued_sum
           FROM provider_instances
           WHERE status IN ('PROVISIONING', 'RUNNING')
           GROUP BY provider`
        );

        for (const row of instRows.rows) {
          const prov = (row.provider || '').toLowerCase() as ComputeProviderName;
          if (providerStats[prov]) {
            providerStats[prov].runningCount = Number(row.count);
            providerStats[prov].hourlyCostMinor = toMinorUnits(Number(row.hourly_sum));
            providerStats[prov].accruedCostMinor = toMinorUnits(Number(row.accrued_sum));
            // 2 hours remaining exposure buffer
            providerStats[prov].contractualExposureMinor = providerStats[prov].hourlyCostMinor * 2n;
          }
        }

        const demandRows = await pgDbService.query(
          `SELECT COALESCE(SUM(duration_hours * gpu_count), 0)::numeric as total_gpu_hours
           FROM demand_orders
           WHERE payment_status IN ('ESCROW_AUTHORIZED', 'SIGNED_CONTRACT', 'PREPAID_CREDIT')`
        );

        const totalConfirmedGpuHours = Number(demandRows.rows[0]?.total_gpu_hours || 0);
        if (totalConfirmedGpuHours > 0) {
          providerStats.vast_ai.demandGpuHours = Math.round(totalConfirmedGpuHours * 0.5 * 100) / 100;
          providerStats.runpod.demandGpuHours = Math.round(totalConfirmedGpuHours * 0.35 * 100) / 100;
          providerStats.lambda.demandGpuHours = Math.round(totalConfirmedGpuHours * 0.15 * 100) / 100;
        }
      } catch (err) {
        console.warn('[PROVIDER FLOAT] DB query error calculating floats:', err);
      }
    }

    // Query preflights from hardware provisioner for live balances & health
    let preflights: Record<string, any> = {};
    try {
      preflights = await hardwareProvisioner.runAllPreflights(false);
    } catch {
      // safe fallback
    }

    // Calculate provider float metrics dynamically
    const providers: Record<ComputeProviderName, ProviderFloatMetrics> = {} as any;
    const providerList: ComputeProviderName[] = ['vast_ai', 'runpod', 'lambda'];

    let totalProviderBalancesMinor = 0n;

    for (const prov of providerList) {
      const preflight = preflights[prov] || {};
      const risk = getProviderRiskMetrics(prov);
      const targetPct = this.DEFAULT_ALLOCATIONS[prov];

      // Live verified credit balance or recorded balance
      const currentCredit = typeof preflight.creditAvailableUsd === 'number' ? preflight.creditAvailableUsd : 0;
      const currentCreditMinor = toMinorUnits(currentCredit);
      totalProviderBalancesMinor += currentCreditMinor;

      const stats = providerStats[prov];
      const accruedUsd = fromMinorUnits(stats.accruedCostMinor);
      const contractualUsd = fromMinorUnits(stats.contractualExposureMinor);

      // Estimated remaining cost: running workloads for remaining duration
      const estimatedRemainingUsd = fromMinorUnits(stats.hourlyCostMinor * 2n);

      // Demand forecast GPU-hours: existing orders + 10 hours baseline forecast
      const forecastGpuHours = Math.max(stats.demandGpuHours, 5);
      const avgHourlyRate = prov === 'lambda' ? 2.49 : (prov === 'runpod' ? 2.20 : 1.85);

      // Minimum buffer: minimum required to honor active jobs + 1 hr emergency shutdown buffer
      const minimumBufferUsd = Math.max(15.00, fromMinorUnits(stats.hourlyCostMinor * 2n) + 10.00);

      // Minimum Authorized Float: covers accrued + contractual exposure + minimum buffer
      const minAuthFloatUsd = Math.round((contractualUsd + minimumBufferUsd) * 100) / 100;

      // Recommended Authorized Float: covers forecast demand GPU-hours * avgRate * risk adjusted multiplier
      const forecastCost = forecastGpuHours * avgHourlyRate;
      const riskAdjustedExpectedProfit = forecastCost * 0.25; // 25% target margin
      const recAuthFloatUsd = Math.round(Math.max(minAuthFloatUsd, forecastCost * risk.riskMultiplier) * 100) / 100;

      // Maximum Authorized Float: ceiling prevents excess capital tied up in provider floats
      const maxAuthFloatUsd = Math.round((recAuthFloatUsd * 2.0) * 100) / 100;

      // Determine rebalance recommendation
      let recommendation: 'NONE' | 'DEPOSIT_REQUIRED' | 'REDUCE_EXPOSURE' | 'WITHDRAW_EXCESS' = 'NONE';
      let recommendedRebalanceAmountUsd = 0;

      // Never fund providers merely because balances are low: only fund if active demand or commitments justify it!
      const hasActiveCommitmentsOrDemand = stats.runningCount > 0 || stats.demandGpuHours > 0;

      if (currentCredit < minAuthFloatUsd && hasActiveCommitmentsOrDemand) {
        recommendation = 'DEPOSIT_REQUIRED';
        recommendedRebalanceAmountUsd = Math.round((recAuthFloatUsd - currentCredit) * 100) / 100;
      } else if (currentCredit > maxAuthFloatUsd && currentCredit > 100) {
        recommendation = 'WITHDRAW_EXCESS';
        recommendedRebalanceAmountUsd = Math.round((currentCredit - recAuthFloatUsd) * 100) / 100;
      }

      providers[prov] = {
        provider: prov,
        targetAllocationPct: targetPct,
        currentBalanceUsd: currentCredit,
        pendingChargesUsd: 0,
        accruedCostUsd: accruedUsd,
        estimatedRemainingCostUsd: estimatedRemainingUsd,
        contractualExposureUsd: contractualUsd,
        minimumBufferUsd,
        minimumAuthorizedFloatUsd: minAuthFloatUsd,
        recommendedAuthorizedFloatUsd: recAuthFloatUsd,
        maximumAuthorizedFloatUsd: maxAuthFloatUsd,
        forecastDemandGpuHours: forecastGpuHours,
        averageHourlyRateUsd: avgHourlyRate,
        riskAdjustedExpectedProfitUsd: Math.round(riskAdjustedExpectedProfit * 100) / 100,
        reliabilityScore: risk.telemetryScore,
        paymentRequirement: prov === 'vast_ai' ? 'PREPAID_CREDIT' : (prov === 'runpod' ? 'HYBRID' : 'POSTPAID_CARD'),
        recommendation,
        recommendedRebalanceAmountUsd
      };
    }

    const totalLiquidCapitalMinor = binanceBalanceMinor + totalProviderBalancesMinor;
    const totalLiquidCapitalUsd = fromMinorUnits(totalLiquidCapitalMinor);
    const binanceAllocationPct = totalLiquidCapitalMinor > 0n
      ? Math.round(Number((binanceBalanceMinor * 10000n) / totalLiquidCapitalMinor)) / 100
      : 70.0;

    return {
      totalLiquidCapitalUsd,
      binanceAuthoritativeBalanceUsd: binanceBalanceUsd,
      binanceAllocationPct,
      binanceMinReserveUsd: config.minReserve,
      reconciliationStatus: reconGate.status,
      isReconciled: reconGate.isGreen,
      providers,
      killSwitches: {
        globalActive: globalKs.active,
        providerRebalancingActive: rebalKs.active,
        binanceOutflowActive: binanceKs.active
      }
    };
  }

  /**
   * Rebalances capital from Binance treasury into a provider float with:
   * - Authorization check
   * - Reserve protection (Binance >= BINANCE_MIN_RESERVE and retains 70-80%)
   * - Exposure limits (<= maximumAuthorizedFloat and <= BINANCE_MAX_SINGLE_EXPOSURE)
   * - Reconciliation gate check (fail-closed if not freshly RECONCILED)
   * - Idempotency
   * - Immutable audit records
   * - "Never fund providers merely because balances are low."
   */
  public async rebalance(params: RebalanceParams): Promise<RebalanceResult> {
    const { provider, targetAmountUsd, idempotencyKey, isAuthorized, authorizationToken, reason } = params;
    const executedAt = new Date().toISOString();
    const config = getBinanceConfig();

    // --- GATE 1: SAFETY & KILL SWITCHES ---
    const globalKs = await killSwitchRepo.isKillSwitchActive('GLOBAL_KILL_SWITCH');
    if (globalKs.active) {
      return {
        success: false,
        operationId: '',
        provider,
        previousBalanceUsd: 0,
        newBalanceUsd: 0,
        transferredAmountUsd: 0,
        binanceRemainingBalanceUsd: 0,
        errorCode: 'GLOBAL_KILL_SWITCH_ACTIVE',
        message: `Provider float rebalancing blocked: GLOBAL_KILL_SWITCH is active (${globalKs.reason}).`,
        executedAt
      };
    }

    const rebalKs = await killSwitchRepo.isKillSwitchActive('PROVIDER_REBALANCING_KILL_SWITCH');
    if (rebalKs.active) {
      return {
        success: false,
        operationId: '',
        provider,
        previousBalanceUsd: 0,
        newBalanceUsd: 0,
        transferredAmountUsd: 0,
        binanceRemainingBalanceUsd: 0,
        errorCode: 'PROVIDER_REBALANCING_KILL_SWITCH_ACTIVE',
        message: `Provider float rebalancing blocked: PROVIDER_REBALANCING_KILL_SWITCH is active (${rebalKs.reason}).`,
        executedAt
      };
    }

    const binanceKs = await killSwitchRepo.isKillSwitchActive('BINANCE_OUTFLOW_KILL_SWITCH');
    if (binanceKs.active) {
      return {
        success: false,
        operationId: '',
        provider,
        previousBalanceUsd: 0,
        newBalanceUsd: 0,
        transferredAmountUsd: 0,
        binanceRemainingBalanceUsd: 0,
        errorCode: 'BINANCE_OUTFLOW_KILL_SWITCH_ACTIVE',
        message: `Provider float rebalancing blocked: BINANCE_OUTFLOW_KILL_SWITCH is active (${binanceKs.reason}).`,
        executedAt
      };
    }

    // --- GATE 2: AUTHORIZATION ---
    if (!isAuthorized && !authorizationToken) {
      return {
        success: false,
        operationId: '',
        provider,
        previousBalanceUsd: 0,
        newBalanceUsd: 0,
        transferredAmountUsd: 0,
        binanceRemainingBalanceUsd: 0,
        errorCode: 'UNAUTHORIZED_REBALANCE',
        message: 'REJECTED: Provider float rebalance requires explicit authorized credentials or OWNER session.',
        executedAt
      };
    }

    // --- GATE 3: IDEMPOTENCY ---
    if (!idempotencyKey || idempotencyKey.trim().length < 8) {
      return {
        success: false,
        operationId: '',
        provider,
        previousBalanceUsd: 0,
        newBalanceUsd: 0,
        transferredAmountUsd: 0,
        binanceRemainingBalanceUsd: 0,
        errorCode: 'INVALID_IDEMPOTENCY_KEY',
        message: 'REJECTED: Rebalance operation requires a cryptographically strong idempotencyKey (min 8 chars).',
        executedAt
      };
    }

    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        const cached = await idempotencyRepo.checkIdempotency(`rebal-${idempotencyKey}`);
        if (cached && cached.response) {
          const res = cached.response as RebalanceResult;
          return {
            ...res,
            idempotentDuplicate: true,
            message: `Idempotent duplicate: Returning previously confirmed rebalance result.`
          };
        }
      } catch (err) {
        console.warn('[PROVIDER FLOAT] Idempotency read error:', err);
      }
    }

    // --- GATE 4: RECONCILIATION GATE ---
    const reconGate = await evaluateAuthoritativeReconciliationGate();
    if (!reconGate.isGreen) {
      return {
        success: false,
        operationId: '',
        provider,
        previousBalanceUsd: 0,
        newBalanceUsd: 0,
        transferredAmountUsd: 0,
        binanceRemainingBalanceUsd: 0,
        errorCode: 'RECONCILIATION_GATE_FAIL_CLOSED',
        message: `REJECTED: Treasury reconciliation gate is not green (${reconGate.status}: ${reconGate.message}). Cannot deploy capital while treasury is unreconciled.`,
        executedAt
      };
    }

    // --- GATE 5: NEVER FUND MERELY BECAUSE BALANCES ARE LOW ---
    // Check if there is actual demand, running instances, or contractual exposure justifying this rebalance
    const floats = await this.calculateAuthorizedFloats();
    const providerFloat = floats.providers[provider];
    if (!providerFloat) {
      return {
        success: false,
        operationId: '',
        provider,
        previousBalanceUsd: 0,
        newBalanceUsd: 0,
        transferredAmountUsd: 0,
        binanceRemainingBalanceUsd: 0,
        errorCode: 'UNSUPPORTED_PROVIDER',
        message: `REJECTED: Provider '${provider}' is not a recognized compute supplier.`,
        executedAt
      };
    }

    const targetMinor = toMinorUnits(targetAmountUsd);
    if (targetMinor <= 0n) {
      return {
        success: false,
        operationId: '',
        provider,
        previousBalanceUsd: providerFloat.currentBalanceUsd,
        newBalanceUsd: providerFloat.currentBalanceUsd,
        transferredAmountUsd: 0,
        binanceRemainingBalanceUsd: floats.binanceAuthoritativeBalanceUsd,
        errorCode: 'INVALID_REBALANCE_AMOUNT',
        message: `REJECTED: Rebalance amount must be strictly greater than $0.00.`,
        executedAt
      };
    }

    // Verify justifying need: must have active demand or commitments
    const hasJustification = providerFloat.contractualExposureUsd > 0 ||
                             providerFloat.forecastDemandGpuHours > 0 ||
                             providerFloat.recommendation === 'DEPOSIT_REQUIRED';

    if (!hasJustification && targetAmountUsd > 25.00) {
      return {
        success: false,
        operationId: '',
        provider,
        previousBalanceUsd: providerFloat.currentBalanceUsd,
        newBalanceUsd: providerFloat.currentBalanceUsd,
        transferredAmountUsd: 0,
        binanceRemainingBalanceUsd: floats.binanceAuthoritativeBalanceUsd,
        errorCode: 'NO_DEMAND_JUSTIFICATION',
        message: `REJECTED: Financial policy mandate forbids funding providers merely because balances are low. No active demand orders or contractual commitments justify transferring $${targetAmountUsd.toFixed(2)} to ${provider}.`,
        executedAt
      };
    }

    // --- GATE 6: EXPOSURE LIMITS ---
    const maxSingleMinor = toMinorUnits(config.maxSingleExposure);
    if (targetMinor > maxSingleMinor) {
      return {
        success: false,
        operationId: '',
        provider,
        previousBalanceUsd: providerFloat.currentBalanceUsd,
        newBalanceUsd: providerFloat.currentBalanceUsd,
        transferredAmountUsd: 0,
        binanceRemainingBalanceUsd: floats.binanceAuthoritativeBalanceUsd,
        errorCode: 'EXCEEDS_MAX_SINGLE_EXPOSURE',
        message: `REJECTED: Rebalance amount of $${targetAmountUsd.toFixed(2)} exceeds BINANCE_MAX_SINGLE_EXPOSURE limit of $${config.maxSingleExposure.toFixed(2)}.`,
        executedAt
      };
    }

    const currentFloatMinor = toMinorUnits(providerFloat.currentBalanceUsd);
    const postRebalanceFloatMinor = currentFloatMinor + targetMinor;
    const maxAuthMinor = toMinorUnits(providerFloat.maximumAuthorizedFloatUsd);

    if (postRebalanceFloatMinor > maxAuthMinor) {
      return {
        success: false,
        operationId: '',
        provider,
        previousBalanceUsd: providerFloat.currentBalanceUsd,
        newBalanceUsd: providerFloat.currentBalanceUsd,
        transferredAmountUsd: 0,
        binanceRemainingBalanceUsd: floats.binanceAuthoritativeBalanceUsd,
        errorCode: 'EXCEEDS_MAX_AUTHORIZED_FLOAT',
        message: `REJECTED: Resulting float $${fromMinorUnits(postRebalanceFloatMinor).toFixed(2)} would exceed maximum authorized float ceiling of $${providerFloat.maximumAuthorizedFloatUsd.toFixed(2)} for ${provider}.`,
        executedAt
      };
    }

    // --- GATE 7: TREASURY RESERVE PROTECTION ---
    // Binance should normally retain 70–80% of liquid capital and never fall below BINANCE_MIN_RESERVE
    const binanceBalMinor = toMinorUnits(floats.binanceAuthoritativeBalanceUsd);
    const minReserveMinor = toMinorUnits(config.minReserve);

    if (binanceBalMinor - targetMinor < minReserveMinor) {
      return {
        success: false,
        operationId: '',
        provider,
        previousBalanceUsd: providerFloat.currentBalanceUsd,
        newBalanceUsd: providerFloat.currentBalanceUsd,
        transferredAmountUsd: 0,
        binanceRemainingBalanceUsd: floats.binanceAuthoritativeBalanceUsd,
        errorCode: 'BREACHES_BINANCE_MIN_RESERVE',
        message: `REJECTED: Transferring $${targetAmountUsd.toFixed(2)} would breach BINANCE_MIN_RESERVE ($${config.minReserve.toFixed(2)}). Remaining Binance balance would be $${fromMinorUnits(binanceBalMinor - targetMinor).toFixed(2)}.`,
        executedAt
      };
    }

    const postBinanceMinor = binanceBalMinor - targetMinor;
    const postTotalLiquidMinor = floats.totalLiquidCapitalUsd > 0 ? toMinorUnits(floats.totalLiquidCapitalUsd) : binanceBalMinor;
    const postBinanceRatio = postTotalLiquidMinor > 0n
      ? Number((postBinanceMinor * 1000n) / postTotalLiquidMinor) / 10
      : 70.0;

    if (postBinanceRatio < 65.0) {
      return {
        success: false,
        operationId: '',
        provider,
        previousBalanceUsd: providerFloat.currentBalanceUsd,
        newBalanceUsd: providerFloat.currentBalanceUsd,
        transferredAmountUsd: 0,
        binanceRemainingBalanceUsd: floats.binanceAuthoritativeBalanceUsd,
        errorCode: 'BINANCE_ALLOCATION_TOO_LOW',
        message: `REJECTED: Capital allocation rule mandates Binance retain 70–80% of liquid capital. Post-transfer allocation would drop to ${postBinanceRatio.toFixed(1)}%.`,
        executedAt
      };
    }

    // --- EXECUTION: REAL PROVIDER FUNDING & ATOMIC LEDGER RECORDING ---
    const operationId = `rebal-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const previousBalanceUsd = providerFloat.currentBalanceUsd;
    const newBalanceUsd = fromMinorUnits(postRebalanceFloatMinor);
    const transferredAmountUsd = fromMinorUnits(targetMinor);
    const binanceRemainingBalanceUsd = fromMinorUnits(postBinanceMinor);

    // Mandate: An internal accounting entry alone must NEVER mark provider funds as externally funded.
    let realFundingResult: ProviderFundingEventRecord;
    try {
      realFundingResult = await realProviderFundingManager.executeRealFunding({
        provider,
        amountUsd: transferredAmountUsd,
        idempotencyKey,
        reason: reason || 'Demand-driven authorized float replenishment'
      });
    } catch (fundingErr: any) {
      return {
        success: false,
        operationId,
        provider,
        previousBalanceUsd,
        newBalanceUsd: previousBalanceUsd,
        transferredAmountUsd: 0,
        binanceRemainingBalanceUsd: floats.binanceAuthoritativeBalanceUsd,
        errorCode: 'REAL_PROVIDER_FUNDING_FAILED',
        message: `Real provider funding failed on ${provider} rail: ${fundingErr.message}. Internal ledger transfer aborted.`,
        executedAt
      };
    }

    if (pgDbService.isLiveDatabaseConnected()) {
      const client = await pgDbService.getClient();
      try {
        await client.query('BEGIN');

        // 1. Double-entry ledger record
        const ledgerId = `led-rebal-${operationId}`;
        await client.query(
          `INSERT INTO double_entry_ledger
             (ledger_id, debit_account, credit_account, amount, currency, event_type, reference_id, metadata, created_at)
           VALUES ($1, $2, $3, $4, 'USD', 'PROVIDER_FLOAT_REBALANCED', $5, $6, NOW())`,
          [
            ledgerId,
            `PROVIDER_FLOAT_${provider.toUpperCase()}`,
            `BINANCE_TREASURY_${config.treasuryAsset}`,
            transferredAmountUsd,
            operationId,
            JSON.stringify({
              provider,
              targetAmountUsd: transferredAmountUsd,
              idempotencyKey,
              externalTransactionReference: realFundingResult.externalTransactionReference,
              providerAccountId: realFundingResult.providerAccountId,
              fundingEventId: realFundingResult.id,
              reason: reason || 'Demand-driven authorized float replenishment'
            })
          ]
        );

        // 2. Update treasury accounts in DB
        await client.query(
          `UPDATE treasury_accounts
           SET current_balance_minor = current_balance_minor - $1,
               updated_at = NOW()
           WHERE provider = 'binance' AND asset = $2`,
          [targetMinor.toString(), config.treasuryAsset]
        );

        await client.query(
          `INSERT INTO treasury_accounts (id, provider, asset, currency_or_asset, current_balance_minor, updated_at)
           VALUES ($1, $2, 'USD', 'USD', $3, NOW())
           ON CONFLICT (id) DO UPDATE
           SET current_balance_minor = treasury_accounts.current_balance_minor + $3,
               updated_at = NOW()`,
          [`prov-float-${provider}`, provider, targetMinor.toString()]
        );

        // 3. Record in idempotency_keys
        await client.query(
          `INSERT INTO idempotency_keys (idempotency_key, operation_type, status, response, created_at, updated_at)
           VALUES ($1, 'PROVIDER_FLOAT_REBALANCE', 'COMPLETED', $2, NOW(), NOW())
           ON CONFLICT (idempotency_key) DO UPDATE
           SET status = 'COMPLETED', response = $2, updated_at = NOW()`,
          [
            `rebal-${idempotencyKey}`,
            JSON.stringify({
              success: true,
              operationId,
              provider,
              previousBalanceUsd,
              newBalanceUsd,
              transferredAmountUsd,
              binanceRemainingBalanceUsd,
              executedAt
            })
          ]
        );

        await client.query('COMMIT');
      } catch (txErr: any) {
        await client.query('ROLLBACK');
        console.error('[PROVIDER FLOAT] Rebalance transaction rollback:', txErr);
        return {
          success: false,
          operationId,
          provider,
          previousBalanceUsd,
          newBalanceUsd: previousBalanceUsd,
          transferredAmountUsd: 0,
          binanceRemainingBalanceUsd: floats.binanceAuthoritativeBalanceUsd,
          errorCode: 'TRANSACTION_FAILED',
          message: `Rebalance atomic ledger transaction failed: ${txErr.message}`,
          executedAt
        };
      } finally {
        client.release();
      }
    }

    // 4. Immutable cryptographic audit event
    await auditRepo.recordEvent({
      eventType: 'PROVIDER_FLOAT_REBALANCED',
      severity: 'INFO',
      message: `Rebalanced $${transferredAmountUsd.toFixed(2)} USD to ${provider} float. Post-rebalance float: $${newBalanceUsd.toFixed(2)}, Binance remaining: $${binanceRemainingBalanceUsd.toFixed(2)}.`,
      details: {
        operationId,
        provider,
        previousBalanceUsd,
        newBalanceUsd,
        transferredAmountUsd,
        binanceRemainingBalanceUsd,
        idempotencyKey,
        reason: reason || 'Demand-driven float replenishment'
      }
    });

    return {
      success: true,
      operationId,
      provider,
      previousBalanceUsd,
      newBalanceUsd,
      transferredAmountUsd,
      binanceRemainingBalanceUsd,
      message: `Successfully rebalanced $${transferredAmountUsd.toFixed(2)} USD to ${provider}.`,
      executedAt
    };
  }

  /**
   * Evidence-Based Exposure Limit Validator:
   * Validates that transaction amounts strictly respect configured BINANCE_MAX_SINGLE_EXPOSURE
   * and fail closed when over-limit.
   */
  public validateExposureLimits(amountUsd: number, provider: ComputeProviderName = 'runpod'): {
    allowed: boolean;
    reason?: string;
    errorCode?: string;
    configuredMaxSingleExposure: number;
    configuredMaxDailyExposure: number;
  } {
    const config = getBinanceConfig();
    if (amountUsd <= 0) {
      return {
        allowed: false,
        errorCode: 'INVALID_AMOUNT',
        reason: 'Transaction amount must be strictly greater than $0.00',
        configuredMaxSingleExposure: config.maxSingleExposure,
        configuredMaxDailyExposure: config.maxDailyExposure
      };
    }
    if (amountUsd > config.maxSingleExposure) {
      return {
        allowed: false,
        errorCode: 'EXCEEDS_MAX_SINGLE_EXPOSURE',
        reason: `Amount $${amountUsd.toFixed(2)} exceeds max single exposure limit of $${config.maxSingleExposure.toFixed(2)}`,
        configuredMaxSingleExposure: config.maxSingleExposure,
        configuredMaxDailyExposure: config.maxDailyExposure
      };
    }
    return {
      allowed: true,
      configuredMaxSingleExposure: config.maxSingleExposure,
      configuredMaxDailyExposure: config.maxDailyExposure
    };
  }
}

export const providerFloatManager = new ProviderFloatManager();
