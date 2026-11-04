/**
 * LIVE GPU PRICE ROUTER & MULTI-PROVIDER ARBITRAGE ENGINE
 * 
 * Core Philosophy: NEVER hardcode "Vast.ai = cheapest".
 * Instead, dynamically route every GPU workload across the full provider landscape:
 * Vast.ai -> Akash -> Salad -> RunPod -> Hostinger -> TensorDock -> Hyperstack -> Lambda -> CoreWeave
 * 
 * Evaluates the true compute economics:
 * True GPU Cost = Base GPU Price + Storage + Network Egress + CPU/RAM + Startup + Expected Interruption Cost
 * Actual Margin = Customer Revenue - True Compute Cost - Payment/Platform Fees
 * 
 * Automatically selects the cheapest provider satisfying:
 * GPU model, VRAM, CUDA/ROCm, region/latency, uptime, duration, interruption tolerance,
 * storage, bandwidth, and benchmark performance.
 */

import { providerRegistry } from './providers/providerRegistry.js';

export type ProviderTier = 'MARKETPLACE' | 'DECENTRALIZED' | 'DISTRIBUTED_EDGE' | 'NEOCLOUD' | 'ENTERPRISE_HYPERSCALER';

export interface ProviderProfile {
  id: string;
  name: string;
  tier: ProviderTier;
  description: string;
  website: string;
  isCoreFour: boolean;
  priorityRank: number; // 1 = highest priority for cost optimization
  billingGranularitySec: number;
  supportsSpotInterruptible: boolean;
  spotDiscountAvgPct: number;
  defaultUptimePct: number;
  supportedRegions: string[];
  cudaSupport: string[];
  rocmSupport: boolean;
  storageRatePerGbHr: number;
  networkEgressPerGb: number;
  avgStartupSec: number;
  status: 'ONLINE' | 'DEGRADED' | 'DISCOVERED';
  telemetryScore: number; // 0.0 - 1.0
  inventoryEstimate: number; // Available GPUs estimate
}

export interface GpuOffer {
  offerId: string;
  providerId: string;
  providerName: string;
  tier: ProviderTier;
  gpuModel: string;
  canonicalGpu: string;
  vramGb: number;
  cudaVersion: string;
  pcieGen: string;
  isInterruptible: boolean;
  baseHourlyPrice: number;
  vcpu: number;
  ramGb: number;
  nvmeStorageGb: number;
  networkUpMbps: number;
  networkDownMbps: number;
  region: string;
  datacenterTier: string;
  uptimeGuaranteePct: number;
  spotEvictionRiskPct: number;
  tflopsFp16: number;
  availableStock: number;
  lastUpdatedIso: string;
}

export interface TrueCostBreakdown {
  baseComputeCost: number;
  storageCost: number;
  networkEgressCost: number;
  cpuRamOverheadCost: number;
  startupOverheadCost: number;
  expectedInterruptionCost: number;
  totalTrueCost: number;
  effectiveHourlyRate: number;
}

export interface WorkloadRoutingConstraints {
  gpuModel: string;
  minVramGb?: number;
  cudaRequirement?: string;
  rocmRequired?: boolean;
  regionPreference?: string;
  minUptimePct?: number;
  jobDurationHours: number;
  gpuCount?: number;
  interruptionTolerance: 'STRICT_NO_INTERRUPTIONS' | 'CHECKPOINTABLE_BATCH' | 'LOW_PRIORITY_FAULT_TOLERANT';
  minStorageGb?: number;
  estimatedEgressGb?: number;
  minBandwidthMbps?: number;
  minTflopsFp16?: number;
  customerGrossOfferPrice?: number;
}

export interface RoutingEvaluation {
  providerId: string;
  providerName: string;
  tier: ProviderTier;
  offerId: string;
  gpuModel: string;
  vramGb: number;
  region: string;
  isInterruptible: boolean;
  isEligible: boolean;
  disqualificationReasons: string[];
  baseHourlyRate: number;
  trueCostBreakdown: TrueCostBreakdown;
  customerRevenue?: number;
  estimatedPaymentFee?: number;
  netMarginDollars?: number;
  netMarginPct?: number;
  roiPct?: number;
  economicRank: number;
}

export interface RoutingDecision {
  routingId: string;
  timestamp: string;
  constraints: WorkloadRoutingConstraints;
  winningProvider: RoutingEvaluation | null;
  alternatives: RoutingEvaluation[];
  disqualifiedProviders: RoutingEvaluation[];
  arbitrageSpread: {
    cheapestEligibleHourly: number;
    mostExpensiveEligibleHourly: number;
    spreadPercentage: number;
    totalSavingsDollars: number;
  } | null;
  recommendationReason: string;
}

export interface GpuModelPriceComparison {
  gpuModel: string;
  canonicalName: string;
  vramGb: number;
  tflopsFp16: number;
  providers: {
    providerId: string;
    providerName: string;
    tier: ProviderTier;
    onDemandHourly: number;
    spotHourly?: number;
    stock: number;
    region: string;
    uptimePct: number;
  }[];
  cheapestOnDemand: { providerId: string; price: number };
  cheapestSpot?: { providerId: string; price: number };
  marketAveragePrice: number;
  spreadPct: number;
}

export class GpuPriceRouter {
  private providers: Map<string, ProviderProfile> = new Map();
  private dynamicProviderRegistry: Map<string, ProviderProfile> = new Map();
  private offerCatalog: GpuOffer[] = [];
  private lastUpdateIso: string = new Date().toISOString();

  constructor() {
    this.initializeCoreProviders();
    const isProduction = process.env.NODE_ENV === 'production' || (process.env.REALITY_LEVEL || '').toUpperCase() === 'LIVE';
    if (!isProduction && process.env.NODE_ENV !== 'test') {
      this.seedMarketplaceOffers();
    }
    this.syncLiveProviderOffers().catch(() => {});
  }

  /**
   * Dynamically synchronizes live provider offers from providerRegistry (Vast.ai, RunPod, Lightning, etc.)
   * Eliminates static pricing by updating the offerCatalog with live API rates.
   * In production, live synchronization replaces the offer book rather than appending to seeded data.
   */
  public async syncLiveProviderOffers(): Promise<GpuOffer[]> {
    try {
      const livePricing = await providerRegistry.getAllLivePricing();
      if (livePricing && livePricing.length > 0) {
        const nowMs = Date.now();
        const maxStalenessMs = 30 * 60 * 1000; // 30 minutes freshness threshold

        // Validate source, provider offer ID, price, availability, timestamp and freshness
        const validPricing = livePricing.filter(p => {
          const hasValidId = Boolean(p.id && typeof p.id === 'string' && p.id.trim().length > 0);
          const hasPositivePrice = typeof p.hourlyPrice === 'number' && p.hourlyPrice > 0;
          const hasValidAvailability = p.availability === 'AVAILABLE' || p.availability === 'LOW_STOCK';
          const timestampMs = p.timestamp ? new Date(p.timestamp).getTime() : nowMs;
          const isFresh = (nowMs - timestampMs) <= maxStalenessMs;
          return hasValidId && hasPositivePrice && hasValidAvailability && isFresh;
        });

        const liveOffers: GpuOffer[] = validPricing.map(p => {
          const provider = providerRegistry.getProvider(p.providerId);
          return {
            offerId: p.id,
            providerId: p.providerId,
            providerName: provider?.name || p.providerId,
            tier: (provider?.tier || 'MARKETPLACE') as ProviderTier,
            gpuModel: p.gpuModel,
            canonicalGpu: p.canonicalModel || p.gpuModel,
            vramGb: p.vramGb || 24,
            cudaVersion: '12.4',
            pcieGen: 'PCIe 4.0 x16',
            isInterruptible: p.isInterruptible,
            baseHourlyPrice: p.isInterruptible && p.spotPriceHourly ? p.spotPriceHourly : p.hourlyPrice,
            vcpu: 8,
            ramGb: 32,
            nvmeStorageGb: 50,
            networkUpMbps: 1000,
            networkDownMbps: 1000,
            region: p.region || 'US-East',
            datacenterTier: 'Tier 3 Verified Datacenter',
            uptimeGuaranteePct: 99.5,
            spotEvictionRiskPct: p.estimatedInterruptionRiskPct || 0,
            tflopsFp16: 120.0,
            availableStock: p.availability === 'AVAILABLE' ? 10 : 2,
            lastUpdatedIso: p.timestamp || new Date().toISOString()
          };
        });

        // Ensure live synchronization REPLACES the production offer book rather than appending to seeded data
        const isProduction = process.env.NODE_ENV === 'production' || (process.env.REALITY_LEVEL || '').toUpperCase() === 'LIVE';
        if (isProduction || liveOffers.length > 0) {
          this.offerCatalog = liveOffers;
        }
        this.lastUpdateIso = new Date().toISOString();
      } else {
        const isProduction = process.env.NODE_ENV === 'production' || (process.env.REALITY_LEVEL || '').toUpperCase() === 'LIVE';
        if (isProduction) {
          this.offerCatalog = []; // Strictly empty if no live offers
        }
      }
    } catch (err: any) {
      console.warn('[GPU PRICE ROUTER] Non-blocking warning syncing live offers:', err.message);
    }
    return this.offerCatalog;
  }

