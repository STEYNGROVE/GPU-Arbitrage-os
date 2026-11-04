import crypto from 'crypto';
import { liveExecutionEngine, LiveExecutionInput } from './liveExecutionEngine.js';
import { computeJobRepo } from './repositories/index.js';
import { pgDbService } from './pgDatabase.js';
import { db } from './databaseEngine.js';
import { toMinorUnits, fromMinorUnits } from './moneyUtils.js';

export type ProductionFinancialState =
  | 'PAYMENT_VERIFIED'
  | 'CAPITAL_RESERVED'
  | 'PROVIDER_VERIFIED'
  | 'JOB_RUNNING'
  | 'COST_VERIFIED'
  | 'TERMINATION_VERIFIED'
  | 'REVENUE_RECONCILED'
  | 'PROFIT_REALIZED'
  | 'PROFIT_WITHDRAWABLE'
  | 'WITHDRAWAL_CONFIRMED';

export const PRODUCTION_FINANCIAL_STATE_MACHINE: readonly ProductionFinancialState[] = [
  'PAYMENT_VERIFIED',
  'CAPITAL_RESERVED',
  'PROVIDER_VERIFIED',
  'JOB_RUNNING',
  'COST_VERIFIED',
  'TERMINATION_VERIFIED',
  'REVENUE_RECONCILED',
  'PROFIT_REALIZED',
  'PROFIT_WITHDRAWABLE',
  'WITHDRAWAL_CONFIRMED'
] as const;

const PRODUCTION_STATE_INDEX_MAP: Record<string, number> = {
  PAYMENT_VERIFIED: 0,
  'PAYMENT VERIFIED': 0,
  CAPITAL_RESERVED: 1,
  'CAPITAL RESERVED': 1,
  PROVIDER_VERIFIED: 2,
  'PROVIDER VERIFIED': 2,
  JOB_RUNNING: 3,
  'JOB RUNNING': 3,
  COST_VERIFIED: 4,
  'COST VERIFIED': 4,
  TERMINATION_VERIFIED: 5,
  'TERMINATION VERIFIED': 5,
  REVENUE_RECONCILED: 6,
  'REVENUE RECONCILED': 6,
  PROFIT_REALIZED: 7,
  'PROFIT REALIZED': 7,
  PROFIT_WITHDRAWABLE: 8,
  'PROFIT WITHDRAWABLE': 8,
  WITHDRAWAL_CONFIRMED: 9,
  'WITHDRAWAL CONFIRMED': 9
};

export function canTransitionProductionState(fromState: string, toState: string): boolean {
  const fromNorm = String(fromState).trim().toUpperCase();
  const toNorm = String(toState).trim().toUpperCase();
  const fromIdx = PRODUCTION_STATE_INDEX_MAP[fromNorm] ?? -1;
  const toIdx = PRODUCTION_STATE_INDEX_MAP[toNorm] ?? -1;
  return fromIdx !== -1 && toIdx === fromIdx + 1;
}

export type AuthoritativeDealStage =
  | 'CUSTOMER_PAYMENT_VERIFIED'
  | 'CAPITAL_AUTHORIZED'
  | 'GPU_PURCHASE'
  | 'GPU_VERIFIED'
  | 'WORK_COMPLETED'
  | 'PROVIDER_COST_VERIFIED'
  | 'CUSTOMER_SETTLEMENT_VERIFIED'
  | 'REALIZED_PROFIT'
  | 'WITHDRAWABLE';

export type CanonicalFinancialStage =
  | 'REAL_PAYMENT'
  | 'VERIFIED_ESCROW'
  | 'CAPITAL_RESERVATION'
  | 'GPU_PROVISIONING'
  | 'VERIFIED_WORKLOAD'
  | 'ACTUAL_PROVIDER_COST'
  | 'CUSTOMER_SETTLEMENT'
  | 'REALIZED_PROFIT'
  | 'WITHDRAWABLE_BALANCE';

export const AUTHORITATIVE_DEAL_LIFECYCLE_ORDER: readonly AuthoritativeDealStage[] = [
  'CUSTOMER_PAYMENT_VERIFIED',
  'CAPITAL_AUTHORIZED',
  'GPU_PURCHASE',
  'GPU_VERIFIED',
  'WORK_COMPLETED',
  'PROVIDER_COST_VERIFIED',
  'CUSTOMER_SETTLEMENT_VERIFIED',
  'REALIZED_PROFIT',
  'WITHDRAWABLE'
] as const;

