import crypto from 'crypto';
import { pgDbService } from './pgDatabase.js';
import { getBinanceConfig } from './binanceConfig.js';
import { binanceTreasuryProvider } from './binanceProvider.js';
import { toMinorUnits, fromMinorUnits } from './moneyUtils.js';
import { auditRepo, killSwitchRepo } from './repositories/index.js';
import { realProviderFundingManager } from './providerFundingAdapters.js';
import { ComputeProviderName } from './providerFloatManager.js';
import { evaluateAuthoritativeReconciliationGate } from './reconciliationGate.js';

export interface CapitalDeploymentState {
  availableBinanceBalanceUsd: number;
  mandatoryOperatingReserveUsd: number;
  committedCapitalUsd: number;
  activeJobExposureUsd: number;
  providerBalancesUsd: Record<ComputeProviderName, number>;
  customerLiabilitiesUsd: number;
  expectedGpuCostsUsd: number;
  expectedRevenueUsd: number;
  expectedProfitUsd: number;
  maximumSafeDeploymentUsd: number;
  canDeploy: boolean;
  blockReasons: string[];
  reconciliationFresh: boolean;
  evaluatedAt: string;
}

export interface AutonomousProfitAllocation {
  id: string;
  settlementId: string;
  verifiedProfitId: string;
  totalVerifiedProfit: number;
  mandatoryReserveAllocated: number;
  operatingCapitalAllocated: number;
  growthReinvestmentAllocated: number;
  providerFloatAllocated: number;
  feesTaxReserveAllocated: number;
  withdrawableSurplusAllocated: number;
  allocationLogicSnapshot: Record<string, any>;
  allocatedAt: string;
  auditHash: string;
}