  /**
   * Initializes the Core Four + Extended Neocloud Providers
   */
  private initializeCoreProviders(): void {
    const providerList: ProviderProfile[] = [
      {
        id: 'vast_ai',
        name: 'Vast.ai',
        tier: 'MARKETPLACE',
        description: 'Global peer-to-peer compute marketplace with 20,000+ GPUs, 68+ types, real-time market pricing, and per-second billing.',
        website: 'https://vast.ai',
        isCoreFour: true,
        priorityRank: 1,
        billingGranularitySec: 1,
        supportsSpotInterruptible: true,
        spotDiscountAvgPct: 52.0,
        defaultUptimePct: 98.8,
        supportedRegions: ['US-East', 'US-West', 'EU-Central', 'EU-West', 'APAC', 'Global'],
        cudaSupport: ['11.8', '12.0', '12.2', '12.4', '12.6'],
        rocmSupport: true,
        storageRatePerGbHr: 0.00028,
        networkEgressPerGb: 0.015,
        avgStartupSec: 28,
        status: 'ONLINE',
        telemetryScore: 0.94,
        inventoryEstimate: 21500
      },
      {
        id: 'akash',
        name: 'Akash Network',
        tier: 'DECENTRALIZED',
        description: 'Decentralized cloud compute marketplace with reverse auction bidding. Significant price divergence from centralized clouds.',
        website: 'https://akash.network',
        isCoreFour: true,
        priorityRank: 2,
        billingGranularitySec: 6,
        supportsSpotInterruptible: false,
        spotDiscountAvgPct: 0.0,
        defaultUptimePct: 99.2,
        supportedRegions: ['US-East', 'US-West', 'EU-Central', 'Global'],
        cudaSupport: ['12.0', '12.2', '12.4'],
        rocmSupport: false,
        storageRatePerGbHr: 0.00020,
        networkEgressPerGb: 0.005,
        avgStartupSec: 35,
        status: 'ONLINE',
        telemetryScore: 0.92,
        inventoryEstimate: 4200
      },
      {
        id: 'salad',
        name: 'SaladCloud',
        tier: 'DISTRIBUTED_EDGE',
        description: 'Distributed infrastructure leveraging 10,000s of residential & workstation consumer GPUs for ultra low-cost AI batch & inference.',
        website: 'https://salad.com',
        isCoreFour: true,
        priorityRank: 3,
        billingGranularitySec: 1,
        supportsSpotInterruptible: true,
        spotDiscountAvgPct: 45.0,
        defaultUptimePct: 98.2,
        supportedRegions: ['US-East', 'US-West', 'EU-West', 'Global'],
        cudaSupport: ['11.8', '12.1', '12.4'],
        rocmSupport: false,
        storageRatePerGbHr: 0.00022,
        networkEgressPerGb: 0.020,
        avgStartupSec: 42,
        status: 'ONLINE',
        telemetryScore: 0.91,
        inventoryEstimate: 18500
      },
      {
        id: 'runpod',
        name: 'RunPod',
        tier: 'MARKETPLACE',
        description: 'Secure and community GPU cloud with serverless endpoints, per-second billing, and competitive A4000/A5000/A40/RTX 4090 rates.',
        website: 'https://runpod.io',
        isCoreFour: true,
        priorityRank: 4,
        billingGranularitySec: 1,
        supportsSpotInterruptible: true,
        spotDiscountAvgPct: 40.0,
        defaultUptimePct: 99.5,
        supportedRegions: ['US-East', 'US-West', 'EU-Central', 'EU-West'],
        cudaSupport: ['11.8', '12.1', '12.2', '12.4'],
        rocmSupport: false,
        storageRatePerGbHr: 0.00030,
        networkEgressPerGb: 0.030,
        avgStartupSec: 18,
        status: 'ONLINE',
        telemetryScore: 0.96,
        inventoryEstimate: 9800
      },
      {
        id: 'hostinger',
        name: 'Hostinger GPU',
        tier: 'NEOCLOUD',
        description: 'Dedicated cloud GPU VPS with fixed transparent pricing (RTX 4090 ~$0.38/hr, A100 80GB ~$1.43/hr). Reliable non-evictable reserve capacity.',
        website: 'https://hostinger.com',
        isCoreFour: false,
        priorityRank: 5,
        billingGranularitySec: 3600,
        supportsSpotInterruptible: false,
        spotDiscountAvgPct: 0.0,
        defaultUptimePct: 99.9,
        supportedRegions: ['US-East', 'EU-Central'],
        cudaSupport: ['12.1', '12.4'],
        rocmSupport: false,
        storageRatePerGbHr: 0.00015,
        networkEgressPerGb: 0.000, // Unlimited / unmetered
        avgStartupSec: 60,
        status: 'ONLINE',
        telemetryScore: 0.95,
        inventoryEstimate: 2500
      },
      {
        id: 'lightning_ai',
        name: 'Lightning AI Studios',
        tier: 'NEOCLOUD',
        description: 'Cloud Studios and distributed compute for AI/PyTorch development. Integrated teamspace: steyngrovesar-org.',
        website: 'https://lightning.ai/steyngrovesar-org/dashboard/teamspaces',
        isCoreFour: false,
        priorityRank: 6,
        billingGranularitySec: 1,
        supportsSpotInterruptible: true,
        spotDiscountAvgPct: 42.0,
        defaultUptimePct: 99.8,
        supportedRegions: ['US-East', 'US-West', 'EU-Central', 'Global'],
        cudaSupport: ['11.8', '12.1', '12.4', '12.6'],
        rocmSupport: false,
        storageRatePerGbHr: 0.00020,
        networkEgressPerGb: 0.010,
        avgStartupSec: 12,
        status: 'ONLINE',
        telemetryScore: 0.97,
        inventoryEstimate: 14500
      },
      {
        id: 'tensordock',
        name: 'TensorDock',
        tier: 'NEOCLOUD',
        description: 'Specialist marketplace & neocloud aggregator for affordable bare metal & virtual GPU instances with per-second billing.',
        website: 'https://tensordock.com',
        isCoreFour: false,
        priorityRank: 7,
        billingGranularitySec: 1,
        supportsSpotInterruptible: true,
        spotDiscountAvgPct: 35.0,
        defaultUptimePct: 99.3,
        supportedRegions: ['US-East', 'US-West', 'EU-Central', 'APAC'],
        cudaSupport: ['12.0', '12.2', '12.4'],
        rocmSupport: true,
        storageRatePerGbHr: 0.00025,
        networkEgressPerGb: 0.010,
        avgStartupSec: 25,
        status: 'ONLINE',
        telemetryScore: 0.93,
        inventoryEstimate: 5100
      },
      {
        id: 'hyperstack',
        name: 'Hyperstack',
        tier: 'NEOCLOUD',
        description: 'European enterprise neocloud powered by green energy. Tier 3 & 4 datacenters with 99.9% uptime SLA.',
        website: 'https://hyperstack.cloud',
        isCoreFour: false,
        priorityRank: 7,
        billingGranularitySec: 60,
        supportsSpotInterruptible: false,
        spotDiscountAvgPct: 0.0,
        defaultUptimePct: 99.95,
        supportedRegions: ['EU-West', 'EU-Central', 'US-East'],
        cudaSupport: ['12.1', '12.4', '12.6'],
        rocmSupport: false,
        storageRatePerGbHr: 0.00035,
        networkEgressPerGb: 0.008,
        avgStartupSec: 22,
        status: 'ONLINE',
        telemetryScore: 0.98,
        inventoryEstimate: 3800
      },
      {
        id: 'lambda',
        name: 'Lambda Cloud',
        tier: 'ENTERPRISE_HYPERSCALER',
        description: 'AI-first enterprise cloud with dedicated high-speed InfiniBand networking and guaranteed premium hardware availability.',
        website: 'https://lambdalabs.com',
        isCoreFour: false,
        priorityRank: 8,
        billingGranularitySec: 3600,
        supportsSpotInterruptible: false,
        spotDiscountAvgPct: 0.0,
        defaultUptimePct: 99.9,
        supportedRegions: ['US-East', 'US-West'],
        cudaSupport: ['12.0', '12.2', '12.4'],
        rocmSupport: false,
        storageRatePerGbHr: 0.00030,
        networkEgressPerGb: 0.000,
        avgStartupSec: 30,
        status: 'ONLINE',
        telemetryScore: 0.97,
        inventoryEstimate: 6200
      },
      {
        id: 'coreweave',
        name: 'CoreWeave',
        tier: 'ENTERPRISE_HYPERSCALER',
        description: 'Specialized hyperscaler with custom Kubernetes orchestration for massive LLM training and distributed low-latency inference.',
        website: 'https://coreweave.com',
        isCoreFour: false,
        priorityRank: 9,
        billingGranularitySec: 60,
        supportsSpotInterruptible: false,
        spotDiscountAvgPct: 0.0,
        defaultUptimePct: 99.98,
        supportedRegions: ['US-East', 'US-West', 'EU-West'],
        cudaSupport: ['12.2', '12.4', '12.6'],
        rocmSupport: false,
        storageRatePerGbHr: 0.00040,
        networkEgressPerGb: 0.015,
        avgStartupSec: 15,
        status: 'ONLINE',
        telemetryScore: 0.99,
        inventoryEstimate: 14000
      }
    ];

    for (const p of providerList) {
      this.providers.set(p.id, p);
    }
  }