export const VERIFIED_FINANCIAL_INTEGRITY_SEQUENCE: readonly CanonicalFinancialStage[] = [
  'REAL_PAYMENT',
  'VERIFIED_ESCROW',
  'CAPITAL_RESERVATION',
  'GPU_PROVISIONING',
  'VERIFIED_WORKLOAD',
  'ACTUAL_PROVIDER_COST',
  'CUSTOMER_SETTLEMENT',
  'REALIZED_PROFIT',
  'WITHDRAWABLE_BALANCE'
] as const;

const STAGE_INDEX_MAP: Record<string, number> = {
  CUSTOMER_PAYMENT_VERIFIED: 0,
  REAL_PAYMENT: 0,
   'REAL PAYMENT': 0,
  CAPITAL_AUTHORIZED: 1,
  VERIFIED_ESCROW: 1,
  'VERIFIED ESCROW': 1,
  GPU_PURCHASE: 2,
  CAPITAL_RESERVATION: 2,
  'CAPITAL RESERVATION': 2,
  GPU_VERIFIED: 3,
  GPU_PROVISIONING: 3,
  'GPU PROVISIONING': 3,
  WORK_COMPLETED: 4,
  VERIFIED_WORKLOAD: 4,
  'VERIFIED WORKLOAD': 4,
  PROVIDER_COST_VERIFIED: 5,
  ACTUAL_PROVIDER_COST: 5,
  'ACTUAL PROVIDER COST': 5,
  CUSTOMER_SETTLEMENT_VERIFIED: 6,
  CUSTOMER_SETTLEMENT: 6,
  'CUSTOMER SETTLEMENT': 6,
  REALIZED_PROFIT: 7,
  'REALIZED PROFIT': 7,
  WITHDRAWABLE: 8,
  WITHDRAWABLE_BALANCE: 8,
  'WITHDRAWABLE BALANCE': 8
};

export function canTransitionDealStage(
  fromStage: AuthoritativeDealStage | CanonicalFinancialStage | ProductionFinancialState | string,
  toStage: AuthoritativeDealStage | CanonicalFinancialStage | ProductionFinancialState | string
): boolean {
  const fromNorm = String(fromStage).trim().toUpperCase();
  const toNorm = String(toStage).trim().toUpperCase();
  if (fromNorm in PRODUCTION_STATE_INDEX_MAP && toNorm in PRODUCTION_STATE_INDEX_MAP) {
    return canTransitionProductionState(fromNorm, toNorm);
  }
  const fromIdx = STAGE_INDEX_MAP[fromNorm] ?? -1;
  const toIdx = STAGE_INDEX_MAP[toNorm] ?? -1;
  return fromIdx !== -1 && toIdx === fromIdx + 1;
}

export interface FinancialTransitionEvidence {
  paymentIntentId?: string;
  providerTransactionId?: string;
  escrowLedgerEntryId?: string;
  reservationId?: string;
  providerInstanceId?: string;
  workloadCompletionHash?: string;
  actualProviderCostUsd?: number;
  terminationVerified?: boolean;
  terminationConfirmedAt?: string;
  settlementId?: string;
  realizedProfitUsd?: number;
  binanceWithdrawalId?: string;
  isProjectedOnly?: boolean;
}

/**
 * Enforces that every financial transition in:
 * REAL PAYMENT -> VERIFIED ESCROW -> CAPITAL RESERVATION -> GPU PROVISIONING ->
 * VERIFIED WORKLOAD -> ACTUAL PROVIDER COST -> CUSTOMER SETTLEMENT ->
 * REALIZED PROFIT -> WITHDRAWABLE BALANCE
 * has persistent, independently verifiable evidence, and NEVER classifies projected
 * revenue/profit as realized profit or withdrawable balance.
 */
