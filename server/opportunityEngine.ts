/**
 * Authoritative Server-Side Opportunity & Economics Engine
 * Enforces strict financial calculations, multi-component cost breakdowns,
 * and hard risk policy gates on the server.
 * NEVER trusts client-supplied calculated numbers.
 */

import { BackendDemandOrder, CapitalState, QuoteLock } from './databaseEngine.js';
import { toMinorUnits, fromMinorUnits, SupportedCurrency } from './moneyUtils.js';

export interface ProviderRiskMetrics {
  provider: string;
  failureRatePct: number;
  telemetryScore: number;
  billingGranularitySec: number;
  spotEvictionRiskPct: number;
  riskMultiplier: number;
}

export function getProviderRiskMetrics(provider?: string): ProviderRiskMetrics {
  const norm = (provider || 'unknown').toLowerCase();
  if (norm.includes('runpod')) {
    return {
      provider: 'runpod',
      failureRatePct: 2.5,
      telemetryScore: 0.95,
      billingGranularitySec: 1,
      spotEvictionRiskPct: 3.5,
      riskMultiplier: 1.02
    };
  } else if (norm.includes('akash')) {
    return {
      provider: 'akash',
      failureRatePct: 3.8,
      telemetryScore: 0.92,
      billingGranularitySec: 6,
      spotEvictionRiskPct: 0.0,
      riskMultiplier: 1.03
    };
  } else if (norm.includes('salad')) {
    return {
      provider: 'salad',
      failureRatePct: 5.5,
      telemetryScore: 0.91,
      billingGranularitySec: 1,
      spotEvictionRiskPct: 7.0,
      riskMultiplier: 1.05
    };
  } else if (norm.includes('hostinger')) {
    return {
      provider: 'hostinger',
      failureRatePct: 1.2,
      telemetryScore: 0.96,
      billingGranularitySec: 3600,
      spotEvictionRiskPct: 0.0,
      riskMultiplier: 1.01
    };
  } else if (norm.includes('lightning')) {
    return {
      provider: 'lightning_ai',
      failureRatePct: 0.9,
      telemetryScore: 0.97,
      billingGranularitySec: 1,
      spotEvictionRiskPct: 2.5,
      riskMultiplier: 1.01
    };
  } else if (norm.includes('tensordock')) {
    return {
      provider: 'tensordock',
      failureRatePct: 3.0,
      telemetryScore: 0.93,
      billingGranularitySec: 1,
      spotEvictionRiskPct: 4.0,
      riskMultiplier: 1.03
    };
  } else if (norm.includes('hyperstack')) {
    return {
      provider: 'hyperstack',
      failureRatePct: 0.8,
      telemetryScore: 0.98,
      billingGranularitySec: 60,
      spotEvictionRiskPct: 0.0,
      riskMultiplier: 1.005
    };
  } else if (norm.includes('coreweave')) {
    return {
      provider: 'coreweave',
      failureRatePct: 0.5,
      telemetryScore: 0.99,
      billingGranularitySec: 60,
      spotEvictionRiskPct: 0.0,
      riskMultiplier: 1.002
    };
  } else if (norm.includes('lambda')) {
    return {
      provider: 'lambda',
      failureRatePct: 1.0,
      telemetryScore: 0.90,
      billingGranularitySec: 3600,
      spotEvictionRiskPct: 0.0,
      riskMultiplier: 1.01
    };
  } else {
    // Vast.ai or unknown community hosts
    return {
      provider: 'vast_ai',
      failureRatePct: 6.5,
      telemetryScore: 0.80,
      billingGranularitySec: 1,
      spotEvictionRiskPct: 8.0,
      riskMultiplier: 1.06
    };
  }
}

export interface AuthoritativeCostBreakdown {
  computeCost: number;
  storageCost: number;
  bandwidthCost: number;
  providerFees: number;
  paymentProcessingFee: number;
  taxDutyCost: number;
  expectedFailureCost: number;
  refundContingency: number;
  providerRiskBuffer: number;
  totalLandedCost: number;
}

export interface AuthoritativeEconomics {
  grossRevenue: number;
  expectedCosts: AuthoritativeCostBreakdown;
  worstCaseCosts: AuthoritativeCostBreakdown;
  expectedNetContribution: number;
  worstCaseNetContribution: number;
  riskAdjustedExpectedProfit: number;
  expectedMarginPct: number;
  worstCaseMarginPct: number;
  roiPct: number;
  capitalRequired: number;
  currency: SupportedCurrency;
}

export interface HardPolicyCheck {
  id: string;
  name: string;
  passed: boolean;
  actualValue: string;
  threshold: string;
  critical: boolean;
  reason?: string;
}

export interface VerificationResult {
  approved: boolean;
  economics: AuthoritativeEconomics;
  policyChecks: HardPolicyCheck[];
  rejectionReason?: string;
}

export interface RiskLimits {
  maxCapitalExposure: number;
  maxDailySpending: number;
  minProfitDollars: number;
  minMarginPct: number;
  approvedProviders: string[];
  approvedGpuModels: string[];
  humanApprovalThresholdUsd?: number;
}

export const DEFAULT_BIG_JOB_HUMAN_APPROVAL_THRESHOLD_USD = 250.00;

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxCapitalExposure: 5000.00,
  maxDailySpending: 2500.00,
  minProfitDollars: 5.00,
  minMarginPct: 15.0,
  approvedProviders: ['vast_ai', 'runpod', 'lambda', 'akash', 'salad', 'hostinger', 'lightning_ai', 'tensordock', 'hyperstack', 'coreweave'],
  approvedGpuModels: [
    'H100 SXM5 80GB',
    'NVIDIA H100 80GB HBM3',
    'A100 SXM4 80GB',
    'NVIDIA A100-SXM4-80GB',
    'A100 80GB SXM',
    'RTX 4090 24GB',
    'NVIDIA GeForce RTX 4090',
    'RTX A4000 16GB',
    'RTX A5000 24GB',
    'A40 48GB'
  ],
  humanApprovalThresholdUsd: DEFAULT_BIG_JOB_HUMAN_APPROVAL_THRESHOLD_USD
};

export class ServerOpportunityEngine {
  /**
   * Authoritative Cost Breakdown Calculation (Server-Authoritative)
   */
  public static calculateCostBreakdown(
    demand: BackendDemandOrder,
    quote: QuoteLock,
    isWorstCase: boolean = false
  ): AuthoritativeCostBreakdown {
    const hours = BigInt(Math.max(1, demand.durationHours));
    const gpuCount = BigInt(Math.max(1, demand.gpuCount));
    const baseHourlyMinor = toMinorUnits(quote.verifiedHourlyPrice);

    // In worst-case: add 15% compute cost slippage for restart/overrun
    const effectiveHourlyMinor = isWorstCase ? (baseHourlyMinor * 115n) / 100n : baseHourlyMinor;
    const computeCostMinor = effectiveHourlyMinor * gpuCount * hours;

    // Storage cost estimation (50GB scratch NVMe at $0.0003/GB-hr = $0.015/hr = 1.5 cents/hr)
    const storageCostMinor = (hours * 15n + 5n) / 10n;

    // Bandwidth cost (20GB egress at $0.05/GB = 100 cents; 40GB in worst-case = 200 cents)
    const bandwidthCostMinor = isWorstCase ? 200n : 100n;

    // Provider marketplace processing surcharge (2%)
    const providerFeesMinor = (computeCostMinor * 2n) / 100n;

    // Customer payment processing fee (Stripe / Binance Pay / card: 2.9% + $0.30 (30 cents))
    const customerGrossOfferMinor = toMinorUnits(demand.customerGrossOfferPrice);
    const paymentFeeMinor = (customerGrossOfferMinor * 29n) / 1000n + 30n;

    // Regional taxes / duties (0% standard B2B cloud compute)
    const taxDutyCostMinor = 0n;

    // Expected failure buffer (1% unrecoverable failure provision, 5% in worst case)
    const failureMultiplier = isWorstCase ? 5n : 1n;
    const expectedFailureCostMinor = (computeCostMinor * failureMultiplier) / 100n;

    // Refund / dispute contingency reserve (2% standard, 4% worst-case)
    const refundMultiplier = isWorstCase ? 4n : 2n;
    const refundContingencyMinor = (customerGrossOfferMinor * refundMultiplier) / 100n;

    // Provider risk-adjusted buffer (penalize higher failure/spot eviction rates)
    const riskMetrics = getProviderRiskMetrics(quote.provider);
    const riskBps = BigInt(Math.round((isWorstCase ? (riskMetrics.riskMultiplier - 1.0) * 1.5 : (riskMetrics.riskMultiplier - 1.0)) * 10000));
    const providerRiskBufferMinor = (computeCostMinor * riskBps) / 10000n;

    const totalLandedCostMinor = computeCostMinor +
      storageCostMinor +
      bandwidthCostMinor +
      providerFeesMinor +
      paymentFeeMinor +
      taxDutyCostMinor +
      expectedFailureCostMinor +
      refundContingencyMinor +
      providerRiskBufferMinor;

    return {
      computeCost: fromMinorUnits(computeCostMinor),
      storageCost: fromMinorUnits(storageCostMinor),
      bandwidthCost: fromMinorUnits(bandwidthCostMinor),
      providerFees: fromMinorUnits(providerFeesMinor),
      paymentProcessingFee: fromMinorUnits(paymentFeeMinor),
      taxDutyCost: fromMinorUnits(taxDutyCostMinor),
      expectedFailureCost: fromMinorUnits(expectedFailureCostMinor),
      refundContingency: fromMinorUnits(refundContingencyMinor),
      providerRiskBuffer: fromMinorUnits(providerRiskBufferMinor),
      totalLandedCost: fromMinorUnits(totalLandedCostMinor)
    };
  }

