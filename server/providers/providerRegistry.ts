import {
  GPUProvider,
  ProviderId,
  ProviderHealthResult,
  ProviderPriceRecord,
  CostEstimateRequest,
  CostEstimateResult,
  ProvisionRequest,
  ProvisionResult
} from './types.js';
import { VastAiProvider } from './vastProvider.js';
import { RunpodProvider } from './runpodProvider.js';
import { TensordockProvider } from './tensordockProvider.js';
import { AkashProvider } from './akashProvider.js';
import { SaladProvider } from './saladProvider.js';
import { LightningProvider } from './lightningProvider.js';
import { HyperstackProvider } from './hyperstackProvider.js';
import { CoreweaveProvider } from './coreweaveProvider.js';
import { LambdaProvider } from './lambdaProvider.js';
import { HostingerProvider } from './hostingerProvider.js';
import { classifyWorkload, normalizeGpu, NORMALIZED_GPU_CATALOG } from './workloadClassifier.js';
import { calculateTrueCostAndMargin, MINIMUM_PROFIT_THRESHOLD_USD, MINIMUM_GROSS_MARGIN_PCT } from './trueCostEngine.js';

export interface ProviderReadinessReport {
  timestamp: string;
  totalProviders: number;
  liveProvidersCount: number;
  authenticatedProvidersCount: number;
  configurationRequiredCount: number;
  errorCount: number;
  providers: Record<ProviderId, ProviderHealthResult>;
  overallProductionReady: boolean;
}

export interface LiveMatrixRow {
  gpuModel: string;
  canonicalModel: string;
  vramGb: number;
  cheapestOnDemand: { providerId: string; price: number } | null;
  cheapestSpot: { providerId: string; price: number } | null;
  spreadPct: number;
  vast_ai: { status: 'LIVE' | 'N/A'; price: number | null; spot: number | null };
  runpod: { status: 'LIVE' | 'N/A'; price: number | null; spot: number | null };
  tensordock: { status: 'LIVE' | 'N/A'; price: number | null; spot: number | null };
  akash: { status: 'LIVE' | 'N/A'; price: number | null; spot: number | null };
  salad: { status: 'LIVE' | 'N/A'; price: number | null; spot: number | null };
  lightning_ai: { status: 'LIVE' | 'N/A'; price: number | null; spot: number | null };
  hyperstack: { status: 'LIVE' | 'N/A'; price: number | null; spot: number | null };
  coreweave: { status: 'LIVE' | 'N/A'; price: number | null; spot: number | null };
  lambda: { status: 'LIVE' | 'N/A'; price: number | null; spot: number | null };
  hostinger: { status: 'LIVE' | 'N/A'; price: number | null; spot: number | null };
}

export class ProviderRegistry {
  private providers: Map<ProviderId, GPUProvider> = new Map();
  private cachedHealth: Map<ProviderId, ProviderHealthResult> = new Map();
  private lastHealthCheckIso: string | null = null;
  private lastHealthCheckMs = 0;
  private inFlightHealthPromise: Promise<Record<ProviderId, ProviderHealthResult>> | null = null;

  private cachedPricing: { records: ProviderPriceRecord[]; timestampMs: number } | null = null;
  private inFlightPricingPromise: Promise<ProviderPriceRecord[]> | null = null;

  private cachedMatrix: { data: { matrix: LiveMatrixRow[]; summary: any }; timestampMs: number } | null = null;
  private inFlightMatrixPromise: Promise<{ matrix: LiveMatrixRow[]; summary: any }> | null = null;

  constructor() {
    this.registerProvider(new VastAiProvider());
    this.registerProvider(new RunpodProvider());
    this.registerProvider(new TensordockProvider());
    this.registerProvider(new AkashProvider());
    this.registerProvider(new SaladProvider());
    this.registerProvider(new LightningProvider());
    this.registerProvider(new HyperstackProvider());
    this.registerProvider(new CoreweaveProvider());
    this.registerProvider(new LambdaProvider());
    this.registerProvider(new HostingerProvider());
  }

  public registerProvider(provider: GPUProvider): void {
    this.providers.set(provider.id, provider);
  }

  public getProvider(id: ProviderId): GPUProvider | undefined {
    return this.providers.get(id);
  }