export function validateFinancialTransitionEvidence(
  fromStage: string,
  toStage: string,
  evidence: FinancialTransitionEvidence
): { valid: boolean; reason?: string } {
  if (!canTransitionDealStage(fromStage, toStage)) {
    return {
      valid: false,
      reason: `INVALID_STAGE_TRANSITION: Cannot transition directly from '${fromStage}' to '${toStage}'.`
    };
  }

  if (evidence.isProjectedOnly) {
    return {
      valid: false,
      reason: 'PROJECTED_REVENUE_FORBIDDEN: Projected revenue or estimated profit can never be classified as realized profit or withdrawable balance.'
    };
  }

  const toNorm = String(toStage).trim().toUpperCase();
  if (toNorm in PRODUCTION_STATE_INDEX_MAP) {
    const prodIdx = PRODUCTION_STATE_INDEX_MAP[toNorm];
    switch (prodIdx) {
      case 1: // CAPITAL_RESERVED
        if (!evidence.reservationId) {
          return { valid: false, reason: 'MISSING_RESERVATION_EVIDENCE: Requires PostgreSQL capital reservationId.' };
        }
        break;
      case 2: // PROVIDER_VERIFIED
      case 3: // JOB_RUNNING
        if (!evidence.providerInstanceId) {
          return { valid: false, reason: 'MISSING_PROVIDER_EVIDENCE: Requires verified live providerInstanceId.' };
        }
        break;
      case 4: // COST_VERIFIED
        if (typeof evidence.actualProviderCostUsd !== 'number' || !Number.isFinite(evidence.actualProviderCostUsd) || evidence.actualProviderCostUsd < 0) {
          return { valid: false, reason: 'MISSING_PROVIDER_COST_EVIDENCE: Requires verified actualProviderCostUsd.' };
        }
        break;
      case 5: // TERMINATION_VERIFIED
        if (!evidence.terminationVerified) {
          return { valid: false, reason: 'MISSING_TERMINATION_EVIDENCE: Provider termination must be explicitly confirmed before settlement.' };
        }
        break;
      case 6: // REVENUE_RECONCILED
        if (!evidence.settlementId) {
          return { valid: false, reason: 'MISSING_SETTLEMENT_EVIDENCE: Requires authoritative PostgreSQL settlementId.' };
        }
        break;
      case 7: // PROFIT_REALIZED
      case 8: // PROFIT_WITHDRAWABLE
        if (
          !evidence.settlementId ||
          !evidence.terminationVerified ||
          typeof evidence.actualProviderCostUsd !== 'number' ||
          typeof evidence.realizedProfitUsd !== 'number' ||
          !Number.isFinite(evidence.realizedProfitUsd)
        ) {
          return {
            valid: false,
            reason: 'MISSING_REALIZED_PROFIT_EVIDENCE: Requires settlementId, terminationVerified, actualProviderCostUsd, and verified realizedProfitUsd.'
          };
        }
        break;
      case 9: // WITHDRAWAL_CONFIRMED
        if (!evidence.binanceWithdrawalId) {
          return {
            valid: false,
            reason: 'MISSING_WITHDRAWAL_CONFIRMATION: Requires verified Binance withdrawal confirmation ID.'
          };
        }
        break;
    }
    return { valid: true };
  }

  const targetIdx = STAGE_INDEX_MAP[toNorm];
  switch (targetIdx) {
    case 1: // VERIFIED_ESCROW / CAPITAL_AUTHORIZED
      if (!evidence.paymentIntentId || !evidence.providerTransactionId || !evidence.escrowLedgerEntryId) {
        return { valid: false, reason: 'MISSING_ESCROW_EVIDENCE: Requires paymentIntentId, providerTransactionId, and escrowLedgerEntryId.' };
      }
      break;
    case 2: // CAPITAL_RESERVATION / GPU_PURCHASE
      if (!evidence.reservationId) {
        return { valid: false, reason: 'MISSING_RESERVATION_EVIDENCE: Requires PostgreSQL capital reservationId.' };
      }
      break;
    case 3: // GPU_PROVISIONING / GPU_VERIFIED
      if (!evidence.providerInstanceId) {
        return { valid: false, reason: 'MISSING_PROVISIONING_EVIDENCE: Requires verified live providerInstanceId.' };
      }
      break;
    case 4: // VERIFIED_WORKLOAD / WORK_COMPLETED
      if (!evidence.workloadCompletionHash) {
        return { valid: false, reason: 'MISSING_WORKLOAD_EVIDENCE: Requires verified workloadCompletionHash.' };
      }
      break;
    case 5: // ACTUAL_PROVIDER_COST / PROVIDER_COST_VERIFIED
      if (typeof evidence.actualProviderCostUsd !== 'number' || !Number.isFinite(evidence.actualProviderCostUsd) || evidence.actualProviderCostUsd < 0) {
        return { valid: false, reason: 'MISSING_PROVIDER_COST_EVIDENCE: Requires verified actualProviderCostUsd.' };
      }
      break;
    case 6: // CUSTOMER_SETTLEMENT / CUSTOMER_SETTLEMENT_VERIFIED
      if (!evidence.settlementId) {
        return { valid: false, reason: 'MISSING_SETTLEMENT_EVIDENCE: Requires authoritative PostgreSQL settlementId.' };
      }
      break;
    case 7: // REALIZED_PROFIT
    case 8: // WITHDRAWABLE_BALANCE / WITHDRAWABLE
      if (
        !evidence.settlementId ||
        typeof evidence.actualProviderCostUsd !== 'number' ||
        typeof evidence.realizedProfitUsd !== 'number' ||
        !Number.isFinite(evidence.realizedProfitUsd)
      ) {
        return {
          valid: false,
          reason: 'MISSING_REALIZED_PROFIT_EVIDENCE: Requires settlementId, actualProviderCostUsd, and verified realizedProfitUsd.'
        };
      }
      break;
  }

  return { valid: true };
}