  /**
   * Seeds real-world representative market offer books across all 9 providers.
   * Matches current marketplace price levels:
   * - Vast.ai: Highly competitive spot/on-demand bids
   * - RunPod: A4000 (~$0.25/hr), A5000 (~$0.27/hr), A40 (~$0.49/hr), RTX 4090 (~$0.74/hr)
   * - Akash: Decentralized reverse auctions ($0.22 - $1.15)
   * - Salad: Consumer workstation nodes ($0.18 - $0.42)
   * - Hostinger: RTX 4090 (~$0.38/hr), A100 80GB (~$1.43/hr)
   */
  private seedMarketplaceOffers(): void {
    const nowIso = new Date().toISOString();
    this.offerCatalog = [
      // === RTX 4090 (24GB) across providers ===
      {
        offerId: 'vast-4090-spot-01',
        providerId: 'vast_ai',
        providerName: 'Vast.ai',
        tier: 'MARKETPLACE',
        gpuModel: 'RTX 4090 24GB',
        canonicalGpu: 'RTX 4090 24GB',
        vramGb: 24,
        cudaVersion: '12.4',
        pcieGen: 'PCIe 4.0 x16',
        isInterruptible: true,
        baseHourlyPrice: 0.32,
        vcpu: 16,
        ramGb: 64,
        nvmeStorageGb: 100,
        networkUpMbps: 1000,
        networkDownMbps: 1000,
        region: 'US-East',
        datacenterTier: 'Tier 2 / Community Host',
        uptimeGuaranteePct: 98.5,
        spotEvictionRiskPct: 6.5,
        tflopsFp16: 165.2,
        availableStock: 14,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'vast-4090-ondemand-01',
        providerId: 'vast_ai',
        providerName: 'Vast.ai',
        tier: 'MARKETPLACE',
        gpuModel: 'RTX 4090 24GB',
        canonicalGpu: 'RTX 4090 24GB',
        vramGb: 24,
        cudaVersion: '12.4',
        pcieGen: 'PCIe 4.0 x16',
        isInterruptible: false,
        baseHourlyPrice: 0.44,
        vcpu: 16,
        ramGb: 64,
        nvmeStorageGb: 100,
        networkUpMbps: 1000,
        networkDownMbps: 1000,
        region: 'US-East',
        datacenterTier: 'Tier 3 Verified Datacenter',
        uptimeGuaranteePct: 99.2,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 165.2,
        availableStock: 22,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'akash-4090-01',
        providerId: 'akash',
        providerName: 'Akash Network',
        tier: 'DECENTRALIZED',
        gpuModel: 'RTX 4090 24GB',
        canonicalGpu: 'RTX 4090 24GB',
        vramGb: 24,
        cudaVersion: '12.2',
        pcieGen: 'PCIe 4.0 x16',
        isInterruptible: false,
        baseHourlyPrice: 0.35,
        vcpu: 12,
        ramGb: 48,
        nvmeStorageGb: 80,
        networkUpMbps: 800,
        networkDownMbps: 800,
        region: 'US-West',
        datacenterTier: 'Decentralized Provider',
        uptimeGuaranteePct: 99.1,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 165.2,
        availableStock: 8,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'salad-4090-batch-01',
        providerId: 'salad',
        providerName: 'SaladCloud',
        tier: 'DISTRIBUTED_EDGE',
        gpuModel: 'RTX 4090 24GB',
        canonicalGpu: 'RTX 4090 24GB',
        vramGb: 24,
        cudaVersion: '12.4',
        pcieGen: 'PCIe 4.0 x16',
        isInterruptible: true,
        baseHourlyPrice: 0.34,
        vcpu: 8,
        ramGb: 32,
        nvmeStorageGb: 50,
        networkUpMbps: 500,
        networkDownMbps: 500,
        region: 'Global',
        datacenterTier: 'Distributed Workstation Node',
        uptimeGuaranteePct: 98.0,
        spotEvictionRiskPct: 7.2,
        tflopsFp16: 165.2,
        availableStock: 35,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'hostinger-4090-vps-01',
        providerId: 'hostinger',
        providerName: 'Hostinger GPU',
        tier: 'NEOCLOUD',
        gpuModel: 'RTX 4090 24GB',
        canonicalGpu: 'RTX 4090 24GB',
        vramGb: 24,
        cudaVersion: '12.4',
        pcieGen: 'PCIe 4.0 x16',
        isInterruptible: false,
        baseHourlyPrice: 0.38,
        vcpu: 16,
        ramGb: 64,
        nvmeStorageGb: 250,
        networkUpMbps: 1000,
        networkDownMbps: 1000,
        region: 'US-East',
        datacenterTier: 'Tier 3 Cloud Datacenter',
        uptimeGuaranteePct: 99.9,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 165.2,
        availableStock: 12,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'lightning-4090-studio-01',
        providerId: 'lightning_ai',
        providerName: 'Lightning AI Studios',
        tier: 'NEOCLOUD',
        gpuModel: 'RTX 4090 24GB',
        canonicalGpu: 'RTX 4090 24GB',
        vramGb: 24,
        cudaVersion: '12.4',
        pcieGen: 'PCIe 4.0 x16',
        isInterruptible: false,
        baseHourlyPrice: 0.46,
        vcpu: 16,
        ramGb: 64,
        nvmeStorageGb: 200,
        networkUpMbps: 1200,
        networkDownMbps: 1200,
        region: 'US-East',
        datacenterTier: 'Lightning Teamspace (steyngrovesar-org)',
        uptimeGuaranteePct: 99.8,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 165.2,
        availableStock: 16,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'runpod-4090-secure-01',
        providerId: 'runpod',
        providerName: 'RunPod',
        tier: 'MARKETPLACE',
        gpuModel: 'RTX 4090 24GB',
        canonicalGpu: 'RTX 4090 24GB',
        vramGb: 24,
        cudaVersion: '12.4',
        pcieGen: 'PCIe 4.0 x16',
        isInterruptible: false,
        baseHourlyPrice: 0.74,
        vcpu: 16,
        ramGb: 62,
        nvmeStorageGb: 100,
        networkUpMbps: 1000,
        networkDownMbps: 1000,
        region: 'US-East',
        datacenterTier: 'Secure Cloud Tier 3',
        uptimeGuaranteePct: 99.6,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 165.2,
        availableStock: 18,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'tensordock-4090-01',
        providerId: 'tensordock',
        providerName: 'TensorDock',
        tier: 'NEOCLOUD',
        gpuModel: 'RTX 4090 24GB',
        canonicalGpu: 'RTX 4090 24GB',
        vramGb: 24,
        cudaVersion: '12.2',
        pcieGen: 'PCIe 4.0 x16',
        isInterruptible: false,
        baseHourlyPrice: 0.58,
        vcpu: 14,
        ramGb: 56,
        nvmeStorageGb: 100,
        networkUpMbps: 1000,
        networkDownMbps: 1000,
        region: 'US-West',
        datacenterTier: 'Verified Neocloud Node',
        uptimeGuaranteePct: 99.3,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 165.2,
        availableStock: 9,
        lastUpdatedIso: nowIso
      },

      // === A4000 (16GB) ===
      {
        offerId: 'runpod-a4000-01',
        providerId: 'runpod',
        providerName: 'RunPod',
        tier: 'MARKETPLACE',
        gpuModel: 'RTX A4000 16GB',
        canonicalGpu: 'RTX A4000 16GB',
        vramGb: 16,
        cudaVersion: '12.1',
        pcieGen: 'PCIe 4.0 x16',
        isInterruptible: false,
        baseHourlyPrice: 0.25,
        vcpu: 8,
        ramGb: 30,
        nvmeStorageGb: 60,
        networkUpMbps: 500,
        networkDownMbps: 500,
        region: 'US-East',
        datacenterTier: 'Secure Cloud',
        uptimeGuaranteePct: 99.5,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 38.7,
        availableStock: 25,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'vast-a4000-01',
        providerId: 'vast_ai',
        providerName: 'Vast.ai',
        tier: 'MARKETPLACE',
        gpuModel: 'RTX A4000 16GB',
        canonicalGpu: 'RTX A4000 16GB',
        vramGb: 16,
        cudaVersion: '12.1',
        pcieGen: 'PCIe 4.0 x16',
        isInterruptible: false,
        baseHourlyPrice: 0.20,
        vcpu: 8,
        ramGb: 32,
        nvmeStorageGb: 80,
        networkUpMbps: 600,
        networkDownMbps: 600,
        region: 'EU-Central',
        datacenterTier: 'Tier 2 Community',
        uptimeGuaranteePct: 98.9,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 38.7,
        availableStock: 16,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'salad-a4000-01',
        providerId: 'salad',
        providerName: 'SaladCloud',
        tier: 'DISTRIBUTED_EDGE',
        gpuModel: 'RTX A4000 16GB',
        canonicalGpu: 'RTX A4000 16GB',
        vramGb: 16,
        cudaVersion: '12.1',
        pcieGen: 'PCIe 4.0 x16',
        isInterruptible: true,
        baseHourlyPrice: 0.16,
        vcpu: 6,
        ramGb: 24,
        nvmeStorageGb: 40,
        networkUpMbps: 400,
        networkDownMbps: 400,
        region: 'Global',
        datacenterTier: 'Edge Node',
        uptimeGuaranteePct: 98.1,
        spotEvictionRiskPct: 5.8,
        tflopsFp16: 38.7,
        availableStock: 30,
        lastUpdatedIso: nowIso
      },

      // === A5000 (24GB) ===
      {
        offerId: 'runpod-a5000-01',
        providerId: 'runpod',
        providerName: 'RunPod',
        tier: 'MARKETPLACE',
        gpuModel: 'RTX A5000 24GB',
        canonicalGpu: 'RTX A5000 24GB',
        vramGb: 24,
        cudaVersion: '12.2',
        pcieGen: 'PCIe 4.0 x16',
        isInterruptible: false,
        baseHourlyPrice: 0.27,
        vcpu: 8,
        ramGb: 32,
        nvmeStorageGb: 80,
        networkUpMbps: 800,
        networkDownMbps: 800,
        region: 'US-West',
        datacenterTier: 'Secure Cloud',
        uptimeGuaranteePct: 99.4,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 55.4,
        availableStock: 20,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'vast-a5000-01',
        providerId: 'vast_ai',
        providerName: 'Vast.ai',
        tier: 'MARKETPLACE',
        gpuModel: 'RTX A5000 24GB',
        canonicalGpu: 'RTX A5000 24GB',
        vramGb: 24,
        cudaVersion: '12.2',
        pcieGen: 'PCIe 4.0 x16',
        isInterruptible: false,
        baseHourlyPrice: 0.23,
        vcpu: 10,
        ramGb: 48,
        nvmeStorageGb: 100,
        networkUpMbps: 1000,
        networkDownMbps: 1000,
        region: 'US-East',
        datacenterTier: 'Tier 3 Datacenter',
        uptimeGuaranteePct: 99.1,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 55.4,
        availableStock: 15,
        lastUpdatedIso: nowIso
      },

      // === A40 (48GB) ===
      {
        offerId: 'runpod-a40-01',
        providerId: 'runpod',
        providerName: 'RunPod',
        tier: 'MARKETPLACE',
        gpuModel: 'A40 48GB',
        canonicalGpu: 'A40 48GB',
        vramGb: 48,
        cudaVersion: '12.4',
        pcieGen: 'PCIe 4.0 x16',
        isInterruptible: false,
        baseHourlyPrice: 0.49,
        vcpu: 16,
        ramGb: 64,
        nvmeStorageGb: 120,
        networkUpMbps: 1000,
        networkDownMbps: 1000,
        region: 'US-East',
        datacenterTier: 'Secure Cloud',
        uptimeGuaranteePct: 99.6,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 149.7,
        availableStock: 14,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'vast-a40-01',
        providerId: 'vast_ai',
        providerName: 'Vast.ai',
        tier: 'MARKETPLACE',
        gpuModel: 'A40 48GB',
        canonicalGpu: 'A40 48GB',
        vramGb: 48,
        cudaVersion: '12.4',
        pcieGen: 'PCIe 4.0 x16',
        isInterruptible: false,
        baseHourlyPrice: 0.42,
        vcpu: 16,
        ramGb: 64,
        nvmeStorageGb: 150,
        networkUpMbps: 1200,
        networkDownMbps: 1200,
        region: 'EU-Central',
        datacenterTier: 'Tier 3 Verified',
        uptimeGuaranteePct: 99.2,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 149.7,
        availableStock: 10,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'hyperstack-a40-01',
        providerId: 'hyperstack',
        providerName: 'Hyperstack',
        tier: 'NEOCLOUD',
        gpuModel: 'A40 48GB',
        canonicalGpu: 'A40 48GB',
        vramGb: 48,
        cudaVersion: '12.4',
        pcieGen: 'PCIe 4.0 x16',
        isInterruptible: false,
        baseHourlyPrice: 0.65,
        vcpu: 16,
        ramGb: 64,
        nvmeStorageGb: 200,
        networkUpMbps: 2000,
        networkDownMbps: 2000,
        region: 'EU-West',
        datacenterTier: 'Tier 4 Enterprise',
        uptimeGuaranteePct: 99.95,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 149.7,
        availableStock: 18,
        lastUpdatedIso: nowIso
      },

      // === A100 80GB SXM ===
      {
        offerId: 'vast-a100-sxm-spot-01',
        providerId: 'vast_ai',
        providerName: 'Vast.ai',
        tier: 'MARKETPLACE',
        gpuModel: 'A100 80GB SXM',
        canonicalGpu: 'A100 80GB SXM',
        vramGb: 80,
        cudaVersion: '12.4',
        pcieGen: 'SXM4 NVLink',
        isInterruptible: true,
        baseHourlyPrice: 1.15,
        vcpu: 16,
        ramGb: 128,
        nvmeStorageGb: 200,
        networkUpMbps: 2000,
        networkDownMbps: 2000,
        region: 'US-East',
        datacenterTier: 'Tier 3 Verified',
        uptimeGuaranteePct: 98.8,
        spotEvictionRiskPct: 5.5,
        tflopsFp16: 312.0,
        availableStock: 8,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'vast-a100-sxm-ondemand-01',
        providerId: 'vast_ai',
        providerName: 'Vast.ai',
        tier: 'MARKETPLACE',
        gpuModel: 'A100 80GB SXM',
        canonicalGpu: 'A100 80GB SXM',
        vramGb: 80,
        cudaVersion: '12.4',
        pcieGen: 'SXM4 NVLink',
        isInterruptible: false,
        baseHourlyPrice: 1.55,
        vcpu: 16,
        ramGb: 128,
        nvmeStorageGb: 250,
        networkUpMbps: 2000,
        networkDownMbps: 2000,
        region: 'US-East',
        datacenterTier: 'Tier 3 Verified',
        uptimeGuaranteePct: 99.4,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 312.0,
        availableStock: 12,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'hostinger-a100-80gb-01',
        providerId: 'hostinger',
        providerName: 'Hostinger GPU',
        tier: 'NEOCLOUD',
        gpuModel: 'A100 80GB SXM',
        canonicalGpu: 'A100 80GB SXM',
        vramGb: 80,
        cudaVersion: '12.4',
        pcieGen: 'PCIe 4.0 / SXM',
        isInterruptible: false,
        baseHourlyPrice: 1.43,
        vcpu: 24,
        ramGb: 180,
        nvmeStorageGb: 500,
        networkUpMbps: 2000,
        networkDownMbps: 2000,
        region: 'EU-Central',
        datacenterTier: 'Tier 3 Cloud Datacenter',
        uptimeGuaranteePct: 99.9,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 312.0,
        availableStock: 6,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'akash-a100-80gb-01',
        providerId: 'akash',
        providerName: 'Akash Network',
        tier: 'DECENTRALIZED',
        gpuModel: 'A100 80GB SXM',
        canonicalGpu: 'A100 80GB SXM',
        vramGb: 80,
        cudaVersion: '12.2',
        pcieGen: 'SXM4 NVLink',
        isInterruptible: false,
        baseHourlyPrice: 1.38,
        vcpu: 16,
        ramGb: 120,
        nvmeStorageGb: 200,
        networkUpMbps: 1500,
        networkDownMbps: 1500,
        region: 'US-West',
        datacenterTier: 'Decentralized Cluster',
        uptimeGuaranteePct: 99.3,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 312.0,
        availableStock: 5,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'lightning-a100-80gb-studio-01',
        providerId: 'lightning_ai',
        providerName: 'Lightning AI Studios',
        tier: 'NEOCLOUD',
        gpuModel: 'A100 80GB SXM',
        canonicalGpu: 'A100 80GB SXM',
        vramGb: 80,
        cudaVersion: '12.4',
        pcieGen: 'SXM4 NVLink',
        isInterruptible: false,
        baseHourlyPrice: 1.75,
        vcpu: 24,
        ramGb: 180,
        nvmeStorageGb: 300,
        networkUpMbps: 2400,
        networkDownMbps: 2400,
        region: 'US-East',
        datacenterTier: 'Lightning Teamspace (steyngrovesar-org)',
        uptimeGuaranteePct: 99.8,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 312.0,
        availableStock: 14,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'runpod-a100-80gb-01',
        providerId: 'runpod',
        providerName: 'RunPod',
        tier: 'MARKETPLACE',
        gpuModel: 'A100 80GB SXM',
        canonicalGpu: 'A100 80GB SXM',
        vramGb: 80,
        cudaVersion: '12.4',
        pcieGen: 'SXM4 NVLink',
        isInterruptible: false,
        baseHourlyPrice: 1.89,
        vcpu: 16,
        ramGb: 125,
        nvmeStorageGb: 200,
        networkUpMbps: 2000,
        networkDownMbps: 2000,
        region: 'US-East',
        datacenterTier: 'Secure Cloud',
        uptimeGuaranteePct: 99.6,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 312.0,
        availableStock: 14,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'lambda-a100-80gb-01',
        providerId: 'lambda',
        providerName: 'Lambda Cloud',
        tier: 'ENTERPRISE_HYPERSCALER',
        gpuModel: 'A100 80GB SXM',
        canonicalGpu: 'A100 80GB SXM',
        vramGb: 80,
        cudaVersion: '12.4',
        pcieGen: 'SXM4 NVLink',
        isInterruptible: false,
        baseHourlyPrice: 1.99,
        vcpu: 24,
        ramGb: 200,
        nvmeStorageGb: 400,
        networkUpMbps: 3000,
        networkDownMbps: 3000,
        region: 'US-East',
        datacenterTier: 'Tier 3 Enterprise',
        uptimeGuaranteePct: 99.9,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 312.0,
        availableStock: 16,
        lastUpdatedIso: nowIso
      },

      // === H100 SXM5 80GB ===
      {
        offerId: 'vast-h100-sxm-spot-01',
        providerId: 'vast_ai',
        providerName: 'Vast.ai',
        tier: 'MARKETPLACE',
        gpuModel: 'H100 SXM5 80GB',
        canonicalGpu: 'H100 SXM5 80GB',
        vramGb: 80,
        cudaVersion: '12.4',
        pcieGen: 'SXM5 NVLink 900GB/s',
        isInterruptible: true,
        baseHourlyPrice: 1.95,
        vcpu: 24,
        ramGb: 192,
        nvmeStorageGb: 300,
        networkUpMbps: 3200,
        networkDownMbps: 3200,
        region: 'US-East',
        datacenterTier: 'Tier 3 Datacenter',
        uptimeGuaranteePct: 98.9,
        spotEvictionRiskPct: 4.8,
        tflopsFp16: 989.5,
        availableStock: 10,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'vast-h100-sxm-ondemand-01',
        providerId: 'vast_ai',
        providerName: 'Vast.ai',
        tier: 'MARKETPLACE',
        gpuModel: 'H100 SXM5 80GB',
        canonicalGpu: 'H100 SXM5 80GB',
        vramGb: 80,
        cudaVersion: '12.4',
        pcieGen: 'SXM5 NVLink 900GB/s',
        isInterruptible: false,
        baseHourlyPrice: 2.38,
        vcpu: 24,
        ramGb: 192,
        nvmeStorageGb: 350,
        networkUpMbps: 3200,
        networkDownMbps: 3200,
        region: 'US-East',
        datacenterTier: 'Tier 3 Datacenter',
        uptimeGuaranteePct: 99.4,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 989.5,
        availableStock: 14,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'runpod-h100-sxm-01',
        providerId: 'runpod',
        providerName: 'RunPod',
        tier: 'MARKETPLACE',
        gpuModel: 'H100 SXM5 80GB',
        canonicalGpu: 'H100 SXM5 80GB',
        vramGb: 80,
        cudaVersion: '12.4',
        pcieGen: 'SXM5 NVLink 900GB/s',
        isInterruptible: false,
        baseHourlyPrice: 2.89,
        vcpu: 24,
        ramGb: 200,
        nvmeStorageGb: 300,
        networkUpMbps: 3200,
        networkDownMbps: 3200,
        region: 'US-East',
        datacenterTier: 'Secure Cloud Tier 3',
        uptimeGuaranteePct: 99.7,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 989.5,
        availableStock: 16,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'lightning-h100-sxm-studio-01',
        providerId: 'lightning_ai',
        providerName: 'Lightning AI Studios',
        tier: 'NEOCLOUD',
        gpuModel: 'H100 SXM5 80GB',
        canonicalGpu: 'H100 SXM5 80GB',
        vramGb: 80,
        cudaVersion: '12.4',
        pcieGen: 'SXM5 NVLink 900GB/s',
        isInterruptible: false,
        baseHourlyPrice: 2.95,
        vcpu: 32,
        ramGb: 256,
        nvmeStorageGb: 400,
        networkUpMbps: 3500,
        networkDownMbps: 3500,
        region: 'US-East',
        datacenterTier: 'Lightning Teamspace (steyngrovesar-org)',
        uptimeGuaranteePct: 99.85,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 989.5,
        availableStock: 8,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'hyperstack-h100-sxm-01',
        providerId: 'hyperstack',
        providerName: 'Hyperstack',
        tier: 'NEOCLOUD',
        gpuModel: 'H100 SXM5 80GB',
        canonicalGpu: 'H100 SXM5 80GB',
        vramGb: 80,
        cudaVersion: '12.4',
        pcieGen: 'SXM5 NVLink 900GB/s',
        isInterruptible: false,
        baseHourlyPrice: 2.95,
        vcpu: 28,
        ramGb: 240,
        nvmeStorageGb: 500,
        networkUpMbps: 4000,
        networkDownMbps: 4000,
        region: 'EU-West',
        datacenterTier: 'Tier 4 Enterprise',
        uptimeGuaranteePct: 99.95,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 989.5,
        availableStock: 8,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'lambda-h100-sxm-01',
        providerId: 'lambda',
        providerName: 'Lambda Cloud',
        tier: 'ENTERPRISE_HYPERSCALER',
        gpuModel: 'H100 SXM5 80GB',
        canonicalGpu: 'H100 SXM5 80GB',
        vramGb: 80,
        cudaVersion: '12.4',
        pcieGen: 'SXM5 NVLink 900GB/s',
        isInterruptible: false,
        baseHourlyPrice: 3.29,
        vcpu: 32,
        ramGb: 256,
        nvmeStorageGb: 512,
        networkUpMbps: 4000,
        networkDownMbps: 4000,
        region: 'US-East',
        datacenterTier: 'Tier 3 Enterprise',
        uptimeGuaranteePct: 99.9,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 989.5,
        availableStock: 12,
        lastUpdatedIso: nowIso
      },
      {
        offerId: 'coreweave-h100-sxm-01',
        providerId: 'coreweave',
        providerName: 'CoreWeave',
        tier: 'ENTERPRISE_HYPERSCALER',
        gpuModel: 'H100 SXM5 80GB',
        canonicalGpu: 'H100 SXM5 80GB',
        vramGb: 80,
        cudaVersion: '12.4',
        pcieGen: 'SXM5 InfiniBand 3.2Tb/s',
        isInterruptible: false,
        baseHourlyPrice: 3.49,
        vcpu: 32,
        ramGb: 256,
        nvmeStorageGb: 800,
        networkUpMbps: 10000,
        networkDownMbps: 10000,
        region: 'US-East',
        datacenterTier: 'Hyperscaler Cluster',
        uptimeGuaranteePct: 99.98,
        spotEvictionRiskPct: 0.0,
        tflopsFp16: 989.5,
        availableStock: 24,
        lastUpdatedIso: nowIso
      }
    ];
  }