  /**
   * Recalculates all economics authoritatively from database entities
   */
  public static calculateEconomics(
    demand: BackendDemandOrder,
    quote: QuoteLock
  ): AuthoritativeEconomics {
    const grossRevenueMinor = toMinorUnits(demand.customerGrossOfferPrice);
    const expectedCosts = this.calculateCostBreakdown(demand, quote, false);
    const worstCaseCosts = this.calculateCostBreakdown(demand, quote, true);

    const expectedCostsMinor = toMinorUnits(expectedCosts.totalLandedCost);
    const worstCaseCostsMinor = toMinorUnits(worstCaseCosts.totalLandedCost);

    const expectedNetContributionMinor = grossRevenueMinor - expectedCostsMinor;
    const worstCaseNetContributionMinor = grossRevenueMinor - worstCaseCostsMinor;

    const expectedMarginPct = grossRevenueMinor > 0n
      ? Number((expectedNetContributionMinor * 1000n) / grossRevenueMinor) / 10
      : 0;

    const worstCaseMarginPct = grossRevenueMinor > 0n
      ? Number((worstCaseNetContributionMinor * 1000n) / grossRevenueMinor) / 10
      : 0;

    const roiPct = expectedCostsMinor > 0n
      ? Number((expectedNetContributionMinor * 1000n) / expectedCostsMinor) / 10
      : 0;

    const hours = BigInt(Math.max(1, demand.durationHours));
    const gpuCount = BigInt(Math.max(1, demand.gpuCount));
    const baseHourlyMinor = toMinorUnits(quote.verifiedHourlyPrice);
    const capitalRequiredMinor = baseHourlyMinor * gpuCount * hours;

    // Risk premium: provider risk buffer + expected failure cost
    const riskPremiumMinor = toMinorUnits(expectedCosts.providerRiskBuffer) + toMinorUnits(expectedCosts.expectedFailureCost);
    // Capital holding cost (annualized 5% hurdle rate amortized over job hours)
    const capitalCostMinor = (capitalRequiredMinor * 5n * hours) / (365n * 24n * 100n);
    const riskAdjustedExpectedProfitMinor = expectedNetContributionMinor - riskPremiumMinor - capitalCostMinor;

    const currency: SupportedCurrency = (demand.escrowCurrency?.toUpperCase() === 'ZAR' ? 'ZAR' : 'USD');

    return {
      grossRevenue: fromMinorUnits(grossRevenueMinor),
      expectedCosts,
      worstCaseCosts,
      expectedNetContribution: fromMinorUnits(expectedNetContributionMinor),
      worstCaseNetContribution: fromMinorUnits(worstCaseNetContributionMinor),
      riskAdjustedExpectedProfit: fromMinorUnits(riskAdjustedExpectedProfitMinor),
      expectedMarginPct,
      worstCaseMarginPct,
      roiPct,
      capitalRequired: fromMinorUnits(capitalRequiredMinor),
      currency
    };
  }

  /**
   * Sorts opportunities by ROI (roiPct) descending, with riskAdjustedExpectedProfit / expectedProfit as tie-breaker.
   */
  public static sortOpportunitiesByRoi<T extends { roiPct?: number; expectedRoiPct?: number; expectedProfit?: number; expectedNetContribution?: number; isProfitable?: boolean }>(
    opportunities: T[]
  ): T[] {
    return [...opportunities].sort((a, b) => {
      if (typeof a.isProfitable === 'boolean' && typeof b.isProfitable === 'boolean' && a.isProfitable !== b.isProfitable) {
        return a.isProfitable ? -1 : 1;
      }
      const aRoi = Number(a.roiPct ?? a.expectedRoiPct ?? 0);
      const bRoi = Number(b.roiPct ?? b.expectedRoiPct ?? 0);
      if (bRoi !== aRoi) {
        return bRoi - aRoi;
      }
      const aProf = Number(a.expectedProfit ?? a.expectedNetContribution ?? 0);
      const bProf = Number(b.expectedProfit ?? b.expectedNetContribution ?? 0);
      return bProf - aProf;
    });
  }

  /**
   * Selects the highest viable opportunity by ROI (roiPct) descending,
   * with riskAdjustedExpectedProfit as tie-breaker.
   */
  public static selectHighestViableOpportunity<T extends { demand: BackendDemandOrder; quote: QuoteLock; verification: VerificationResult }>(
    candidates: T[]
  ): T | null {
    const viable = candidates.filter(c => c.verification.approved && c.verification.economics.riskAdjustedExpectedProfit > 0);
    if (viable.length === 0) return null;
    viable.sort((a, b) => {
      const roiDiff = b.verification.economics.roiPct - a.verification.economics.roiPct;
      if (roiDiff !== 0) return roiDiff;
      return b.verification.economics.riskAdjustedExpectedProfit - a.verification.economics.riskAdjustedExpectedProfit;
    });
    return viable[0];
  }