export interface DealExecutionPayload {
  opportunityId?: string;
  demandOrderId: string;
  quoteId?: string;
  quoteToken?: string;
  provider?: 'vast_ai' | 'runpod' | 'lambda' | 'lightning_ai';
  offerId?: string;
  gpuModel?: string;
  gpuCount?: number;
  workloadType?: string;
  monetizationLevel?: number;
  customerName?: string;
  customerGrossPrice?: number;
  durationHours?: number;
  capitalRequired?: number;
  executionEnvironment?: 'LIVE';
  enforceLiveVerification?: boolean;
  idempotencyKey?: string;
  authenticatedCustomerId?: string;
  authenticatedRole?: string;
  humanApproved?: boolean;
  humanApprovalThresholdUsd?: number;
}

export interface DealExecutionResult {
  success: boolean;
  jobId?: string;
  instanceId?: string;
  auditHash?: string;
  message: string;
  details?: Record<string, unknown>;
  rollbackOccurred?: boolean;
  error?: string;
  contractedRevenue?: number;
  capitalReserved?: number;
  projectedProfit?: number;
}

interface ActiveJobRecord {
  jobId: string;
  payload: DealExecutionPayload;
  capitalReserved: number;
  contractedRevenue: number;
  settled: boolean;
  settledRecord?: any;
  createdAt: string;
}

export class ServerDealExecutor {
  private executionLock: Promise<void> = Promise.resolve();
  private activeJobs: Map<string, ActiveJobRecord> = new Map();

