/**
 * TRUE COST & MAXIMUM EXPECTED PROFIT ARBITRAGE CALCULATOR
 * 
 * Strict Reality Formula:
 * True Compute Cost =
 *   GPU
 *   + CPU
 *   + RAM
 *   + Storage
 *   + Network/Egress
 *   + Startup Overhead
 *   + Expected Interruption Cost
 *   + Provider Platform Fees
 *   + Payment Processing Fees
 *   + Currency Conversion
 * 
 * Net Profit Formula:
 *   Customer Revenue
 *   - True Compute Cost
 *   - Payment Fees
 *   - Platform Operational Overhead
 *   - Expected Failure Buffer
 *   = Realized Net Profit
 * 
 * Score Calculator:
 *   Provider Score =
 *     Expected Profit (Weight 0.35)
 *     + Benchmark Performance (Weight 0.20)
 *     + Reliability / SLA (Weight 0.20)
 *     + Availability (Weight 0.15)
 *     - Interruption Risk Penalty (Weight 0.10)
 */

export interface TrueCostParameters {
  gpuHourlyPrice: number;
  gpuCount: number;
  durationHours: number;
  cpuPriceHourly?: number;
  ramGb?: number;
  ramPricePerGbHourly?: number;
  storageGb: number;
  storagePricePerGbHourly?: number;
  networkEgressGb: number;
  networkEgressPricePerGb?: number;
  startupCost?: number;
  isInterruptible: boolean;
  spotEvictionRiskPct?: number;
  providerFeePct?: number; // e.g. 0.02 for Vast.ai
  paymentFeePct?: number; // 0.029 + 0.30
  currencyConversionPct?: number; // e.g. 0.015
  customerGrossRevenue: number;
  benchmarkScore?: number;
  uptimeGuaranteePct?: number;
}

export interface DetailedArbitrageEconomics {
  // Compute breakdowns
  baseGpuCostUsd: number;
  cpuCostUsd: number;
  ramCostUsd: number;
  storageCostUsd: number;
  networkEgressCostUsd: number;
  startupCostUsd: number;
  expectedInterruptionCostUsd: number;
  providerFeesUsd: number;
  paymentFeesUsd: number;
  currencyConversionCostUsd: number;
  totalTrueComputeCostUsd: number;

  // Revenue & Profit metrics
  customerGrossRevenueUsd: number;
  netProfitUsd: number;
  grossMarginPct: number;
  roiPct: number;
  profitPerGpuHourUsd: number;
  profitPerJobUsd: number;
  projectedProfitPerDayUsd: number;
  projectedProfitPerMonthUsd: number;

  // Composite Decision Score
  providerScore: number;
  isProfitable: boolean;
  meetsMinimumMargin: boolean;
}

export const MINIMUM_PROFIT_THRESHOLD_USD = 0.50; // Minimum $0.50 net profit per job
export const MINIMUM_GROSS_MARGIN_PCT = 15.0; // Minimum 15% margin to prevent negative skew