  /**
   * Validates all hard financial policies on the server before execution
   */
  public static verifyExecutionPolicies(
    demand: BackendDemandOrder,
    quote: QuoteLock,
    capital: CapitalState,
    environment: 'LIVE' = 'LIVE',
    currentlyDeployedCapital: number = 0,
    spentToday: number = 0,
    limits: RiskLimits = DEFAULT_RISK_LIMITS,
    humanApproved: boolean = false
  ): VerificationResult {
    const economics = this.calculateEconomics(demand, quote);
    const checks: HardPolicyCheck[] = [];

    // Rule 1: Confirmed Demand Check
    const validPaymentStatus = ['ESCROW_AUTHORIZED', 'PREPAID_CREDIT', 'SIGNED_CONTRACT', 'ESCROW_FUNDED'].includes(demand.paymentStatus);
    const isLiveDemandValid = (demand.isConfirmed && demand.demandClass === 'CONFIRMED' && validPaymentStatus && demand.demandSource !== 'DEMO_SEED_ORDER');

    checks.push({
      id: 'RULE_1_CONFIRMED_DEMAND',
      name: 'Rule 1: Confirmed Executable Demand',
      passed: isLiveDemandValid,
      actualValue: `${demand.demandClass} (${demand.paymentStatus}, source: ${demand.demandSource})`,
      threshold: 'CONFIRMED with Verified Escrow/Credit, not DEMO',
      critical: true,
      reason: !isLiveDemandValid ? 'LIVE execution requires confirmed, verified demand with authorized escrow.' : undefined
    });

    // Rule 2: Positive Worst-Case Economics
    const rule2Passed = economics.worstCaseNetContribution > 0;
    checks.push({
      id: 'RULE_2_WORST_CASE_PROFIT',
      name: 'Rule 2: Positive Worst-Case Net Contribution',
      passed: rule2Passed,
      actualValue: `$${economics.worstCaseNetContribution.toFixed(2)} (${economics.worstCaseMarginPct}%)`,
      threshold: '> $0.00 Net Contribution in worst case scenario',
      critical: true,
      reason: !rule2Passed ? `Worst-case net contribution is negative: $${economics.worstCaseNetContribution.toFixed(2)}` : undefined
    });

    // Rule 3: Minimum Profit Threshold ($)
    const rule3Passed = economics.expectedNetContribution >= limits.minProfitDollars;
    checks.push({
      id: 'RULE_3_MIN_PROFIT_DOLLARS',
      name: `Rule 3: Minimum Profit Threshold ($${limits.minProfitDollars.toFixed(2)})`,
      passed: rule3Passed,
      actualValue: `$${economics.expectedNetContribution.toFixed(2)}`,
      threshold: `>= $${limits.minProfitDollars.toFixed(2)}`,
      critical: true,
      reason: !rule3Passed ? `Expected profit $${economics.expectedNetContribution.toFixed(2)} below minimum threshold $${limits.minProfitDollars.toFixed(2)}` : undefined
    });

    // Rule 4: Minimum Margin Threshold (%)
    const rule4Passed = economics.expectedMarginPct >= limits.minMarginPct;
    checks.push({
      id: 'RULE_4_MIN_MARGIN_PCT',
      name: `Rule 4: Minimum Margin Threshold (${limits.minMarginPct}%)`,
      passed: rule4Passed,
      actualValue: `${economics.expectedMarginPct}%`,
      threshold: `>= ${limits.minMarginPct}%`,
      critical: true,
      reason: !rule4Passed ? `Expected margin ${economics.expectedMarginPct}% below minimum threshold ${limits.minMarginPct}%` : undefined
    });

    // Rule 5: Available Treasury Capital Check
    // For LIVE mode, capital checks are strictly enforced via PostgreSQL repository advisory locks.
    // For policy evaluation here, use available live unreserved balance.
    const availableCapital = Math.max(0, (capital.liveCurrentBalance - capital.liveDeployedCapital));
    const rule5Passed = availableCapital >= economics.capitalRequired;
    checks.push({
      id: 'RULE_5_SUFFICIENT_CAPITAL',
      name: 'Rule 5: Available Treasury Liquidity',
      passed: rule5Passed,
      actualValue: `Available: $${availableCapital.toFixed(2)}, Required: $${economics.capitalRequired.toFixed(2)}`,
      threshold: `Available >= $${economics.capitalRequired.toFixed(2)}`,
      critical: true,
      reason: !rule5Passed ? `Insufficient liquidity: available $${availableCapital.toFixed(2)} < required $${economics.capitalRequired.toFixed(2)}` : undefined
    });

    // Rule 6: Max Capital Exposure Limit
    const newExposure = currentlyDeployedCapital + economics.capitalRequired;
    const rule6Passed = newExposure <= limits.maxCapitalExposure;
    checks.push({
      id: 'RULE_6_CAPITAL_EXPOSURE',
      name: `Rule 6: Maximum Capital Exposure ($${limits.maxCapitalExposure.toFixed(2)})`,
      passed: rule6Passed,
      actualValue: `Projected Exposure: $${newExposure.toFixed(2)}`,
      threshold: `<= $${limits.maxCapitalExposure.toFixed(2)}`,
      critical: true,
      reason: !rule6Passed ? `Projected capital exposure $${newExposure.toFixed(2)} exceeds cap $${limits.maxCapitalExposure.toFixed(2)}` : undefined
    });

    // Rule 7: Max Daily Spending Limit
    const newDailySpent = spentToday + economics.capitalRequired;
    const rule7Passed = newDailySpent <= limits.maxDailySpending;
    checks.push({
      id: 'RULE_7_DAILY_SPEND',
      name: `Rule 7: Maximum Daily Spending ($${limits.maxDailySpending.toFixed(2)})`,
      passed: rule7Passed,
      actualValue: `Projected Daily Spend: $${newDailySpent.toFixed(2)}`,
      threshold: `<= $${limits.maxDailySpending.toFixed(2)}`,
      critical: false,
      reason: !rule7Passed ? `Projected daily spend $${newDailySpent.toFixed(2)} exceeds cap $${limits.maxDailySpending.toFixed(2)}` : undefined
    });

    // Rule 8: Quote Freshness & SLA Check
    const now = Date.now();
    const isQuoteFresh = quote.expiresAt > now;
    checks.push({
      id: 'RULE_8_QUOTE_FRESHNESS',
      name: 'Rule 8: Cryptographic Quote Lock Freshness (60s SLA)',
      passed: isQuoteFresh,
      actualValue: isQuoteFresh ? `Expires in ${Math.round((quote.expiresAt - now) / 1000)}s` : `Expired ${Math.round((now - quote.expiresAt) / 1000)}s ago`,
      threshold: 'Must not be expired',
      critical: true,
      reason: !isQuoteFresh ? 'Quote has expired. Fresh capacity and price verification required.' : undefined
    });

    // Rule 9: Quote Matching Demand Check
    const isQuoteMatched = quote.demandOrderId === demand.id &&
      quote.gpuCount === demand.gpuCount &&
      quote.durationHours === demand.durationHours;
    checks.push({
      id: 'RULE_9_QUOTE_MATCH',
      name: 'Rule 9: Quote Contract Compatibility',
      passed: isQuoteMatched,
      actualValue: `Quote orderId: ${quote.demandOrderId}, count: ${quote.gpuCount}, dur: ${quote.durationHours}h`,
      threshold: `Demand orderId: ${demand.id}, count: ${demand.gpuCount}, dur: ${demand.durationHours}h`,
      critical: true,
      reason: !isQuoteMatched ? 'Quote parameters do not match demand order requirements.' : undefined
    });

    // Rule 10: Provider Risk & Telemetry Suitability Check
    const riskMetrics = getProviderRiskMetrics(quote.provider);
    const requiresHighMargin = riskMetrics.failureRatePct > 5.0;
    const rule10Passed = !requiresHighMargin || economics.expectedMarginPct >= 20.0;
    checks.push({
      id: 'RULE_10_PROVIDER_RISK_ADJUSTMENT',
      name: `Rule 10: Provider Risk-Adjusted Score (${quote.provider})`,
      passed: rule10Passed,
      actualValue: `Failure rate: ${riskMetrics.failureRatePct}%, Margin: ${economics.expectedMarginPct}%, Telemetry: ${Math.round(riskMetrics.telemetryScore * 100)}%`,
      threshold: requiresHighMargin ? 'High-risk provider requires >= 20% margin' : 'Acceptable provider baseline',
      critical: true,
      reason: !rule10Passed ? `Provider ${quote.provider} failure rate of ${riskMetrics.failureRatePct}% requires >= 20% margin premium, but deal offers only ${economics.expectedMarginPct}%.` : undefined
    });

    // Rule 11: Human Approval Required for Big Jobs
    const bigJobThreshold = limits.humanApprovalThresholdUsd ?? DEFAULT_BIG_JOB_HUMAN_APPROVAL_THRESHOLD_USD;
    const isBigJob = economics.capitalRequired >= bigJobThreshold;
    const rule11Passed = !isBigJob || humanApproved;
    checks.push({
      id: 'RULE_11_BIG_JOB_HUMAN_APPROVAL',
      name: `Rule 11: Big Job Human Approval Gate (${bigJobThreshold.toFixed(2)})`,
      passed: rule11Passed,
      actualValue: isBigJob
        ? `Big Job (${economics.capitalRequired.toFixed(2)}) — ${humanApproved ? 'HUMAN_APPROVED' : 'AWAITING_HUMAN_APPROVAL'}`
        : `Standard Job (${economics.capitalRequired.toFixed(2)} < ${bigJobThreshold.toFixed(2)})`,
      threshold: `Jobs >= ${bigJobThreshold.toFixed(2)} require explicit Human Approval`,
      critical: true,
      reason: !rule11Passed
        ? `HUMAN_APPROVAL_REQUIRED_BIG_JOB: Job requires ${economics.capitalRequired.toFixed(2)} capital (>= ${bigJobThreshold.toFixed(2)} big-job threshold). Explicit human operator approval is required before execution.`
        : undefined
    });

    const failedCriticalCheck = checks.find(c => c.critical && !c.passed);
    const approved = !failedCriticalCheck;

    return {
      approved,
      economics,
      policyChecks: checks,
      rejectionReason: failedCriticalCheck?.reason || (approved ? undefined : 'One or more policy checks failed.')
    };
  }
}