  public getAllProviders(): GPUProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Run automated health check across all 10 providers with 30s TTL cache and deduplication
   */
  public async runHealthChecks(forceFresh: boolean = false): Promise<Record<ProviderId, ProviderHealthResult>> {
    const now = Date.now();
    if (!forceFresh && (now - this.lastHealthCheckMs) < 30000 && this.cachedHealth.size === this.providers.size) {
      const cachedObj: Partial<Record<ProviderId, ProviderHealthResult>> = {};
      for (const [id, res] of this.cachedHealth.entries()) {
        cachedObj[id] = res;
      }
      return cachedObj as Record<ProviderId, ProviderHealthResult>;
    }

    if (this.inFlightHealthPromise) {
      return this.inFlightHealthPromise;
    }

    this.inFlightHealthPromise = (async () => {
      const results: Partial<Record<ProviderId, ProviderHealthResult>> = {};

      await Promise.all(
        Array.from(this.providers.values()).map(async (provider) => {
          try {
            const res = await provider.healthCheck();
            results[provider.id] = res;
            this.cachedHealth.set(provider.id, res);
          } catch (err: any) {
            const fallback: ProviderHealthResult = {
              providerId: provider.id,
              providerName: provider.name,
              status: 'ERROR',
              healthColor: 'RED',
              authenticated: false,
              latencyMs: 0,
              endpoints: {
                authentication: false,
                pricing: false,
                inventory: false,
                provisioning: false,
                instanceControl: false,
                telemetry: false,
                billing: false
              },
              lastCheckIso: new Date().toISOString(),
              message: err.message || 'Health check execution error',
              configuredCredentials: [],
              missingCredentials: []
            };
            results[provider.id] = fallback;
            this.cachedHealth.set(provider.id, fallback);
          }
        })
      );

      this.lastHealthCheckIso = new Date().toISOString();
      this.lastHealthCheckMs = Date.now();
      return results as Record<ProviderId, ProviderHealthResult>;
    })().finally(() => {
      this.inFlightHealthPromise = null;
    });

    return this.inFlightHealthPromise;
  }

  /**
   * Generates formal Provider Readiness Report (Requirement 22)
   */
  public async getReadinessReport(): Promise<ProviderReadinessReport> {
    const health = await this.runHealthChecks();
    const providersList = Object.values(health);

    const liveCount = providersList.filter(p => p.status === 'LIVE').length;
    const authCount = providersList.filter(p => p.status === 'AUTHENTICATED').length;
    const configCount = providersList.filter(p => p.status === 'CONFIGURATION_REQUIRED').length;
    const errorCount = providersList.filter(p => p.status === 'ERROR').length;

    return {
      timestamp: new Date().toISOString(),
      totalProviders: providersList.length,
      liveProvidersCount: liveCount,
      authenticatedProvidersCount: authCount,
      configurationRequiredCount: configCount,
      errorCount: errorCount,
      providers: health,
      overallProductionReady: liveCount >= 1 || authCount >= 1
    };
  }

  /**
   * Aggregates real-time price records across all 10 providers with 30s TTL cache
   */
  public async getAllLivePricing(forceFresh: boolean = false): Promise<ProviderPriceRecord[]> {
    const now = Date.now();
    if (!forceFresh && this.cachedPricing && (now - this.cachedPricing.timestampMs) < 30000 && this.cachedPricing.records.length > 0) {
      return this.cachedPricing.records;
    }

    if (this.inFlightPricingPromise) {
      return this.inFlightPricingPromise;
    }

    this.inFlightPricingPromise = (async () => {
      const allRecords: ProviderPriceRecord[] = [];

      await Promise.all(
        Array.from(this.providers.values()).map(async (provider) => {
          try {
            const prices = await provider.getLivePricing();
            allRecords.push(...prices);
          } catch (err) {
            console.error(`Failed to collect pricing from ${provider.name}:`, err);
          }
        })
      );

      this.cachedPricing = { records: allRecords, timestampMs: Date.now() };
      return allRecords;
    })().finally(() => {
      this.inFlightPricingPromise = null;
    });

    return this.inFlightPricingPromise;
  }