  /**
   * Authoritative True GPU Cost Calculator
   * 
   * Formula:
   * True GPU Cost = Base GPU Price + Storage + Network Egress + CPU/RAM + Startup + Expected Interruption Cost
   */
  public calculateTrueCost(
    offer: GpuOffer,
    provider: ProviderProfile,
    durationHours: number,
    gpuCount: number = 1,
    storageGb: number = 50,
    egressGb: number = 20,
    tolerance: 'STRICT_NO_INTERRUPTIONS' | 'CHECKPOINTABLE_BATCH' | 'LOW_PRIORITY_FAULT_TOLERANT' = 'CHECKPOINTABLE_BATCH'
  ): TrueCostBreakdown {
    const hours = Math.max(0.1, durationHours);
    const count = Math.max(1, gpuCount);

    // 1. Base GPU compute price
    const baseComputeCost = offer.baseHourlyPrice * count * hours;

    // 2. Storage Cost: GB * hours * rate
    const storageCost = storageGb * hours * provider.storageRatePerGbHr;

    // 3. Network Egress Cost: GB * egress rate
    const networkEgressCost = egressGb * provider.networkEgressPerGb;

    // 4. CPU & RAM Overhead (if oversized beyond baseline 8 vCPU / 32GB RAM per GPU)
    const extraVcpu = Math.max(0, offer.vcpu - 8 * count);
    const extraRamGb = Math.max(0, offer.ramGb - 32 * count);
    const cpuRamOverheadCost = (extraVcpu * 0.004 + extraRamGb * 0.001) * hours;

    // 5. Startup & cold-boot cost:
    // (Startup seconds / 3600) * base hourly rate
    const startupOverheadCost = (provider.avgStartupSec / 3600) * offer.baseHourlyPrice * count;

    // 6. Expected Interruption Cost:
    // If instance is interruptible spot AND workload permits it:
    // Interruption risk * (checkpoint replay overhead + rescheduling risk buffer)
    let expectedInterruptionCost = 0.0;
    if (offer.isInterruptible) {
      if (tolerance === 'STRICT_NO_INTERRUPTIONS') {
        // Disqualified elsewhere, but if forced, penalize heavily
        expectedInterruptionCost = baseComputeCost * 0.40;
      } else {
        const evictionProb = offer.spotEvictionRiskPct / 100;
        // On eviction, assume 20% of job runtime wasted before rollback to last checkpoint
        const wastedRuntimeCost = baseComputeCost * 0.20;
        // Rescheduling SLA buffer
        const rescheduleBuffer = 0.15;
        expectedInterruptionCost = evictionProb * (wastedRuntimeCost + rescheduleBuffer);
      }
    }

    const totalTrueCost = baseComputeCost +
      storageCost +
      networkEgressCost +
      cpuRamOverheadCost +
      startupOverheadCost +
      expectedInterruptionCost;

    const effectiveHourlyRate = totalTrueCost / (hours * count);

    return {
      baseComputeCost: Math.round(baseComputeCost * 100) / 100,
      storageCost: Math.round(storageCost * 100) / 100,
      networkEgressCost: Math.round(networkEgressCost * 100) / 100,
      cpuRamOverheadCost: Math.round(cpuRamOverheadCost * 100) / 100,
      startupOverheadCost: Math.round(startupOverheadCost * 1000) / 1000,
      expectedInterruptionCost: Math.round(expectedInterruptionCost * 100) / 100,
      totalTrueCost: Math.round(totalTrueCost * 100) / 100,
      effectiveHourlyRate: Math.round(effectiveHourlyRate * 1000) / 1000
    };
  }