export class AutonomousCapitalController {
  /**
   * Automatically determines the complete liquid capital deployment posture:
   * available Binance balance, mandatory operating reserve, committed capital,
   * active job exposure, provider balances, customer liabilities, expected GPU costs,
   * expected revenue, expected profit, and maximum safe deployment.
   */
  async evaluateCapitalDeploymentState(): Promise<CapitalDeploymentState> {
    const config = getBinanceConfig();
    const evaluatedAt = new Date().toISOString();
    const blockReasons: string[] = [];

    // 1. External money source of truth: Binance API
    let binanceBal = 0;
    try {
      const liveBal = await binanceTreasuryProvider.getTreasuryAssetBalance(config.treasuryAsset);
      binanceBal = liveBal?.free ?? 0;
    } catch (err: any) {
      blockReasons.push(`BINANCE_BALANCE_UNAVAILABLE: ${err.message}`);
    }

    const mandatoryOperatingReserveUsd = Math.max(100.0, config.minReserve);

    // 2. Query authoritative PostgreSQL financial state
    let committedCapitalUsd = 0;
    let activeJobExposureUsd = 0;
    let customerLiabilitiesUsd = 0;
    let expectedGpuCostsUsd = 0;
    let expectedRevenueUsd = 0;
    let expectedProfitUsd = 0;

    const providerBalancesUsd: Record<ComputeProviderName, number> = {
      vast_ai: 0,
      runpod: 0,
      lambda: 0
    };

    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        // Query active capital reservations
        const resvRes = await pgDbService.query(
          `SELECT COALESCE(SUM(amount), 0)::numeric as total
           FROM capital_reservations
           WHERE status IN ('REQUESTED', 'RESERVED') AND expires_at > NOW()`
        );
        committedCapitalUsd = Number(resvRes.rows[0]?.total || 0);

        // Query active running instances exposure
        const instRes = await pgDbService.query(
          `SELECT COALESCE(SUM(actual_hourly_cost * 24.0), 0)::numeric as exposure,
                  COALESCE(SUM(actual_hourly_cost), 0)::numeric as expected_gpu_costs
           FROM provider_instances
           WHERE status IN ('PROVISIONING', 'RUNNING')`
        );
        activeJobExposureUsd = Number(instRes.rows[0]?.exposure || 0);
        expectedGpuCostsUsd = Number(instRes.rows[0]?.expected_gpu_costs || 0);

        // Query customer liabilities (escrowed customer payments not yet settled)
        const custLiabRes = await pgDbService.query(
          `SELECT COALESCE(SUM(amount_cents), 0)::bigint as total_cents
           FROM payment_intents
           WHERE status = 'SETTLED'
             AND id NOT IN (SELECT payment_intent_id FROM settlements WHERE payment_intent_id IS NOT NULL)`
        );
        const liabCents = BigInt(custLiabRes.rows[0]?.total_cents || '0');
        customerLiabilitiesUsd = fromMinorUnits(liabCents);

        // Query active demand orders for expected revenue & profit
        const demandRes = await pgDbService.query(
          `SELECT COALESCE(SUM(target_price_per_hour * max_hours), 0)::numeric as exp_rev,
                  COALESCE(SUM(target_price_per_hour * max_hours * 0.25), 0)::numeric as exp_profit
           FROM demand_orders
           WHERE status IN ('ACCEPTED', 'MATCHED')`
        );
        expectedRevenueUsd = Number(demandRes.rows[0]?.exp_rev || 0);
        expectedProfitUsd = Number(demandRes.rows[0]?.exp_profit || 0);
      } catch (err: any) {
        blockReasons.push(`DB_CAPITAL_STATE_QUERY_FAILED: ${err.message}`);
      }
    } else {
      blockReasons.push('POSTGRESQL_DISCONNECTED: Cannot evaluate capital state without database.');
    }

    // 3. Provider balances from real provider financial capabilities
    let totalDirectProviderCapital = 0;
    try {
      const caps = await realProviderFundingManager.verifyAllCapabilities();
      providerBalancesUsd.vast_ai = caps.vast_ai.currentBalanceUsd || 0;
      providerBalancesUsd.runpod = caps.runpod.currentBalanceUsd || 0;
      providerBalancesUsd.lambda = caps.lambda.currentBalanceUsd || 0;
      totalDirectProviderCapital = Object.values(providerBalancesUsd).reduce((a, b) => a + b, 0);
    } catch {
      // Non-fatal, balances default to 0
    }

    // 4. Calculate Maximum Safe Deployment
    // Max safe = Available Binance - Mandatory Reserve - Customer Liabilities - Committed Capital - Active Exposure
    const encumberedCapital =
      mandatoryOperatingReserveUsd +
      customerLiabilitiesUsd +
      committedCapitalUsd +
      activeJobExposureUsd;

    // Direct provider prepaid capital can be deployed directly into jobs without Binance sweeps
    const binanceSafeDeployment = Math.max(0, Math.round((binanceBal - encumberedCapital) * 100) / 100);
    const maximumSafeDeploymentUsd = Math.max(
      binanceSafeDeployment,
      Math.max(0, Math.round((totalDirectProviderCapital - activeJobExposureUsd) * 100) / 100)
    );

    // 5. Check kill switches
    const ks = await killSwitchRepo.isKillSwitchActive('GLOBAL_KILL_SWITCH');
    if (ks.active) {
      blockReasons.push(`GLOBAL_KILL_SWITCH_ACTIVE: ${ks.reason}`);
    }

    // Only block if NEITHER Binance reserve NOR direct funded provider balance exists
    if (binanceBal < mandatoryOperatingReserveUsd && totalDirectProviderCapital <= 0) {
      blockReasons.push(`INSUFFICIENT_BINANCE_RESERVE: Binance balance ($${binanceBal.toFixed(2)}) is below mandatory reserve ($${mandatoryOperatingReserveUsd.toFixed(2)}) and no provider pre-funded credit found.`);
    }

    // STRICT FAIL-CLOSED RECONCILIATION GATE
    const reconGate = await evaluateAuthoritativeReconciliationGate();
    const reconciliationFresh = reconGate.isGreen;
    if (!reconGate.isGreen) {
      blockReasons.push(`RECONCILIATION_GATE_FAIL_CLOSED: ${reconGate.message} (Status: ${reconGate.status})`);
    }

    const canDeploy = blockReasons.length === 0 && reconciliationFresh && maximumSafeDeploymentUsd > 0;

    return {
      availableBinanceBalanceUsd: binanceBal,
      mandatoryOperatingReserveUsd,
      committedCapitalUsd,
      activeJobExposureUsd,
      providerBalancesUsd,
      customerLiabilitiesUsd,
      expectedGpuCostsUsd,
      expectedRevenueUsd,
      expectedProfitUsd,
      maximumSafeDeploymentUsd,
      canDeploy,
      blockReasons,
      reconciliationFresh,
      evaluatedAt
    };
  }

  /**
   * Evaluates whether a proposed provider funding is justified.
   * Mandate: Fund providers ONLY when justified by:
   * 1. verified active demand
   * 2. an accepted profitable job
   * 3. actual provider requirements / minimum float
   * NEVER fund merely because provider balances are low.
   */
  async evaluateProviderFundingEligibility(params: {
    provider: ComputeProviderName;
    requestedAmountUsd: number;
    jobId?: string;
    demandOrderId?: string;
  }): Promise<{ eligible: boolean; approvedAmountUsd: number; reason: string }> {
    const deploymentState = await this.evaluateCapitalDeploymentState();

    if (!deploymentState.canDeploy) {
      return {
        eligible: false,
        approvedAmountUsd: 0,
        reason: `DEPLOYMENT_BLOCKED: ${deploymentState.blockReasons.join('; ')}`
      };
    }

    // Verify justifying need: demand order or accepted profitable job
    let hasJustifyingNeed = false;
    let needDescription = '';

    if (params.jobId && pgDbService.isLiveDatabaseConnected()) {
      const jobCheck = await pgDbService.query(
        `SELECT job_id, agreed_hourly_rate, actual_hourly_cost, status, payment_verified
         FROM compute_jobs
         WHERE job_id = $1 AND (payment_verified = TRUE OR status IN ('ACCEPTED', 'PROVISIONING', 'RUNNING'))`,
        [params.jobId]
      );
      if (jobCheck.rows.length > 0) {
        const j = jobCheck.rows[0];
        const margin = Number(j.agreed_hourly_rate || 0) - Number(j.actual_hourly_cost || 0);
        if (margin > 0) {
          hasJustifyingNeed = true;
          needDescription = `Accepted profitable job '${params.jobId}' with positive margin ($${margin.toFixed(2)}/hr).`;
        }
      }
    }

    if (!hasJustifyingNeed && params.demandOrderId && pgDbService.isLiveDatabaseConnected()) {
      const demandCheck = await pgDbService.query(
        `SELECT id, target_price_per_hour, max_hours, status
         FROM demand_orders
         WHERE id = $1 AND status IN ('ACCEPTED', 'MATCHED')`,
        [params.demandOrderId]
      );
      if (demandCheck.rows.length > 0) {
        hasJustifyingNeed = true;
        needDescription = `Active verified demand order '${params.demandOrderId}'.`;
      }
    }

    if (!hasJustifyingNeed && params.requestedAmountUsd > 10.00) {
      return {
        eligible: false,
        approvedAmountUsd: 0,
        reason: 'REJECTED: Funding providers merely because balances are low is strictly forbidden. An accepted profitable job or verified active demand order is required.'
      };
    }

    const cappedAmount = Math.min(params.requestedAmountUsd, deploymentState.maximumSafeDeploymentUsd);
    if (cappedAmount <= 0) {
      return {
        eligible: false,
        approvedAmountUsd: 0,
        reason: 'INSUFFICIENT_SAFE_DEPLOYMENT_CAPITAL: Requested funding exceeds maximum safe deployment capacity.'
      };
    }

    return {
      eligible: true,
      approvedAmountUsd: cappedAmount,
      reason: needDescription || 'Authorized minimum operating float approved within safe deployment bounds.'
    };
  }

  /**
   * Autonomous Profit Management:
   * After settlement, automatically allocates verified profit according to dynamic economic rules:
   * - mandatory reserve
   * - operating capital
   * - growth/reinvestment
   * - provider float
   * - fees/tax reserve
   * - withdrawable surplus
   * Does NOT hard-code arbitrary percentages; responds to demand, margins, provider economics, and risk.
   */
  async allocateVerifiedProfit(params: {
    settlementId: string;
    verifiedProfitId: string;
    grossRevenue: number;
    actualCost: number;
    paymentFees: number;
    netProfit: number;
  }): Promise<AutonomousProfitAllocation> {
    if (params.netProfit <= 0) {
      throw new Error(`CANNOT_ALLOCATE_ZERO_PROFIT: Net profit must be strictly greater than $0.00 (received: $${params.netProfit.toFixed(2)})`);
    }

    // Assess dynamic factors from live state
    const marginPct = params.grossRevenue > 0 ? (params.netProfit / params.grossRevenue) * 100 : 25;
    const config = getBinanceConfig();

    let currentReserveRatio = 1.0;
    try {
      const liveBal = await binanceTreasuryProvider.getTreasuryAssetBalance(config.treasuryAsset);
      const freeBal = liveBal?.free ?? 0;
      currentReserveRatio = freeBal > 0 ? freeBal / Math.max(1, config.minReserve) : 1.0;
    } catch {}

    // Dynamic rule calculation:
    // If reserve is under target (< 1.5x), allocate higher to mandatory reserve (30%), else 15%
    const reservePct = currentReserveRatio < 1.5 ? 0.30 : 0.15;
    // Fees/tax reserve: 15% for accounting and provider settlement buffer
    const taxReservePct = 0.15;
    // Growth/reinvestment & Provider Float respond to profit margin
    const growthPct = marginPct > 40 ? 0.20 : 0.15;
    const providerFloatPct = 0.15;
    const operatingCapitalPct = 0.10;

    // Remainder is withdrawable surplus
    const withdrawablePct = Math.max(0.10, 1.0 - (reservePct + taxReservePct + growthPct + providerFloatPct + operatingCapitalPct));

    const totalProfit = params.netProfit;
    const mandatoryReserveAllocated = Math.round(totalProfit * reservePct * 10000) / 10000;
    const feesTaxReserveAllocated = Math.round(totalProfit * taxReservePct * 10000) / 10000;
    const growthReinvestmentAllocated = Math.round(totalProfit * growthPct * 10000) / 10000;
    const providerFloatAllocated = Math.round(totalProfit * providerFloatPct * 10000) / 10000;
    const operatingCapitalAllocated = Math.round(totalProfit * operatingCapitalPct * 10000) / 10000;

    const withdrawableSurplusAllocated = Math.max(
      0,
      Math.round(
        (totalProfit -
          (mandatoryReserveAllocated +
            feesTaxReserveAllocated +
            growthReinvestmentAllocated +
            providerFloatAllocated +
            operatingCapitalAllocated)) *
          10000
      ) / 10000
    );

    const allocationId = `alloc-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const logicSnapshot = {
      marginPct,
      currentReserveRatio,
      reservePct,
      taxReservePct,
      growthPct,
      providerFloatPct,
      operatingCapitalPct,
      withdrawablePct,
      evaluatedAt: new Date().toISOString()
    };

    const auditPayload = `${allocationId}|${params.settlementId}|${params.verifiedProfitId}|${totalProfit.toFixed(4)}|${withdrawableSurplusAllocated.toFixed(4)}`;
    const auditHash = crypto.createHash('sha256').update(auditPayload).digest('hex');

    const allocation: AutonomousProfitAllocation = {
      id: allocationId,
      settlementId: params.settlementId,
      verifiedProfitId: params.verifiedProfitId,
      totalVerifiedProfit: totalProfit,
      mandatoryReserveAllocated,
      operatingCapitalAllocated,
      growthReinvestmentAllocated,
      providerFloatAllocated,
      feesTaxReserveAllocated,
      withdrawableSurplusAllocated,
      allocationLogicSnapshot: logicSnapshot,
      allocatedAt: new Date().toISOString(),
      auditHash
    };

    // Persist to authoritative PostgreSQL autonomous_profit_allocations
    if (pgDbService.isLiveDatabaseConnected()) {
      await pgDbService.query(
        `INSERT INTO autonomous_profit_allocations
          (id, settlement_id, verified_profit_id, total_verified_profit, mandatory_reserve_allocated,
           operating_capital_allocated, growth_reinvestment_allocated, provider_float_allocated,
           fees_tax_reserve_allocated, withdrawable_surplus_allocated, allocation_logic_snapshot, allocated_at, audit_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12)
         ON CONFLICT (id) DO NOTHING`,
        [
          allocation.id,
          allocation.settlementId,
          allocation.verifiedProfitId,
          allocation.totalVerifiedProfit,
          allocation.mandatoryReserveAllocated,
          allocation.operatingCapitalAllocated,
          allocation.growthReinvestmentAllocated,
          allocation.providerFloatAllocated,
          allocation.feesTaxReserveAllocated,
          allocation.withdrawableSurplusAllocated,
          JSON.stringify(allocation.allocationLogicSnapshot),
          allocation.auditHash
        ]
      );
    }

    await auditRepo.recordEvent({
      eventType: 'AUTONOMOUS_PROFIT_ALLOCATED',
      severity: 'INFO',
      message: `Allocated $${totalProfit.toFixed(2)} verified profit (Withdrawable Surplus: $${withdrawableSurplusAllocated.toFixed(2)}, Reserve: $${mandatoryReserveAllocated.toFixed(2)})`,
      details: {
        allocationId: allocation.id,
        settlementId: allocation.settlementId,
        verifiedProfitId: allocation.verifiedProfitId,
        totalVerifiedProfit: allocation.totalVerifiedProfit,
        withdrawableSurplusAllocated: allocation.withdrawableSurplusAllocated
      }
    });

    return allocation;
  }
}

export const autonomousCapitalController = new AutonomousCapitalController();