// ============================================================================
// PIPELINE A (OPPORTUNITY DISCOVERY) & PIPELINE B (EXECUTION GATE)
// Opportunity discovery operates 100% independently of treasury funding.
// ============================================================================

import { pgDbService } from './pgDatabase.js';

export type AuthoritativeOpportunityState =
  | 'DISCOVERED'
  | 'PRICED'
  | 'PROFITABLE'
  | 'CAPITAL_BLOCKED'
  | 'PROVIDER_BLOCKED'
  | 'CUSTOMER_REQUIRED'
  | 'EXECUTABLE'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'REJECTED';

export const AUTHORITATIVE_OPPORTUNITY_STATES: readonly AuthoritativeOpportunityState[] = [
  'DISCOVERED',
  'PRICED',
  'PROFITABLE',
  'CAPITAL_BLOCKED',
  'PROVIDER_BLOCKED',
  'CUSTOMER_REQUIRED',
  'EXECUTABLE',
  'EXECUTING',
  'COMPLETED',
  'EXPIRED',
  'REJECTED'
] as const;

export interface ExpectedFinancialForecast {
  expectedRevenue: number;
  expectedProviderCost: number;
  expectedPaymentFees: number;
  expectedNetworkFees: number;
  expectedPlatformCosts: number;
  expectedFees: number;
  expectedProfit: number;
  expectedMargin: number;
  expectedRoiPct: number;
}

export interface RealizedFinancialSettlement {
  verifiedCustomerPayment: number;
  actualProviderCost: number;
  actualSettlement: number;
  realizedRevenue: number;
  realizedProfit: number;
  withdrawableBalance: number;
}

export interface DiscoveredMarketOpportunity {
  opportunityId: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  sourceTimestamp: string;
  priceTimestamp: string;
  providerTimestamp: string;
  customerPriceTimestamp: string;
  confidence: number;

  customerDemandSource: string;
  customerId?: string | null;
  customerName?: string;
  demandOrderId?: string | null;
  customerPrice: number;
  customerPriceHourly: number;
  customerPriceCurrency: 'USD' | 'ZAR';

  gpuType: string;
  gpuQuantity: number;
  runtimeHours: number;
  workloadType?: string;
  workloadName?: string;
  customerPaysFor?: string;
  workloadExample?: string;
  unitBillingMetric?: string;
  vramGb: number;
  region: string;
  location: string;

  provider: 'vast_ai' | 'runpod' | 'lambda';
  providerOfferId: string;
  providerPriceHourly: number;
  providerCost: number;

  // Expected Forecast (Strictly Forecasts Only — Never Enters Realized Ledger)
  expectedRevenueUsd: number;
  expectedProviderCostUsd: number;
  expectedPaymentFeesUsd: number;
  expectedNetworkFeesUsd: number;
  expectedPlatformCostsUsd: number;
  estimatedFeesUsd: number;
  estimatedGrossProfitUsd: number;
  expectedMarginPct: number;
  expectedRoiPct: number;
  roiPct: number;

  // Canonical Forecast Aliases (Requirement 5 & 11)
  expectedRevenue: number;
  expectedProviderCost: number;
  expectedPaymentFees: number;
  expectedNetworkFees: number;
  expectedPlatformCosts: number;
  expectedFees: number;
  expectedProfit: number;
  expectedMargin: number;

  // Capital Gate & Execution Assessment (Requirement 3, 4, 6, 8)
  requiredCapitalUsd: number;
  verifiedAvailableCapitalUsd: number;
  capitalShortfallUsd: number;

  // Big Job Human Approval Gate
  isBigJob: boolean;
  requiresHumanApproval: boolean;
  humanApproved?: boolean;
  humanApprovalThresholdUsd: number;

  discoveryStatus: 'DISCOVERED' | 'PRICED' | 'PROFITABLE' | 'EXPIRED' | 'REJECTED';
  status: AuthoritativeOpportunityState;
  executionEligible: boolean;
  blockReasons: string[];

  // Category Flags for Dashboard Filtering
  isProfitable: boolean;
  isCapitalBlocked: boolean;
  isProviderBlocked: boolean;
  isCustomerRequired: boolean;
  isExecutable: boolean;
}

export interface OpportunityDashboardSummary {
  dataStatus: 'LIVE_DATA_ACTIVE' | 'DATA_UNAVAILABLE';
  lastMarketUpdate: string;
  lastMarketUpdateFormatted: string;
  timezone: string;
  zeroCapitalMode: boolean;
  verifiedAvailableCapitalUsd: number;
  pipelineState: {
    discovery: 'ACTIVE' | 'DATA_UNAVAILABLE';
    pricing: 'ACTIVE' | 'DATA_UNAVAILABLE';
    profitabilityAnalysis: 'ACTIVE' | 'DATA_UNAVAILABLE';
    opportunityDashboard: 'ACTIVE';
    gpuProvisioning: 'ACTIVE' | 'BLOCKED';
    capitalDeployment: 'ACTIVE' | 'BLOCKED';
    customerSettlement: 'ACTIVE' | 'BLOCKED';
    treasuryWithdrawal: 'ACTIVE' | 'BLOCKED';
  };
  counts: {
    realOpportunities: number;
    profitable: number;
    executableNow: number;
    capitalBlocked: number;
    providerBlocked: number;
    customerRequired: number;
    expired: number;
    rejected: number;
  };
  capitalRequirementsSummary?: {
    totalProfitableJobs: number;
    totalRequiredCapitalForProfitableUsd: number;
    verifiedAvailableCapitalUsd: number;
    totalCapitalShortfallForProfitableUsd: number;
    requiredCapitalForBestOpportunityUsd: number;
    totalExpectedRevenueForProfitableUsd: number;
    totalExpectedProviderCostForProfitableUsd: number;
    totalExpectedFeesForProfitableUsd: number;
    totalExpectedNetProfitForProfitableUsd: number;
    weightedExpectedMarginPct: number;
    weightedExpectedRoiPct: number;
  };
  opportunities: DiscoveredMarketOpportunity[];
}

export interface ExecutionGateCheckInput {
  opportunity: DiscoveredMarketOpportunity;
  customerVerified: boolean;
  paymentVerified: boolean;
  paymentDestinationVerified: boolean;
  paymentAmountVerified: boolean;
  verifiedAvailableCapitalUsd: number;
  providerAccountFunded: boolean;
  providerCapacityAvailable: boolean;
  quoteStillValid: boolean;
  priceStillValid: boolean;
  riskLimitsPassed: boolean;
  treasuryLimitsPassed: boolean;
  duplicateProtectionPassed: boolean;
  nowMs?: number;
}

export interface ExecutionGateCheckResult {
  executionEligible: boolean;
  status: AuthoritativeOpportunityState;
  blockReasons: string[];
  checks: Record<string, boolean>;
}

/**
 * Normalizes raw GPU model strings from Vast.ai, RunPod, and Lambda into canonical GPU architectures
 */
export function normalizeCanonicalGpuType(rawName: string, vramGb: number = 24): {
  canonicalGpu: string;
  canonicalVramGb: number;
} {
  const n = (rawName || '').toUpperCase().trim();
  if (n.includes('H200')) {
    return { canonicalGpu: 'H200 141GB', canonicalVramGb: Math.max(vramGb, 141) };
  }
  if (n.includes('H100')) {
    if (n.includes('PCIE') || n.includes('NVL')) {
      return { canonicalGpu: 'H100 PCIe 80GB', canonicalVramGb: Math.max(vramGb, 80) };
    }
    return { canonicalGpu: 'H100 SXM5 80GB', canonicalVramGb: Math.max(vramGb, 80) };
  }
  if (n.includes('A100') || n.includes('A800')) {
    if (n.includes('PCIE') && vramGb < 60 && !n.includes('80GB')) {
      return { canonicalGpu: 'A100 40GB PCIe', canonicalVramGb: 40 };
    }
    return { canonicalGpu: 'A100 80GB SXM', canonicalVramGb: 80 };
  }
  if (n.includes('L40')) {
    return { canonicalGpu: 'L40S 48GB', canonicalVramGb: 48 };
  }
  if (n.includes('6000') && (n.includes('ADA') || n.includes('PRO') || n.includes('6000D') || n.includes('5880'))) {
    return { canonicalGpu: 'RTX 6000 Ada 48GB', canonicalVramGb: Math.max(vramGb, 48) };
  }
  if (n.includes('A6000')) {
    return { canonicalGpu: 'A6000 48GB', canonicalVramGb: 48 };
  }
  if (n.includes('4090')) {
    return { canonicalGpu: 'RTX 4090 24GB', canonicalVramGb: 24 };
  }
  if (n.includes('3090')) {
    return { canonicalGpu: 'RTX 3090 24GB', canonicalVramGb: 24 };
  }
  return { canonicalGpu: rawName.trim() || 'RTX 4090 24GB', canonicalVramGb: vramGb || 24 };
}