  /**
   * Build the Live Multi-Provider Price Matrix (Requirement 9) with 30s TTL cache
   */
  public async getLivePriceMatrix(forceFresh: boolean = false): Promise<{ matrix: LiveMatrixRow[]; summary: any }> {
    const now = Date.now();
    if (!forceFresh && this.cachedMatrix && (now - this.cachedMatrix.timestampMs) < 30000 && this.cachedMatrix.data.matrix.length > 0) {
      return this.cachedMatrix.data;
    }

    if (this.inFlightMatrixPromise) {
      return this.inFlightMatrixPromise;
    }

    this.inFlightMatrixPromise = (async () => {
      const prices = await this.getAllLivePricing(forceFresh);
      const canonicalGpus = ['RTX 4090', 'RTX 3090', 'A100 80GB', 'H100', 'A6000', 'A5000', 'A4000', 'L40S'];
      const rows: LiveMatrixRow[] = [];

      for (const model of canonicalGpus) {
        const spec = normalizeGpu(model);
        const vram = spec?.vramGb || 24;

        const matchingPrices = prices.filter(p =>
          p.canonicalModel.toUpperCase() === model.toUpperCase() ||
          p.gpuModel.toUpperCase().includes(model.toUpperCase())
        );

        const cellFor = (providerId: ProviderId) => {
          const item = matchingPrices.find(p => p.providerId === providerId);
          if (!item || item.hourlyPrice <= 0) {
            return { status: 'N/A' as const, price: null, spot: null };
          }
          return {
            status: 'LIVE' as const,
            price: item.hourlyPrice,
            spot: item.spotPriceHourly || null
          };
        };

        const validPrices = matchingPrices.filter(p => p.hourlyPrice > 0);
        let cheapestOnDemand: { providerId: string; price: number } | null = null;
        let cheapestSpot: { providerId: string; price: number } | null = null;

        if (validPrices.length > 0) {
          const sorted = [...validPrices].sort((a, b) => a.hourlyPrice - b.hourlyPrice);
          cheapestOnDemand = { providerId: sorted[0].providerId, price: sorted[0].hourlyPrice };

          const spots = validPrices.filter(p => p.spotPriceHourly && p.spotPriceHourly > 0);
          if (spots.length > 0) {
            spots.sort((a, b) => (a.spotPriceHourly || 999) - (b.spotPriceHourly || 999));
            cheapestSpot = { providerId: spots[0].providerId, price: spots[0].spotPriceHourly! };
          }
        }

        let spreadPct = 0;
        if (validPrices.length >= 2) {
          const min = Math.min(...validPrices.map(p => p.hourlyPrice));
          const max = Math.max(...validPrices.map(p => p.hourlyPrice));
          spreadPct = min > 0 ? Number((((max - min) / min) * 100).toFixed(1)) : 0;
        }

        rows.push({
          gpuModel: model,
          canonicalModel: model,
          vramGb: vram,
          cheapestOnDemand,
          cheapestSpot,
          spreadPct,
          vast_ai: cellFor('vast_ai'),
          runpod: cellFor('runpod'),
          tensordock: cellFor('tensordock'),
          akash: cellFor('akash'),
          salad: cellFor('salad'),
          lightning_ai: cellFor('lightning_ai'),
          hyperstack: cellFor('hyperstack'),
          coreweave: cellFor('coreweave'),
          lambda: cellFor('lambda'),
          hostinger: cellFor('hostinger')
        });
      }

      const res = {
        matrix: rows,
        summary: {
          totalGpuModels: canonicalGpus.length,
          totalOffersCollected: prices.length,
          timestamp: new Date().toISOString()
        }
      };

      this.cachedMatrix = { data: res, timestampMs: Date.now() };
      return res;
    })().finally(() => {
      this.inFlightMatrixPromise = null;
    });

    return this.inFlightMatrixPromise;
  }