export function calculateTrueCostAndMargin(params: TrueCostParameters): DetailedArbitrageEconomics {
  const gpuCount = Math.max(1, params.gpuCount || 1);
  const duration = Math.max(0.1, params.durationHours || 1);

  // 1. Base compute
  const baseGpuCost = params.gpuHourlyPrice * gpuCount * duration;
  const cpuCost = (params.cpuPriceHourly || 0.04) * duration;
  const ramCost = (params.ramGb || 32) * (params.ramPricePerGbHourly || 0.002) * duration;

  // 2. Storage & Network
  const storageCost = (params.storageGb || 50) * (params.storagePricePerGbHourly || 0.0001) * duration;
  const networkEgressCost = (params.networkEgressGb || 10) * (params.networkEgressPricePerGb || 0.005);

  // 3. Startup & Interruption Risk
  const startupCost = params.startupCost !== undefined ? params.startupCost : 0.02;
  const evictionRisk = (params.spotEvictionRiskPct || 5.0) / 100;
  const expectedInterruptionCost = params.isInterruptible ? (baseGpuCost * evictionRisk * 0.5) : 0;

  // 4. Provider & Financial Rail Fees
  const providerFeePct = params.providerFeePct || 0.0;
  const providerFees = baseGpuCost * providerFeePct;

  const paymentFeePct = params.paymentFeePct || 0.029;
  const paymentFees = params.customerGrossRevenue * paymentFeePct + 0.30;

  const currencyConversionCost = (baseGpuCost + storageCost) * (params.currencyConversionPct || 0.0);

  // 5. Total True Cost
  const totalTrueComputeCost =
    baseGpuCost +
    cpuCost +
    ramCost +
    storageCost +
    networkEgressCost +
    startupCost +
    expectedInterruptionCost +
    providerFees +
    paymentFees +
    currencyConversionCost;

  // 6. Net Profit
  const netProfit = params.customerGrossRevenue - totalTrueComputeCost;
  const grossMarginPct = params.customerGrossRevenue > 0
    ? (netProfit / params.customerGrossRevenue) * 100
    : 0;

  const roiPct = totalTrueComputeCost > 0
    ? (netProfit / totalTrueComputeCost) * 100
    : 0;

  const profitPerGpuHour = duration * gpuCount > 0
    ? netProfit / (duration * gpuCount)
    : 0;

  const profitPerJob = netProfit;
  const jobsPerDay = Math.max(1, 24 / duration);
  const projectedProfitPerDay = profitPerJob * jobsPerDay;
  const projectedProfitPerMonth = projectedProfitPerDay * 30;

  // 7. Composite Provider Score (0.0 to 100.0)
  // Higher score = better overall workload execution choice
  const benchmarkNormalized = Math.min(100, Math.max(10, params.benchmarkScore || 50));
  const uptimeNormalized = Math.min(100, Math.max(80, params.uptimeGuaranteePct || 99.0));
  const profitNormalized = Math.min(100, Math.max(0, grossMarginPct * 1.5));
  const riskPenalty = params.isInterruptible ? (params.spotEvictionRiskPct || 10) * 1.5 : 0;

  const providerScore = Math.max(
    0,
    Number(
      (
        profitNormalized * 0.35 +
        benchmarkNormalized * 0.25 +
        uptimeNormalized * 0.25 -
        riskPenalty * 0.15
      ).toFixed(2)
    )
  );

  return {
    baseGpuCostUsd: Number(baseGpuCost.toFixed(4)),
    cpuCostUsd: Number(cpuCost.toFixed(4)),
    ramCostUsd: Number(ramCost.toFixed(4)),
    storageCostUsd: Number(storageCost.toFixed(4)),
    networkEgressCostUsd: Number(networkEgressCost.toFixed(4)),
    startupCostUsd: Number(startupCost.toFixed(4)),
    expectedInterruptionCostUsd: Number(expectedInterruptionCost.toFixed(4)),
    providerFeesUsd: Number(providerFees.toFixed(4)),
    paymentFeesUsd: Number(paymentFees.toFixed(4)),
    currencyConversionCostUsd: Number(currencyConversionCost.toFixed(4)),
    totalTrueComputeCostUsd: Number(totalTrueComputeCost.toFixed(4)),

    customerGrossRevenueUsd: Number(params.customerGrossRevenue.toFixed(4)),
    netProfitUsd: Number(netProfit.toFixed(4)),
    grossMarginPct: Number(grossMarginPct.toFixed(2)),
    roiPct: Number(roiPct.toFixed(2)),
    profitPerGpuHourUsd: Number(profitPerGpuHour.toFixed(4)),
    profitPerJobUsd: Number(profitPerJob.toFixed(4)),
    projectedProfitPerDayUsd: Number(projectedProfitPerDay.toFixed(4)),
    projectedProfitPerMonthUsd: Number(projectedProfitPerMonth.toFixed(4)),

    providerScore,
    isProfitable: netProfit > 0,
    meetsMinimumMargin: netProfit >= MINIMUM_PROFIT_THRESHOLD_USD && grossMarginPct >= MINIMUM_GROSS_MARGIN_PCT
  };
}