/**
 * Formats a Date into local system timezone string: YYYY-MM-DD HH:mm:ss
 */
export function formatSystemTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

/**
 * Requirement 11: Authoritative Profitability Engine
 * Calculates expectedProfit including ALL known costs:
 * expectedProfit = expectedCustomerRevenue - expectedProviderCost - expectedPaymentFees - expectedNetworkFees - expectedPlatformCosts
 * expectedMargin = expectedProfit / expectedCustomerRevenue
 */
export function calculateOpportunityProfitability(params: {
  expectedCustomerRevenue: number;
  providerPriceHourly: number;
  gpuQuantity: number;
  runtimeHours: number;
  provider: string;
  storageCostUsd?: number;
  bandwidthCostUsd?: number;
}): ExpectedFinancialForecast {
  const revMinor = toMinorUnits(Math.max(0, params.expectedCustomerRevenue));
  const qty = BigInt(Math.max(1, Math.round(params.gpuQuantity)));
  const hoursHundredths = BigInt(Math.max(100, Math.round(params.runtimeHours * 100)));
  const hourlyMinor = toMinorUnits(Math.max(0, params.providerPriceHourly));

  // expectedProviderCost = hourlyPrice * qty * hours
  const providerCostMinor = (hourlyMinor * qty * hoursHundredths + 50n) / 100n;

  // expectedPaymentFees: 2.0% settlement/escrow clearing + $0.15 network settlement fee
  const paymentFeesMinor = (revMinor * 20n) / 1000n + 15n;

  // expectedNetworkFees: storage + bandwidth + BSC gas reserve ($0.10)
  const storageMinor = params.storageCostUsd !== undefined
    ? toMinorUnits(params.storageCostUsd)
    : (hoursHundredths * 2n) / 100n; // $0.02/hr NVMe scratch
  const bandwidthMinor = params.bandwidthCostUsd !== undefined
    ? toMinorUnits(params.bandwidthCostUsd)
    : 20n; // $0.20 egress + on-chain gas
  const networkFeesMinor = storageMinor + bandwidthMinor;

  // expectedPlatformCosts: provider marketplace booking fee (1.5% - 2.0%) + interruption buffer (1.0%)
  const providerFeeBps = params.provider === 'vast_ai' ? 200n : 150n;
  const platformCostsMinor = (providerCostMinor * (providerFeeBps + 100n)) / 10000n;

  const totalFeesMinor = paymentFeesMinor + networkFeesMinor + platformCostsMinor;
  const expectedProfitMinor = revMinor - providerCostMinor - totalFeesMinor;

  const expectedRevenue = fromMinorUnits(revMinor);
  const expectedProviderCost = fromMinorUnits(providerCostMinor);
  const expectedPaymentFees = fromMinorUnits(paymentFeesMinor);
  const expectedNetworkFees = fromMinorUnits(networkFeesMinor);
  const expectedPlatformCosts = fromMinorUnits(platformCostsMinor);
  const expectedFees = fromMinorUnits(totalFeesMinor);
  const expectedProfit = fromMinorUnits(expectedProfitMinor);

  const expectedMargin = expectedRevenue > 0
    ? Math.round((expectedProfit / expectedRevenue) * 10000) / 100
    : 0;
  const expectedRoiPct = expectedProviderCost > 0
    ? Math.round((expectedProfit / expectedProviderCost) * 10000) / 100
    : 0;

  return {
    expectedRevenue,
    expectedProviderCost,
    expectedPaymentFees,
    expectedNetworkFees,
    expectedPlatformCosts,
    expectedFees,
    expectedProfit,
    expectedMargin,
    expectedRoiPct
  };
}

/**
 * Requirement 5: Hard Financial Separation Guard
 * Prevents any expected/forecast profit or revenue object from ever entering
 * treasury_ledger, realized_profit, withdrawable_balance, or customer_settlement.
 */
export function assertNotExpectedForecastMoney(
  payload: Record<string, unknown>,
  targetTable: 'treasury_ledger' | 'realized_profit' | 'withdrawable_balance' | 'customer_settlement'
): { valid: boolean; reason?: string } {
  if (
    payload.isExpectedForecast === true ||
    payload.isProjectedOnly === true ||
    ('expectedProfit' in payload && !('realizedProfit' in payload) && !('verifiedRealizedProfit' in payload)) ||
    ('estimatedGrossProfitUsd' in payload && !('actualProviderCost' in payload))
  ) {
    return {
      valid: false,
      reason: `FORECAST_CONTAMINATION_BLOCKED: Expected/forecast financial values cannot enter authoritative '${targetTable}'.`
    };
  }
  return { valid: true };
}

/**
 * Requirement 12: PIPELINE B — Authoritative 13-Condition Execution Gate
 * Checks every required condition before spending any money.
 * Capital affects ONLY executionEligible, NEVER discovery or profitability!
 */
export function evaluateExecutionGate(input: ExecutionGateCheckInput): ExecutionGateCheckResult {
  const nowMs = input.nowMs ?? Date.now();
  const expiresAtMs = new Date(input.opportunity.expiresAt).getTime();
  const opportunityNotExpired = Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
  const capitalAvailable = (input.verifiedAvailableCapitalUsd >= input.opportunity.requiredCapitalUsd && input.opportunity.requiredCapitalUsd > 0) || Boolean(input.providerAccountFunded);

  const checks: Record<string, boolean> = {
    customerVerified: Boolean(input.customerVerified),
    paymentVerified: Boolean(input.paymentVerified),
    paymentDestinationVerified: Boolean(input.paymentDestinationVerified),
    paymentAmountVerified: Boolean(input.paymentAmountVerified),
    capitalAvailable,
    providerAccountFunded: Boolean(input.providerAccountFunded),
    providerCapacityAvailable: Boolean(input.providerCapacityAvailable),
    quoteStillValid: Boolean(input.quoteStillValid),
    priceStillValid: Boolean(input.priceStillValid),
    opportunityNotExpired,
    riskLimitsPassed: Boolean(input.riskLimitsPassed),
    treasuryLimitsPassed: Boolean(input.treasuryLimitsPassed),
    duplicateProtectionPassed: Boolean(input.duplicateProtectionPassed)
  };

  const blockReasons: string[] = [];

  if (!opportunityNotExpired) {
    blockReasons.push('OPPORTUNITY_EXPIRED');
  }
  if (!checks.capitalAvailable) {
    blockReasons.push('INSUFFICIENT_OPERATING_CAPITAL');
  }
  if (!checks.customerVerified) {
    blockReasons.push('CUSTOMER_VERIFICATION_REQUIRED');
  }
  if (!checks.paymentVerified) {
    blockReasons.push('CUSTOMER_PAYMENT_UNVERIFIED');
  }
  if (!checks.paymentDestinationVerified) {
    blockReasons.push('PAYMENT_DESTINATION_UNVERIFIED');
  }
  if (!checks.paymentAmountVerified) {
    blockReasons.push('PAYMENT_AMOUNT_INSUFFICIENT');
  }
  if (!checks.providerAccountFunded) {
    blockReasons.push('PROVIDER_ACCOUNT_UNFUNDED');
  }
  if (!checks.providerCapacityAvailable) {
    blockReasons.push('PROVIDER_CAPACITY_UNAVAILABLE');
  }
  if (!checks.quoteStillValid) {
    blockReasons.push('QUOTE_INVALID_OR_EXPIRED');
  }
  if (!checks.priceStillValid) {
    blockReasons.push('PROVIDER_PRICE_SURGED');
  }
  if (!checks.riskLimitsPassed) {
    blockReasons.push('RISK_LIMITS_FAILED');
  }
  if (!checks.treasuryLimitsPassed) {
    blockReasons.push('TREASURY_LIMITS_FAILED');
  }
  if (!checks.duplicateProtectionPassed) {
    blockReasons.push('DUPLICATE_EXECUTION_BLOCKED');
  }

  const executionEligible = blockReasons.length === 0 && input.opportunity.discoveryStatus === 'PROFITABLE';

  let status: AuthoritativeOpportunityState = 'DISCOVERED';
  if (!opportunityNotExpired) {
    status = 'EXPIRED';
  } else if (input.opportunity.discoveryStatus === 'REJECTED' || !checks.riskLimitsPassed) {
    status = 'REJECTED';
  } else if (executionEligible) {
    status = 'EXECUTABLE';
  } else if (!checks.capitalAvailable) {
    // Requirement 3 & 6: An opportunity with insufficient capital must remain visible as PROFITABLE + CAPITAL_BLOCKED
    status = 'CAPITAL_BLOCKED';
  } else if (!checks.providerAccountFunded || !checks.providerCapacityAvailable) {
    status = 'PROVIDER_BLOCKED';
  } else if (!checks.customerVerified || !checks.paymentVerified || !checks.paymentDestinationVerified || !checks.paymentAmountVerified) {
    status = 'CUSTOMER_REQUIRED';
  } else {
    status = 'CAPITAL_BLOCKED';
  }

  return {
    executionEligible,
    status,
    blockReasons,
    checks
  };
}