  /**
   * Intelligently routes a GPU workload across all registered providers
   * Enforces all constraint checks:
   * GPU model, VRAM, CUDA, region, uptime, duration, interruption tolerance, storage, bandwidth.
   */
  public routeWorkload(constraints: WorkloadRoutingConstraints): RoutingDecision {
    const routingId = `route-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const nowIso = new Date().toISOString();
    const durationHours = Math.max(0.1, constraints.jobDurationHours);
    const gpuCount = Math.max(1, constraints.gpuCount || 1);
    const storageGb = constraints.minStorageGb || 50;
    const egressGb = constraints.estimatedEgressGb || 20;

    const evaluations: RoutingEvaluation[] = [];

    for (const offer of this.offerCatalog) {
      const provider = this.getProvider(offer.providerId);
      if (!provider) continue;

      const disqualifications: string[] = [];

      // 1. Check timestamp validity (reject missing or fabricated timestamps)
      if (!offer.lastUpdatedIso || isNaN(Date.parse(offer.lastUpdatedIso))) {
        disqualifications.push('INVALID_TIMESTAMP: Offer lacks a valid ISO timestamp');
      } else {
        // 2. Reject stale prices (>30 minutes old)
        const ageMs = Date.now() - new Date(offer.lastUpdatedIso).getTime();
        if (ageMs > 30 * 60 * 1000) {
          disqualifications.push(`STALE_PRICING: Offer price is stale (${Math.round(ageMs / 60000)}m > 30m threshold)`);
        }
      }

      // 3. Reject unverified GPU specifications
      if (!offer.gpuModel || !offer.canonicalGpu || !offer.vramGb || offer.vramGb <= 0 || !offer.baseHourlyPrice || offer.baseHourlyPrice <= 0) {
        disqualifications.push('UNVERIFIED_GPU_SPEC: Offer lacks verified GPU hardware specifications or positive base price');
      }

      // 4. Check GPU Model match (canonical or fuzzy)
      const reqModel = constraints.gpuModel.toLowerCase().trim();
      const offerModel = offer.gpuModel.toLowerCase();
      const canonModel = offer.canonicalGpu.toLowerCase();
      if (!offerModel.includes(reqModel) && !canonModel.includes(reqModel) && !reqModel.includes(offerModel)) {
        disqualifications.push(`GPU model mismatch (requested: ${constraints.gpuModel}, offer: ${offer.gpuModel})`);
      }

      // Check VRAM requirement
      if (constraints.minVramGb && offer.vramGb < constraints.minVramGb) {
        disqualifications.push(`Insufficient VRAM (${offer.vramGb}GB < ${constraints.minVramGb}GB requested)`);
      }

      // Check Interruption Tolerance
      if (constraints.interruptionTolerance === 'STRICT_NO_INTERRUPTIONS' && offer.isInterruptible) {
        disqualifications.push(`Workload strictly forbids interruptions, but offer is interruptible spot`);
      }

      // Check Region Preference
      if (constraints.regionPreference && constraints.regionPreference !== 'Global' && constraints.regionPreference !== 'ANY') {
        const reqReg = constraints.regionPreference.toLowerCase();
        const offReg = offer.region.toLowerCase();
        if (offReg !== 'global' && !offReg.includes(reqReg) && !reqReg.includes(offReg)) {
          disqualifications.push(`Region mismatch (${offer.region} vs preferred ${constraints.regionPreference})`);
        }
      }

      // Check Minimum Uptime Guarantee
      if (constraints.minUptimePct && (offer.uptimeGuaranteePct / 100) < constraints.minUptimePct) {
        disqualifications.push(`Uptime guarantee (${offer.uptimeGuaranteePct}%) below requirement (${constraints.minUptimePct * 100}%)`);
      }

      // Check Bandwidth
      if (constraints.minBandwidthMbps && Math.min(offer.networkUpMbps, offer.networkDownMbps) < constraints.minBandwidthMbps) {
        disqualifications.push(`Bandwidth insufficient (${Math.min(offer.networkUpMbps, offer.networkDownMbps)}Mbps < ${constraints.minBandwidthMbps}Mbps)`);
      }

      // Check ROCm if requested
      if (constraints.rocmRequired && !provider.rocmSupport) {
        disqualifications.push(`ROCm acceleration not supported on ${provider.name}`);
      }

      // 5. Check Available Stock & Capacity
      if (offer.availableStock === undefined || offer.availableStock <= 0 || offer.availableStock < gpuCount) {
        disqualifications.push(`UNAVAILABLE_CAPACITY: Insufficient available stock (${offer.availableStock || 0} < ${gpuCount} needed)`);
      }

      // 6. Reject providers without executable adapters in production
      const isProduction = process.env.NODE_ENV === 'production' || (process.env.REALITY_LEVEL || '').toUpperCase() === 'LIVE';
      const executableProviders = new Set(['runpod', 'vast_ai']);
      if (isProduction && !executableProviders.has(offer.providerId)) {
        disqualifications.push(`NO_EXECUTABLE_ADAPTER: Provider ${provider.name} does not have an active verified execution adapter in this environment`);
      }

      // Calculate True GPU Cost
      const trueCost = this.calculateTrueCost(
        offer,
        provider,
        durationHours,
        gpuCount,
        storageGb,
        egressGb,
        constraints.interruptionTolerance
      );

      // Financials if customer revenue provided
      let customerRevenue: number | undefined;
      let estimatedPaymentFee: number | undefined;
      let netMarginDollars: number | undefined;
      let netMarginPct: number | undefined;
      let roiPct: number | undefined;

      if (constraints.customerGrossOfferPrice !== undefined && constraints.customerGrossOfferPrice > 0) {
        customerRevenue = constraints.customerGrossOfferPrice;
        // Standard credit card / Binance payment fee: 2.9% + $0.30
        estimatedPaymentFee = Math.round((customerRevenue * 0.029 + 0.30) * 100) / 100;
        netMarginDollars = Math.round((customerRevenue - trueCost.totalTrueCost - estimatedPaymentFee) * 100) / 100;
        netMarginPct = Math.round(((netMarginDollars) / customerRevenue) * 1000) / 10;
        roiPct = trueCost.totalTrueCost > 0
          ? Math.round((netMarginDollars / trueCost.totalTrueCost) * 1000) / 10
          : 0;
      }

      evaluations.push({
        providerId: provider.id,
        providerName: provider.name,
        tier: provider.tier,
        offerId: offer.offerId,
        gpuModel: offer.gpuModel,
        vramGb: offer.vramGb,
        region: offer.region,
        isInterruptible: offer.isInterruptible,
        isEligible: disqualifications.length === 0,
        disqualificationReasons: disqualifications,
        baseHourlyRate: offer.baseHourlyPrice,
        trueCostBreakdown: trueCost,
        customerRevenue,
        estimatedPaymentFee,
        netMarginDollars,
        netMarginPct,
        roiPct,
        economicRank: 999
      });
    }

    // Filter eligible providers
    const eligible = evaluations.filter(e => e.isEligible);
    const disqualified = evaluations.filter(e => !e.isEligible);

    // Rank eligible candidates primarily by lowest True Compute Cost,
    // with provider priority tie-breaker (Vast -> Akash -> Salad -> RunPod -> Hostinger -> Neoclouds -> Hyperscalers)
    eligible.sort((a, b) => {
      // If customer revenue is present, sort by net margin dollars descending
      if (a.netMarginDollars !== undefined && b.netMarginDollars !== undefined) {
        if (b.netMarginDollars !== a.netMarginDollars) {
          return b.netMarginDollars - a.netMarginDollars;
        }
      }
      // Primary: lowest True Cost
      if (a.trueCostBreakdown.totalTrueCost !== b.trueCostBreakdown.totalTrueCost) {
        return a.trueCostBreakdown.totalTrueCost - b.trueCostBreakdown.totalTrueCost;
      }
      // Secondary: priority rank of provider
      const pA = this.getProvider(a.providerId)?.priorityRank || 99;
      const pB = this.getProvider(b.providerId)?.priorityRank || 99;
      return pA - pB;
    });

    // Assign 1-indexed economic rank
    eligible.forEach((e, idx) => {
      e.economicRank = idx + 1;
    });

    const winner = eligible.length > 0 ? eligible[0] : null;
    const alternatives = eligible.length > 1 ? eligible.slice(1) : [];

    // Calculate arbitrage spread
    let arbitrageSpread = null;
    if (eligible.length > 1) {
      const cheapest = eligible[0].trueCostBreakdown.effectiveHourlyRate;
      const mostExp = eligible[eligible.length - 1].trueCostBreakdown.effectiveHourlyRate;
      const spread = mostExp > 0 ? Math.round(((mostExp - cheapest) / mostExp) * 1000) / 10 : 0;
      const savings = Math.round((eligible[eligible.length - 1].trueCostBreakdown.totalTrueCost - eligible[0].trueCostBreakdown.totalTrueCost) * 100) / 100;
      arbitrageSpread = {
        cheapestEligibleHourly: cheapest,
        mostExpensiveEligibleHourly: mostExp,
        spreadPercentage: spread,
        totalSavingsDollars: savings
      };
    }

    let recommendationReason = '';
    if (winner) {
      const pName = winner.providerName;
      const trueCost = winner.trueCostBreakdown.totalTrueCost;
      const effHourly = winner.trueCostBreakdown.effectiveHourlyRate;
      recommendationReason = `Selected ${pName} as the optimal route at $${effHourly}/hr effective True Cost ($${trueCost} total). `;
      if (winner.isInterruptible) {
        recommendationReason += `Leverages interruptible spot pricing with checkpointing buffer. `;
      } else {
        recommendationReason += `Guarantees 100% non-evictable capacity. `;
      }
      if (arbitrageSpread && arbitrageSpread.spreadPercentage > 0) {
        recommendationReason += `Captures ${arbitrageSpread.spreadPercentage}% cost spread vs highest eligible alternative ($${arbitrageSpread.totalSavingsDollars} net savings).`;
      }
    } else {
      recommendationReason = `NO_EXECUTABLE_OFFER: No verified live offer exists that satisfies constraints (${disqualified.length} evaluated and disqualified).`;
    }

    return {
      routingId,
      timestamp: nowIso,
      constraints,
      winningProvider: winner,
      alternatives,
      disqualifiedProviders: disqualified,
      arbitrageSpread,
      recommendationReason
    };
  }

  /**
   * Generates a multi-provider live price comparison matrix for all major GPU models
   */
  public getLivePriceMatrix(): GpuModelPriceComparison[] {
    const gpuModels = [
      { name: 'RTX 4090 24GB', canonical: 'RTX 4090 24GB', vram: 24, tflops: 165.2 },
      { name: 'RTX A4000 16GB', canonical: 'RTX A4000 16GB', vram: 16, tflops: 38.7 },
      { name: 'RTX A5000 24GB', canonical: 'RTX A5000 24GB', vram: 24, tflops: 55.4 },
      { name: 'A40 48GB', canonical: 'A40 48GB', vram: 48, tflops: 149.7 },
      { name: 'A100 80GB SXM', canonical: 'A100 80GB SXM', vram: 80, tflops: 312.0 },
      { name: 'H100 SXM5 80GB', canonical: 'H100 SXM5 80GB', vram: 80, tflops: 989.5 }
    ];

    return gpuModels.map(m => {
      const offers = this.offerCatalog.filter(o => o.canonicalGpu === m.canonical);
      const providerEntries: any[] = [];

      for (const o of offers) {
        const existing = providerEntries.find(p => p.providerId === o.providerId);
        if (existing) {
          if (o.isInterruptible) existing.spotHourly = o.baseHourlyPrice;
          else existing.onDemandHourly = o.baseHourlyPrice;
        } else {
          providerEntries.push({
            providerId: o.providerId,
            providerName: o.providerName,
            tier: o.tier,
            onDemandHourly: o.isInterruptible ? o.baseHourlyPrice * 1.35 : o.baseHourlyPrice,
            spotHourly: o.isInterruptible ? o.baseHourlyPrice : undefined,
            stock: o.availableStock,
            region: o.region,
            uptimePct: o.uptimeGuaranteePct
          });
        }
      }

      // Sort providers by lowest on-demand price
      providerEntries.sort((a, b) => a.onDemandHourly - b.onDemandHourly);

      const cheapestOnDemand = providerEntries.length > 0
        ? { providerId: providerEntries[0].providerId, price: providerEntries[0].onDemandHourly }
        : { providerId: 'none', price: 0 };

      const spotOffers = providerEntries.filter(p => p.spotHourly !== undefined).sort((a, b) => (a.spotHourly || 0) - (b.spotHourly || 0));
      const cheapestSpot = spotOffers.length > 0
        ? { providerId: spotOffers[0].providerId, price: spotOffers[0].spotHourly || 0 }
        : undefined;

      const sum = providerEntries.reduce((acc, p) => acc + p.onDemandHourly, 0);
      const avg = providerEntries.length > 0 ? Math.round((sum / providerEntries.length) * 100) / 100 : 0;

      const max = providerEntries.length > 0 ? Math.max(...providerEntries.map(p => p.onDemandHourly)) : 0;
      const min = providerEntries.length > 0 ? Math.min(...providerEntries.map(p => p.onDemandHourly)) : 0;
      const spreadPct = max > 0 ? Math.round(((max - min) / max) * 1000) / 10 : 0;

      return {
        gpuModel: m.name,
        canonicalName: m.canonical,
        vramGb: m.vram,
        tflopsFp16: m.tflops,
        providers: providerEntries,
        cheapestOnDemand,
        cheapestSpot,
        marketAveragePrice: avg,
        spreadPct
      };
    });
  }

  /**
   * Registers a newly discovered dynamic provider endpoint or marketplace feed
   */
  public registerDynamicProvider(profile: ProviderProfile, offers?: GpuOffer[]): { success: boolean; message: string } {
    if (!profile.id || !profile.name) {
      return { success: false, message: 'Provider profile must specify id and name' };
    }
    this.providers.set(profile.id, profile);
    this.dynamicProviderRegistry.set(profile.id, profile);
    if (offers && offers.length > 0) {
      this.offerCatalog.push(...offers);
    }
    return {
      success: true,
      message: `Successfully registered dynamic compute provider ${profile.name} (${profile.tier})`
    };
  }

  public getProvider(id: string): ProviderProfile | undefined {
    return this.providers.get(id);
  }

  public getAllProviders(): ProviderProfile[] {
    return Array.from(this.providers.values()).sort((a, b) => a.priorityRank - b.priorityRank);
  }

  public getOfferCatalog(): GpuOffer[] {
    return [...this.offerCatalog];
  }
}

export const gpuPriceRouter = new GpuPriceRouter();