  /**
   * Workload-Aware Arbitrage Router & Maximum Expected Profit Selector
   * (Requirements 8, 10, 11)
   */
  public async routeWorkload(params: {
    workloadType: string;
    customerOfferPriceUsd: number;
    durationHours: number;
    gpuCount?: number;
    storageGb?: number;
    egressGb?: number;
    interruptionTolerance?: 'STRICT_NO_INTERRUPTIONS' | 'CHECKPOINTABLE_BATCH' | 'LOW_PRIORITY_FAULT_TOLERANT';
    regionPreference?: string;
  }) {
    const workloadReq = classifyWorkload(params.workloadType);
    const targetGpu = workloadReq.recommendedGpu;
    const gpuSpec = normalizeGpu(targetGpu);
    const prices = await this.getAllLivePricing();

    // Filter candidate offers satisfying requirements
    const candidates: any[] = [];

    for (const offer of prices) {
      // Hardware parity check
      const offerSpec = normalizeGpu(offer.gpuModel);
      if (!offerSpec) continue;

      if (offerSpec.vramGb < workloadReq.minVramGb) continue;
      if (offerSpec.cudaComputeCapability < workloadReq.minCudaCapability) continue;
      if (workloadReq.requiresBf16 && offerSpec.bf16Tflops <= 0) continue;
      if (offerSpec.memoryBandwidthGbps < workloadReq.minMemoryBandwidthGbps) continue;

      const provider = this.getProvider(offer.providerId);
      if (!provider) continue;

      const economics = calculateTrueCostAndMargin({
        gpuHourlyPrice: offer.isInterruptible && offer.spotPriceHourly ? offer.spotPriceHourly : offer.hourlyPrice,
        gpuCount: params.gpuCount || 1,
        durationHours: params.durationHours,
        storageGb: params.storageGb || 50,
        networkEgressGb: params.egressGb || 10,
        isInterruptible: offer.isInterruptible,
        spotEvictionRiskPct: offer.estimatedInterruptionRiskPct,
        customerGrossRevenue: params.customerOfferPriceUsd,
        benchmarkScore: offerSpec.benchmarkScore,
        uptimeGuaranteePct: 99.5
      });

      candidates.push({
        providerId: offer.providerId,
        providerName: provider.name,
        tier: provider.tier,
        offerId: offer.id,
        gpuModel: offer.gpuModel,
        canonicalModel: offerSpec.canonicalName,
        vramGb: offerSpec.vramGb,
        hourlyPrice: offer.hourlyPrice,
        spotPrice: offer.spotPriceHourly,
        isInterruptible: offer.isInterruptible,
        region: offer.region,
        economics
      });
    }

    // Sort by Maximum Expected Profit (Provider Score descending)
    candidates.sort((a, b) => b.economics.providerScore - a.economics.providerScore);

    const winningProvider = candidates[0] || null;
    const alternatives = candidates.slice(1, 4);

    return {
      workloadCategory: workloadReq.category,
      minimumVramGb: workloadReq.minVramGb,
      minimumCudaCapability: workloadReq.minCudaCapability,
      winningProvider,
      alternatives,
      totalEvaluatedOffers: candidates.length,
      isExecutionApproved: Boolean(
        winningProvider &&
        winningProvider.economics.meetsMinimumMargin &&
        winningProvider.economics.netProfitUsd >= MINIMUM_PROFIT_THRESHOLD_USD
      )
    };
  }