export interface ServerGpuWorkloadSpec {
  id: string;
  name: string;
  customerPaysFor: string;
  example: string;
  unitPricingBenchmark: string;
  preferredGpus: string[];
  defaultHours: number;
}

export const SERVER_GPU_WORKLOAD_CATALOG: readonly ServerGpuWorkloadSpec[] = [
  {
    id: 'LLM_INFERENCE',
    name: 'AI inference',
    customerPaysFor: 'GPU time per request/token',
    example: 'LLM API, image analysis, embeddings',
    unitPricingBenchmark: '$0.0018 / 1K tokens (~45k tok/hr)',
    preferredGpus: ['H100 SXM5 80GB', 'H100 PCIe 80GB', 'A100 80GB SXM', 'L40S 48GB', 'RTX 4090 24GB'],
    defaultHours: 8
  },
  {
    id: 'LLM_HOSTING',
    name: 'LLM hosting',
    customerPaysFor: 'Dedicated GPU endpoint',
    example: 'Host an open-source model/API',
    unitPricingBenchmark: 'Dedicated SLA Endpoint ($/GPU-hr)',
    preferredGpus: ['H200 141GB', 'H100 SXM5 80GB', 'A100 80GB SXM', 'L40S 48GB'],
    defaultHours: 24
  },
  {
    id: 'AI_PRODUCTION_IMAGE',
    name: 'Image generation',
    customerPaysFor: 'Images generated',
    example: 'Stable Diffusion/Flux-style generation',
    unitPricingBenchmark: '$0.014 / image (~320 imgs/GPU-hr)',
    preferredGpus: ['RTX 4090 24GB', 'L40S 48GB', 'RTX 6000 Ada 48GB', 'A6000 48GB'],
    defaultHours: 6
  },
  {
    id: 'AI_PRODUCTION_VIDEO',
    name: 'Video generation',
    customerPaysFor: 'Video frames/seconds',
    example: 'AI video generation',
    unitPricingBenchmark: '$0.085 / video sec (~60 sec/GPU-hr)',
    preferredGpus: ['H100 SXM5 80GB', 'A100 80GB SXM', 'L40S 48GB', 'RTX 6000 Ada 48GB'],
    defaultHours: 8
  },
  {
    id: '3D_RENDERING',
    name: '3D rendering',
    customerPaysFor: 'Render time',
    example: 'Blender/Cycles rendering',
    unitPricingBenchmark: 'OptiX Ray-Traced Render Time ($/GPU-hr)',
    preferredGpus: ['RTX 4090 24GB', 'RTX 6000 Ada 48GB', 'A6000 48GB', 'RTX 3090 24GB'],
    defaultHours: 4
  },
  {
    id: 'AI_MODEL_TRAINING',
    name: 'AI model training',
    customerPaysFor: 'GPU-hours',
    example: 'Fine-tuning models',
    unitPricingBenchmark: 'Cluster Training Compute ($/GPU-hr)',
    preferredGpus: ['H200 141GB', 'H100 SXM5 80GB', 'H100 PCIe 80GB', 'A100 80GB SXM'],
    defaultHours: 24
  },
  {
    id: 'FINE_TUNING',
    name: 'LoRA fine-tuning',
    customerPaysFor: 'Training jobs',
    example: 'Customer-specific models',
    unitPricingBenchmark: 'Per-Job Adapter Training ($/job)',
    preferredGpus: ['A100 80GB SXM', 'A100 40GB PCIe', 'L40S 48GB', 'RTX 4090 24GB'],
    defaultHours: 6
  },
  {
    id: 'WHISPER_TRANSCRIPTION',
    name: 'Whisper transcription',
    customerPaysFor: 'Audio processed',
    example: 'Bulk transcription',
    unitPricingBenchmark: '$0.0035 / audio min (~1,200 min/GPU-hr)',
    preferredGpus: ['RTX 4090 24GB', 'L40S 48GB', 'A100 40GB PCIe', 'RTX 3090 24GB'],
    defaultHours: 4
  },
  {
    id: 'VIDEO_TRANSCODING',
    name: 'Video transcoding',
    customerPaysFor: 'Video processing',
    example: 'Batch conversion/encoding',
    unitPricingBenchmark: '$0.018 / GB NVENC 4K/8K stream',
    preferredGpus: ['RTX 4090 24GB', 'L40S 48GB', 'A6000 48GB', 'RTX 3090 24GB'],
    defaultHours: 4
  },
  {
    id: 'COMPUTER_VISION',
    name: 'Computer vision',
    customerPaysFor: 'Image/video analysis',
    example: 'Object detection/classification',
    unitPricingBenchmark: '$0.0008 / frame analyzed (~5,000 fps)',
    preferredGpus: ['RTX 4090 24GB', 'L40S 48GB', 'A100 40GB PCIe', 'RTX 6000 Ada 48GB'],
    defaultHours: 8
  },
  {
    id: 'OCR_PROCESSING',
    name: 'OCR',
    customerPaysFor: 'Documents/images processed',
    example: 'Large document processing',
    unitPricingBenchmark: '$0.0025 / page (~1,800 pages/GPU-hr)',
    preferredGpus: ['RTX 4090 24GB', 'L40S 48GB', 'RTX 3090 24GB', 'A6000 48GB'],
    defaultHours: 4
  },
  {
    id: 'SCIENTIFIC_COMPUTE',
    name: 'Scientific compute',
    customerPaysFor: 'GPU computation',
    example: 'Simulation/optimization',
    unitPricingBenchmark: 'FP64/FP32 CUDA Compute ($/GPU-hr)',
    preferredGpus: ['H100 SXM5 80GB', 'H100 PCIe 80GB', 'A100 80GB SXM', 'A100 40GB PCIe'],
    defaultHours: 12
  },
  {
    id: 'BATCH_AI_PROCESSING',
    name: 'Batch data processing',
    customerPaysFor: 'GPU workloads',
    example: 'Large-scale analytics',
    unitPricingBenchmark: 'RAPIDS cuDF/cuML Batch ($/workload)',
    preferredGpus: ['A100 80GB SXM', 'H100 PCIe 80GB', 'L40S 48GB', 'RTX 6000 Ada 48GB'],
    defaultHours: 8
  },
  {
    id: 'PROTEIN_BIOLOGY',
    name: 'Protein/biology workloads',
    customerPaysFor: 'Scientific GPU time',
    example: 'Molecular/biological computation',
    unitPricingBenchmark: 'AlphaFold / GROMACS Folding ($/GPU-hr)',
    preferredGpus: ['H100 SXM5 80GB', 'A100 80GB SXM', 'RTX 6000 Ada 48GB', 'L40S 48GB'],
    defaultHours: 12
  },
  {
    id: 'RENDERING_FARM',
    name: 'Rendering farm',
    customerPaysFor: 'Frames/jobs',
    example: 'Animation/VFX',
    unitPricingBenchmark: '$0.38 / VFX frame (~12 frames/GPU-hr)',
    preferredGpus: ['RTX 4090 24GB', 'RTX 6000 Ada 48GB', 'L40S 48GB', 'A6000 48GB'],
    defaultHours: 8
  },
  {
    id: 'GAME_SERVER_WORKLOADS',
    name: 'Game/server workloads',
    customerPaysFor: 'GPU compute',
    example: 'Specialized workloads',
    unitPricingBenchmark: 'Pixel Streaming / Physics Sim ($/GPU-hr)',
    preferredGpus: ['RTX 4090 24GB', 'L40S 48GB', 'RTX 6000 Ada 48GB', 'RTX 3090 24GB'],
    defaultHours: 12
  }
];