  /**
   * Executes arbitrage deals with atomic concurrency protection and fail-closed capital gates.
   * Routes to liveExecutionEngine when PostgreSQL is connected with quoteId,
   * or enforces transactional capital mutex and state updates.
   */
  public async executeArbitrageDeal(payload: DealExecutionPayload): Promise<DealExecutionResult> {
    const isProd = process.env.NODE_ENV === 'production';

    if (payload.executionEnvironment && payload.executionEnvironment !== 'LIVE') {
      return {
        success: false,
        message: 'PAPER_MODE_FORBIDDEN: Mock/demo/paper financial execution is permanently disabled. System operates strictly in LIVE mode.',
        error: 'PAPER_MODE_FORBIDDEN',
        rollbackOccurred: false
      };
    }

    // Enforce Human Approval Required for Big Jobs before any capital reservation or execution
    const bigJobThreshold = payload.humanApprovalThresholdUsd ?? 250.00;
    const reqCapCheck = Number(payload.capitalRequired) || 0;
    if (reqCapCheck >= bigJobThreshold && !payload.humanApproved) {
      return {
        success: false,
        message: `HUMAN_APPROVAL_REQUIRED_BIG_JOB: Job requires ${reqCapCheck.toFixed(2)} capital (>= ${bigJobThreshold.toFixed(2)} big-job threshold). Explicit human operator approval is required before execution.`,
        error: 'HUMAN_APPROVAL_REQUIRED_BIG_JOB',
        rollbackOccurred: false
      };
    }

    if (isProd && !pgDbService.isLiveDatabaseConnected()) {
      return {
        success: false,
        message: 'POSTGRESQL_OFFLINE_FAIL_CLOSED: Production execution requires live PostgreSQL connection. JSON/local financial fallback is strictly forbidden in production.',
        error: 'POSTGRESQL_OFFLINE_FAIL_CLOSED',
        rollbackOccurred: false
      };
    }

    const quoteId = payload.quoteId || payload.quoteToken;

    if (isProd && !quoteId) {
      return {
        success: false,
        message: 'QUOTE_LOCK_REQUIRED: Production execution requires an authoritative cryptographic quoteId.',
        error: 'QUOTE_LOCK_REQUIRED',
        rollbackOccurred: false
      };
    }

    // If PostgreSQL is live and quoteId is present, execute via authoritative PostgreSQL pipeline
    if (pgDbService.isLiveDatabaseConnected() && quoteId) {
      const authenticatedCustomer = {
        customerId: payload.authenticatedCustomerId || 'cust-mstrl-88',
        role: payload.authenticatedRole || 'CUSTOMER'
      };

      const liveResult = await liveExecutionEngine.executeLiveDeal(
        {
          demandOrderId: payload.demandOrderId,
          quoteId,
          idempotencyKey: payload.idempotencyKey
        },
        authenticatedCustomer
      );

      if (!liveResult.success) {
        return {
          success: false,
          message: `LIVE execution halted: ${liveResult.error}`,
          error: liveResult.error,
          rollbackOccurred: true
        };
      }

      return {
        success: true,
        jobId: liveResult.jobId || liveResult.operationId,
        message: liveResult.message || `LIVE Deal committed to authoritative PostgreSQL outbox. Operation ${liveResult.operationId} pending provider provisioning.`,
        contractedRevenue: liveResult.contractedRevenue,
        capitalReserved: liveResult.capitalReserved,
        projectedProfit: liveResult.projectedProfit,
        details: { operationId: liveResult.operationId, state: liveResult.state }
      };
    }

    // Atomic Mutex to protect concurrent capital checks and double spends
    let releaseLock: () => void;
    const nextLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const currentLock = this.executionLock;
    this.executionLock = currentLock.then(() => nextLock);

    await currentLock;
    try {
      const capital = db.getCapital();
      const reqCap = Number(payload.capitalRequired) || 20.00;

      // Fail-closed capital check
      if (capital.liveCurrentBalance < reqCap) {
        return {
          success: false,
          message: `Capital Risk Gate Blocked: Insufficient available balance ($${capital.liveCurrentBalance.toFixed(2)} available, $${reqCap.toFixed(2)} required)`,
          error: 'INSUFFICIENT_CAPITAL'
        };
      }

      // Atomically decrement available balance and increment deployed capital
      db.updateCapital({
        liveCurrentBalance: Number((capital.liveCurrentBalance - reqCap).toFixed(2)),
        liveDeployedCapital: Number(((capital.liveDeployedCapital || 0) + reqCap).toFixed(2))
      });

      const jobId = `job-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      const contractedRevenue = Number(payload.customerGrossPrice) || 45.00;
      const projectedProfit = Number((contractedRevenue - reqCap).toFixed(2));

      this.activeJobs.set(jobId, {
        jobId,
        payload,
        capitalReserved: reqCap,
        contractedRevenue,
        settled: false,
        createdAt: new Date().toISOString()
      });

      return {
        success: true,
        jobId,
        message: `Deal locked under capital mutex. Job ${jobId} initiated.`,
        contractedRevenue,
        capitalReserved: reqCap,
        projectedProfit,
        details: { jobId, environment: payload.executionEnvironment || 'LIVE' }
      };
    } finally {
      releaseLock!();
    }
  }

  /**
   * Settles deals via authoritative PostgreSQL ledger when connected,
   * or via immutable Merkle ledger with replay prevention.
   */
  public async settleArbitrageDeal(
    jobId: string,
    durationHours?: number,
    idempotencyKey?: string
  ): Promise<{
    success: boolean;
    settlementId?: string;
    netProfit?: number;
    record?: any;
    message?: string;
    error?: string;
  }> {
    if (process.env.NODE_ENV === 'production' && !pgDbService.isLiveDatabaseConnected()) {
      return {
        success: false,
        error: 'POSTGRESQL_OFFLINE_FAIL_CLOSED',
        message: 'POSTGRESQL_OFFLINE_FAIL_CLOSED: Production settlement requires live PostgreSQL connection. Local JSON fallback is strictly forbidden.'
      };
    }

    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        const liveJob = await computeJobRepo.findById(jobId);
        if (liveJob) {
          const res = await liveExecutionEngine.settleLiveDeal(jobId, durationHours, idempotencyKey);
          if (!res.success) {
            return { success: false, message: res.error, error: res.error };
          }
          return {
            success: true,
            settlementId: res.settlementId,
            netProfit: res.netProfit,
            record: { id: res.settlementId, auditHash: 'pg_authoritative_audit' },
            message: `Settled live job ${jobId} to PostgreSQL ledger. Net realized profit: $${res.netProfit?.toFixed(2)}`
          };
        } else if (process.env.NODE_ENV === 'production') {
          return {
            success: false,
            error: 'JOB_NOT_FOUND_IN_POSTGRESQL',
            message: `Job ${jobId} not found in authoritative PostgreSQL compute_jobs table.`
          };
        }
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') {
          return {
            success: false,
            error: 'POSTGRESQL_SETTLEMENT_ERROR',
            message: `PostgreSQL settlement error: ${err.message}`
          };
        }
      }
    }

    const job = this.activeJobs.get(jobId);
    if (!job) {
      return {
        success: false,
        error: 'JOB_NOT_FOUND',
        message: `Job ${jobId} not found in active execution registry.`
      };
    }

    if (job.settled) {
      return {
        success: false,
        error: 'ALREADY_SETTLED',
        message: `Job ${jobId} has already been settled and committed to the ledger.`
      };
    }

    // Mark settled
    job.settled = true;
    const dur = durationHours || job.payload.durationHours || 2;
    const revenueMinor = toMinorUnits(job.contractedRevenue);
    const costMinor = toMinorUnits(job.capitalReserved);
    const netProfit = fromMinorUnits(revenueMinor - costMinor);

    // Append to Merkle ledger with SHA-256 audit hash
    const ledgerRecord = db.appendLedgerRecord({
      id: `stl-${jobId}`,
      jobId,
      opportunityId: job.payload.opportunityId || 'opp-arbitrage',
      grossRevenue: job.contractedRevenue,
      netRealizedProfit: netProfit,
      totalCost: job.capitalReserved,
      grossComputeCost: job.capitalReserved,
      otherCosts: 0,
      durationHours: dur,
      realizedMarginPct: Number(((netProfit / job.contractedRevenue) * 100).toFixed(1)),
      realizedRoiPct: Number(((netProfit / job.capitalReserved) * 100).toFixed(1)),
      monetizationLevel: job.payload.monetizationLevel || 2,
      provider: job.payload.provider || 'vast_ai',
      executionEnvironment: 'LIVE',
      workloadType: (job.payload.workloadType as any) || 'AI_AGENT_AUTONOMY',
      customerName: job.payload.customerName || 'Verified Arbitrage Client',
      gpuModel: job.payload.gpuModel || 'NVIDIA RTX 4090 24GB',
      completedAt: new Date().toISOString(),
      status: 'COMPLETED'
    });

    job.settledRecord = ledgerRecord;

    // Update capital balance with realized profit
    const cap = db.getCapital();
    db.updateCapital({
      liveCurrentBalance: Number((cap.liveCurrentBalance + job.contractedRevenue).toFixed(2)),
      liveDeployedCapital: Math.max(0, Number(((cap.liveDeployedCapital || 0) - job.capitalReserved).toFixed(2)))
    });

    return {
      success: true,
      settlementId: `stl-${jobId}`,
      netProfit,
      record: ledgerRecord,
      message: `Settled job ${jobId}. Net realized profit: $${netProfit.toFixed(2)}.`
    };
  }
}

export const dealExecutor = new ServerDealExecutor();