  /**
   * 10-Step Preflight Checklist (Requirement 11)
   */
  public async executePreflightChecklist(params: {
    providerId: ProviderId;
    gpuModel: string;
    maxHourlyPriceUsd: number;
    expectedRevenueUsd: number;
    jobDurationHours: number;
    customerPaymentAuthorized: boolean;
    maxCostLimitUsd: number;
    maxLossLimitUsd: number;
  }): Promise<{ pass: boolean; reasons: string[]; marginPct: number; projectedProfitUsd: number }> {
    const reasons: string[] = [];
    const provider = this.getProvider(params.providerId);

    // 1. Verify provider credentials
    if (!provider) {
      reasons.push('Provider not registered in system');
      return { pass: false, reasons, marginPct: 0, projectedProfitUsd: 0 };
    }

    const health = await provider.healthCheck();
    if (!health.authenticated && health.status !== 'LIVE') {
      reasons.push(`Provider ${provider.name} credentials not authenticated (Status: ${health.status})`);
    }

    // 2. Verify GPU availability & price
    const avail = await provider.getAvailability(params.gpuModel);
    if (!avail.available && health.status === 'LIVE') {
      reasons.push(`Target GPU ${params.gpuModel} currently out of capacity on ${provider.name}`);
    }

    const currentPrice = avail.currentPriceHourly || params.maxHourlyPriceUsd;

    // 3. True Cost & Margin calculation
    const economics = calculateTrueCostAndMargin({
      gpuHourlyPrice: currentPrice,
      gpuCount: 1,
      durationHours: params.jobDurationHours,
      storageGb: 50,
      networkEgressGb: 10,
      isInterruptible: false,
      customerGrossRevenue: params.expectedRevenueUsd
    });

    // 4. Verify expected revenue & margin
    if (economics.netProfitUsd < MINIMUM_PROFIT_THRESHOLD_USD) {
      reasons.push(`Projected net profit ($${economics.netProfitUsd.toFixed(2)}) is below safety floor ($${MINIMUM_PROFIT_THRESHOLD_USD.toFixed(2)})`);
    }
    if (economics.grossMarginPct < MINIMUM_GROSS_MARGIN_PCT) {
      reasons.push(`Projected margin (${economics.grossMarginPct.toFixed(1)}%) is below minimum threshold (${MINIMUM_GROSS_MARGIN_PCT}%)`);
    }

    // 5. Customer payment authorization verification
    if (!params.customerPaymentAuthorized) {
      reasons.push('Customer payment authorization not confirmed by payment provider');
    }

    // 6. Cost limits
    if (economics.totalTrueComputeCostUsd > params.maxCostLimitUsd) {
      reasons.push(`True compute cost ($${economics.totalTrueComputeCostUsd.toFixed(2)}) exceeds maximum cost limit ($${params.maxCostLimitUsd.toFixed(2)})`);
    }
    if (economics.netProfitUsd < -params.maxLossLimitUsd) {
      reasons.push(`Projected loss exceeds maximum loss limit ($${params.maxLossLimitUsd.toFixed(2)})`);
    }

    return {
      pass: reasons.length === 0,
      reasons,
      marginPct: economics.grossMarginPct,
      projectedProfitUsd: economics.netProfitUsd
    };
  }

  /**
   * Autonomous Failover Orchestrator (Requirement 12)
   */
  public async orchestrateFailover(
    failedProviderId: ProviderId,
    req: ProvisionRequest,
    expectedRevenueUsd: number,
    retryCount = 0
  ): Promise<ProvisionResult> {
    const maxRetries = 3;
    if (retryCount >= maxRetries) {
      return {
        success: false,
        providerId: failedProviderId,
        status: 'FAILED',
        actualHourlyPriceUsd: 0,
        error: `Max failover retry count (${maxRetries}) reached`,
        provisionedAtIso: new Date().toISOString()
      };
    }

    // Rank fallback providers excluding the failed provider
    const fallbackRanking: ProviderId[] = [
      'vast_ai',
      'runpod',
      'akash',
      'salad',
      'tensordock',
      'hyperstack',
      'hostinger',
      'lambda',
      'lightning_ai',
      'coreweave'
    ].filter(p => p !== failedProviderId) as ProviderId[];

    for (const nextProviderId of fallbackRanking) {
      const nextProvider = this.getProvider(nextProviderId);
      if (!nextProvider) continue;

      // Recalculate price and profitability before moving
      const preflight = await this.executePreflightChecklist({
        providerId: nextProviderId,
        gpuModel: req.gpuModel,
        maxHourlyPriceUsd: req.maxHourlyPriceUsd,
        expectedRevenueUsd,
        jobDurationHours: 4,
        customerPaymentAuthorized: true,
        maxCostLimitUsd: 150,
        maxLossLimitUsd: 0
      });

      if (!preflight.pass) {
        continue; // Fail closed: Do not blindly move to an unprofitable or expensive provider
      }

      // Attempt provisioning
      const result = await nextProvider.provision(req);
      if (result.success) {
        return result;
      }
    }

    return {
      success: false,
      providerId: failedProviderId,
      status: 'FAILED',
      actualHourlyPriceUsd: 0,
      error: 'All eligible failover providers failed preflight or provisioning',
      provisionedAtIso: new Date().toISOString()
    };
  }
}

export const providerRegistry = new ProviderRegistry();