export function resolveServerWorkloadSpec(workloadType?: string, gpuType?: string, seedIndex: number = 0): ServerGpuWorkloadSpec {
  if (workloadType) {
    const found = SERVER_GPU_WORKLOAD_CATALOG.find(
      w => w.id === workloadType || w.name.toLowerCase() === workloadType.toLowerCase()
    );
    if (found) return found;
  }
  const matching = gpuType
    ? SERVER_GPU_WORKLOAD_CATALOG.filter(w => w.preferredGpus.includes(gpuType))
    : [];
  const pool = matching.length > 0 ? matching : SERVER_GPU_WORKLOAD_CATALOG;
  return pool[Math.abs(seedIndex) % pool.length];
}

/**
 * PIPELINE A — Authoritative Opportunity Discovery Service
 * Discovers, prices, ranks, and persists REAL market opportunities completely independently of treasury funding.
 */
export class OpportunityDiscoveryPipeline {
  private lastDiscoverySummary: OpportunityDashboardSummary | null = null;

  /**
   * Evaluates a single candidate opportunity from real supply and demand/market pricing
   * without ever filtering out or hiding opportunities when capital = $0.
   */
  public evaluateDiscoveredCandidate(params: {
    opportunityId: string;
    source: string;
    customerDemandSource: string;
    customerId?: string | null;
    customerName?: string;
    demandOrderId?: string | null;
    customerPriceHourly: number;
    customerPriceCurrency?: 'USD' | 'ZAR';
    gpuType: string;
    gpuQuantity: number;
    runtimeHours: number;
    workloadType?: string;
    workloadName?: string;
    customerPaysFor?: string;
    workloadExample?: string;
    unitBillingMetric?: string;
    vramGb: number;
    region: string;
    location: string;
    provider: 'vast_ai' | 'runpod' | 'lambda';
    providerOfferId: string;
    providerPriceHourly: number;
    verifiedAvailableCapitalUsd: number;
    customerVerified: boolean;
    paymentVerified: boolean;
    providerAccountFunded: boolean;
    providerCapacityAvailable: boolean;
    minMarginPct?: number;
    minProfitUsd?: number;
    sourceTimestamp?: string;
    priceTimestamp?: string;
    providerTimestamp?: string;
    customerPriceTimestamp?: string;
    expiresAt?: string;
    confidence?: number;
    humanApprovalThresholdUsd?: number;
    humanApproved?: boolean;
  }): DiscoveredMarketOpportunity {
    const nowIso = new Date().toISOString();
    const expiresAtIso = params.expiresAt || new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const minMarginPct = params.minMarginPct ?? 8.0;
    const minProfitUsd = params.minProfitUsd ?? 0.50;
    const humanApprovalThresholdUsd = params.humanApprovalThresholdUsd ?? DEFAULT_BIG_JOB_HUMAN_APPROVAL_THRESHOLD_USD;

    const expectedCustomerRevenue = Math.round(params.customerPriceHourly * params.gpuQuantity * params.runtimeHours * 100) / 100;
    const forecast = calculateOpportunityProfitability({
      expectedCustomerRevenue,
      providerPriceHourly: params.providerPriceHourly,
      gpuQuantity: params.gpuQuantity,
      runtimeHours: params.runtimeHours,
      provider: params.provider
    });

    const requiredCapitalUsd = forecast.expectedProviderCost;
    const verifiedAvailableCapitalUsd = Math.max(0, Math.round(params.verifiedAvailableCapitalUsd * 100) / 100);
    const capitalShortfallUsd = Math.max(0, Math.round((requiredCapitalUsd - verifiedAvailableCapitalUsd) * 100) / 100);

    const isBigJob = requiredCapitalUsd >= humanApprovalThresholdUsd;
    const humanApproved = Boolean(params.humanApproved);
    const requiresHumanApproval = isBigJob && !humanApproved;

    const isExpired = new Date(expiresAtIso).getTime() <= Date.now();
    const isProfitable = !isExpired && forecast.expectedProfit >= minProfitUsd && forecast.expectedMargin >= minMarginPct;

    const discoveryStatus: DiscoveredMarketOpportunity['discoveryStatus'] = isExpired
      ? 'EXPIRED'
      : isProfitable
      ? 'PROFITABLE'
      : 'REJECTED';

    // Determine explicit block reasons independently of discovery
    const blockReasons: string[] = [];
    if (isExpired) {
      blockReasons.push('OPPORTUNITY_EXPIRED');
    }
    if (!isProfitable && !isExpired) {
      blockReasons.push(
        forecast.expectedProfit <= 0
          ? 'NEGATIVE_EXPECTED_NET_PROFIT'
          : `BELOW_MINIMUM_MARGIN_THRESHOLD_${minMarginPct}PCT`
      );
    }
    const hasOperatingOrProviderCapital = (verifiedAvailableCapitalUsd >= requiredCapitalUsd) || Boolean(params.providerAccountFunded);
    if (!hasOperatingOrProviderCapital) {
      blockReasons.push('INSUFFICIENT_OPERATING_CAPITAL');
    }
    if (!params.providerAccountFunded) {
      blockReasons.push('PROVIDER_ACCOUNT_UNFUNDED');
    }
    if (!params.providerCapacityAvailable) {
      blockReasons.push('PROVIDER_CAPACITY_UNAVAILABLE');
    }
    if (!params.customerVerified) {
      blockReasons.push('CUSTOMER_CONTRACT_REQUIRED');
    }
    if (!params.paymentVerified) {
      blockReasons.push('CUSTOMER_ESCROW_PAYMENT_REQUIRED');
    }
    if (requiresHumanApproval) {
      blockReasons.push('HUMAN_APPROVAL_REQUIRED_BIG_JOB');
    }

    const isCapitalBlocked = isProfitable && !hasOperatingOrProviderCapital;
    const isProviderBlocked = isProfitable && (!params.providerAccountFunded || !params.providerCapacityAvailable);
    const isCustomerRequired = isProfitable && (!params.customerVerified || !params.paymentVerified);
    const executionEligible = isProfitable && blockReasons.filter(r => r !== 'HUMAN_APPROVAL_REQUIRED_BIG_JOB').length === 0 && !requiresHumanApproval;

    let status: AuthoritativeOpportunityState = 'DISCOVERED';
    if (isExpired) {
      status = 'EXPIRED';
    } else if (!isProfitable) {
      status = 'REJECTED';
    } else if (executionEligible) {
      status = 'EXECUTABLE';
    } else if (isCapitalBlocked) {
      // Requirement 3, 4, 6: Profitable opportunity with insufficient capital MUST have status CAPITAL_BLOCKED and discoveryStatus PROFITABLE
      status = 'CAPITAL_BLOCKED';
    } else if (isProviderBlocked) {
      status = 'PROVIDER_BLOCKED';
    } else if (isCustomerRequired) {
      status = 'CUSTOMER_REQUIRED';
    } else {
      status = 'PROFITABLE';
    }

    const workloadSpec = resolveServerWorkloadSpec(params.workloadType, params.gpuType);

    return {
      opportunityId: params.opportunityId,
      source: params.source,
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt: expiresAtIso,
      sourceTimestamp: params.sourceTimestamp || nowIso,
      priceTimestamp: params.priceTimestamp || nowIso,
      providerTimestamp: params.providerTimestamp || nowIso,
      customerPriceTimestamp: params.customerPriceTimestamp || nowIso,
      confidence: params.confidence ?? 92,

      customerDemandSource: params.customerDemandSource,
      customerId: params.customerId || null,
      customerName: params.customerName || `${workloadSpec.name} (${workloadSpec.customerPaysFor})`,
      demandOrderId: params.demandOrderId || null,
      customerPrice: forecast.expectedRevenue,
      customerPriceHourly: params.customerPriceHourly,
      customerPriceCurrency: params.customerPriceCurrency || 'USD',

      gpuType: params.gpuType,
      gpuQuantity: params.gpuQuantity,
      runtimeHours: params.runtimeHours,
      workloadType: params.workloadType || workloadSpec.id,
      workloadName: params.workloadName || workloadSpec.name,
      customerPaysFor: params.customerPaysFor || workloadSpec.customerPaysFor,
      workloadExample: params.workloadExample || workloadSpec.example,
      unitBillingMetric: params.unitBillingMetric || workloadSpec.unitPricingBenchmark,
      vramGb: params.vramGb,
      region: params.region,
      location: params.location,

      provider: params.provider,
      providerOfferId: String(params.providerOfferId),
      providerPriceHourly: params.providerPriceHourly,
      providerCost: forecast.expectedProviderCost,

      expectedRevenueUsd: forecast.expectedRevenue,
      expectedProviderCostUsd: forecast.expectedProviderCost,
      expectedPaymentFeesUsd: forecast.expectedPaymentFees,
      expectedNetworkFeesUsd: forecast.expectedNetworkFees,
      expectedPlatformCostsUsd: forecast.expectedPlatformCosts,
      estimatedFeesUsd: forecast.expectedFees,
      estimatedGrossProfitUsd: forecast.expectedProfit,
      expectedMarginPct: forecast.expectedMargin,
      expectedRoiPct: forecast.expectedRoiPct,
      roiPct: forecast.expectedRoiPct,

      expectedRevenue: forecast.expectedRevenue,
      expectedProviderCost: forecast.expectedProviderCost,
      expectedPaymentFees: forecast.expectedPaymentFees,
      expectedNetworkFees: forecast.expectedNetworkFees,
      expectedPlatformCosts: forecast.expectedPlatformCosts,
      expectedFees: forecast.expectedFees,
      expectedProfit: forecast.expectedProfit,
      expectedMargin: forecast.expectedMargin,

      requiredCapitalUsd,
      verifiedAvailableCapitalUsd,
      capitalShortfallUsd,

      isBigJob,
      requiresHumanApproval,
      humanApproved,
      humanApprovalThresholdUsd,

      discoveryStatus,
      status,
      executionEligible,
      blockReasons,

      isProfitable,
      isCapitalBlocked,
      isProviderBlocked,
      isCustomerRequired,
      isExecutable: executionEligible
    };
  }

  /**
   * Persists discovered opportunities to PostgreSQL market_opportunities table
   * and expires any stale records past their expires_at timestamp.
   */
  public async persistOpportunitiesToQueue(opportunities: DiscoveredMarketOpportunity[]): Promise<void> {
    if (!pgDbService.isLiveDatabaseConnected()) return;

    try {
      // Automatically mark expired opportunities in PostgreSQL as EXPIRED (Requirement 10)
      await pgDbService.query(
        `UPDATE market_opportunities
         SET status = 'EXPIRED',
             discovery_status = 'EXPIRED',
             execution_eligible = FALSE,
             updated_at = NOW()
         WHERE expires_at <= NOW() AND status NOT IN ('EXPIRED', 'COMPLETED', 'EXECUTING')`
      );

      for (const opp of opportunities) {
        await pgDbService.query(
          `INSERT INTO market_opportunities (
            opportunity_id, source, created_at, updated_at, expires_at,
            customer_demand_source, customer_id, demand_order_id, customer_price, customer_price_currency,
            gpu_type, gpu_quantity, runtime_hours, provider, provider_offer_id,
            provider_price_hourly, provider_cost, expected_revenue, expected_provider_cost,
            expected_payment_fees, expected_network_fees, expected_platform_costs, expected_fees,
            expected_profit, expected_margin, required_capital, verified_available_capital,
            capital_shortfall, discovery_status, status, execution_eligible, block_reasons,
            source_timestamp, price_timestamp, provider_timestamp, customer_price_timestamp,
            confidence, metadata
          ) VALUES (
            $1, $2, NOW(), NOW(), $3,
            $4, $5, $6, $7, $8,
            $9, $10, $11, $12, $13,
            $14, $15, $16, $17,
            $18, $19, $20, $21,
            $22, $23, $24, $25,
            $26, $27, $28, $29, $30::jsonb,
            $31, $32, $33, $34,
            $35, $36::jsonb
          )
          ON CONFLICT (opportunity_id) DO UPDATE SET
            updated_at = NOW(),
            expires_at = EXCLUDED.expires_at,
            customer_price = EXCLUDED.customer_price,
            provider_price_hourly = EXCLUDED.provider_price_hourly,
            provider_cost = EXCLUDED.provider_cost,
            expected_revenue = EXCLUDED.expected_revenue,
            expected_provider_cost = EXCLUDED.expected_provider_cost,
            expected_payment_fees = EXCLUDED.expected_payment_fees,
            expected_network_fees = EXCLUDED.expected_network_fees,
            expected_platform_costs = EXCLUDED.expected_platform_costs,
            expected_fees = EXCLUDED.expected_fees,
            expected_profit = EXCLUDED.expected_profit,
            expected_margin = EXCLUDED.expected_margin,
            required_capital = EXCLUDED.required_capital,
            verified_available_capital = EXCLUDED.verified_available_capital,
            capital_shortfall = EXCLUDED.capital_shortfall,
            discovery_status = EXCLUDED.discovery_status,
            status = EXCLUDED.status,
            execution_eligible = EXCLUDED.execution_eligible,
            block_reasons = EXCLUDED.block_reasons,
            price_timestamp = EXCLUDED.price_timestamp,
            provider_timestamp = EXCLUDED.provider_timestamp,
            customer_price_timestamp = EXCLUDED.customer_price_timestamp,
            confidence = EXCLUDED.confidence,
            metadata = EXCLUDED.metadata`,
          [
            opp.opportunityId,
            opp.source,
            opp.expiresAt,
            opp.customerDemandSource,
            opp.customerId || null,
            opp.demandOrderId || null,
            opp.customerPrice,
            opp.customerPriceCurrency,
            opp.gpuType,
            opp.gpuQuantity,
            opp.runtimeHours,
            opp.provider,
            opp.providerOfferId,
            opp.providerPriceHourly,
            opp.providerCost,
            opp.expectedRevenue,
            opp.expectedProviderCost,
            opp.expectedPaymentFees,
            opp.expectedNetworkFees,
            opp.expectedPlatformCosts,
            opp.expectedFees,
            opp.expectedProfit,
            opp.expectedMargin,
            opp.requiredCapitalUsd,
            opp.verifiedAvailableCapitalUsd,
            opp.capitalShortfallUsd,
            opp.discoveryStatus,
            opp.status,
            opp.executionEligible,
            JSON.stringify(opp.blockReasons),
            opp.sourceTimestamp,
            opp.priceTimestamp,
            opp.providerTimestamp,
            opp.customerPriceTimestamp,
            opp.confidence,
            JSON.stringify({
              customerName: opp.customerName,
              region: opp.region,
              location: opp.location,
              vramGb: opp.vramGb,
              isProfitable: opp.isProfitable,
              isCapitalBlocked: opp.isCapitalBlocked,
              isProviderBlocked: opp.isProviderBlocked,
              isCustomerRequired: opp.isCustomerRequired,
              isExecutable: opp.isExecutable
            })
          ]
        );
      }
    } catch (err: any) {
      console.warn('[OPPORTUNITY QUEUE PERSIST WARNING]', err.message);
    }
  }

  public getLastSummary(): OpportunityDashboardSummary | null {
    return this.lastDiscoverySummary;
  }

  public setLastSummary(summary: OpportunityDashboardSummary): void {
    this.lastDiscoverySummary = summary;
  }
}

export const opportunityDiscoveryPipeline = new OpportunityDiscoveryPipeline();

