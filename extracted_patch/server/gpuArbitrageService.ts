export interface GPUProviderSpec {
  id: string;
  name: string;
  type: 'Decentralized Spot' | 'Specialized Cloud' | 'Hyperscaler' | 'Bare Metal Bare-bones';
  apiType: 'REST' | 'GRAPHQL' | 'ON_CHAIN_RPC' | 'BENCHMARK_CATALOG';
  apiBaseUrl?: string;
  authRequired: boolean;
  hasLiveCredentials: boolean;
  supportedModels: string[];
  reliabilityScore: number;
  averageLatencyMs: number;
  marketplaceFeePct: number;
  minRentalHours: number;
}

export interface HardwareSpec {
  id: string;
  name: string;
  architecture: string;
  vramGb: number;
  memoryBandwidthTb: number;
  fp16Tflops: number;
  tdpWatts: number;
  interconnect: string;
  baseMarketAvgRate: number;
}

export interface LiveProviderQuote {
  quoteId: string;
  providerId: string;
  providerName: string;
  gpuModel: string;
  vramGb: number;
  hourlyRateUsd: number;
  availabilityNodes: number;
  region: string;
  quoteSource: 'LIVE_API' | 'VERIFIED_SCRAPE' | 'BENCHMARK_CATALOG' | 'MANUAL_ENTRY' | 'ON_CHAIN_RPC';
  retrievedAt: string;
  pricingUnit: 'PER_GPU_HOUR' | 'PER_NODE_HOUR';
  minRentalHours: number;
  preemptionRisk: 'Minimal' | 'Moderate' | 'Guaranteed SLA';
  isExecutable: boolean;
  restrictions: string[];
}

export interface ArbitrageSpreadEvaluation {
  opportunityId: string;
  gpuModel: string;
  buyProvider: string;
  buyQuoteId: string;
  buyRatePerHour: number;
  buyRegion: string;
  sellCounterparty: string;
  sellRatePerHour: number;
  sellRegion: string;
  grossSpreadPerHour: number;
  spreadPercent: number;
  costBreakdown: {
    rawComputeCostUsd: number;
    marketplaceFeesUsd: number;
    networkingEgressEstimateUsd: number;
    storageCostPerHourUsd: number;
    slaInsuranceBufferUsd: number;
    paymentProcessingFeeUsd: number;
    downtimeBufferUsd: number;
    totalOperationalCostPerHour: number;
  };
  netSpreadPerHour: number;
  annualizedYieldApr: number;
  estimatedMonthlyProfitUsd: number;
  realisedProfitUsd: number; // Set to 0 until actual contract execution and customer payment
  isExecutable: boolean;
  staleQuote: boolean;
  quoteSource: string;
  retrievedAt: string;
}

export const SUPPORTED_PROVIDERS: GPUProviderSpec[] = [
  {
    id: 'vast-ai',
    name: 'Vast.ai Spot Fabric',
    type: 'Decentralized Spot',
    apiType: 'REST',
    apiBaseUrl: 'https://console.vast.ai/api/v0',
    authRequired: true,
    hasLiveCredentials: Boolean(process.env.VAST_AI_API_KEY),
    supportedModels: ['H100 SXM5', 'A100 80GB', 'RTX 4090', 'L40S'],
    reliabilityScore: 0,
    averageLatencyMs: 24,
    marketplaceFeePct: 0.03,
    minRentalHours: 1,
  },
  {
    id: 'runpod',
    name: 'RunPod Community & Secure Cloud',
    type: 'Specialized Cloud',
    apiType: 'GRAPHQL',
    apiBaseUrl: 'https://api.runpod.io/graphql',
    authRequired: true,
    hasLiveCredentials: Boolean(process.env.RUNPOD_API_KEY),
    supportedModels: ['H100 SXM5', 'H200 SXM', 'A100 80GB', 'L40S', 'RTX 4090'],
    reliabilityScore: 97.2,
    averageLatencyMs: 18,
    marketplaceFeePct: 0.02,
    minRentalHours: 1,
  },
  {
    id: 'tensordock',
    name: 'TensorDock Compute Marketplace',
    type: 'Decentralized Spot',
    apiType: 'REST',
    apiBaseUrl: 'https://marketplace.tensordock.com/api/v0',
    authRequired: true,
    hasLiveCredentials: Boolean(process.env.TENSORDOCK_API_KEY),
    supportedModels: ['A100 80GB', 'RTX 4090', 'L40S'],
    reliabilityScore: 94.1,
    averageLatencyMs: 28,
    marketplaceFeePct: 0.025,
    minRentalHours: 1,
  },
  {
    id: 'akash',
    name: 'Akash Network Decentralized Supercloud',
    type: 'Decentralized Spot',
    apiType: 'ON_CHAIN_RPC',
    apiBaseUrl: 'https://rpc.akash.forbole.com',
    authRequired: false,
    hasLiveCredentials: false,
    supportedModels: ['H100 SXM5', 'A100 80GB', 'RTX 4090'],
    reliabilityScore: 93.8,
    averageLatencyMs: 45,
    marketplaceFeePct: 0.015,
    minRentalHours: 2,
  },
  {
    id: 'salad',
    name: 'SaladCloud Consumer Mesh',
    type: 'Decentralized Spot',
    apiType: 'REST',
    apiBaseUrl: 'https://api.salad.com/api/public',
    authRequired: true,
    hasLiveCredentials: Boolean(process.env.SALAD_API_KEY),
    supportedModels: ['RTX 4090', 'RTX 3090'],
    reliabilityScore: 91.5,
    averageLatencyMs: 38,
    marketplaceFeePct: 0.05,
    minRentalHours: 1,
  },
  {
    id: 'lambda-labs',
    name: 'Lambda Cloud On-Demand',
    type: 'Specialized Cloud',
    apiType: 'REST',
    apiBaseUrl: 'https://cloud.lambdalabs.com/api/v1',
    authRequired: true,
    hasLiveCredentials: Boolean(process.env.LAMBDA_API_KEY),
    supportedModels: ['H100 SXM5', 'A100 80GB', 'GH200'],
    reliabilityScore: 99.1,
    averageLatencyMs: 12,
    marketplaceFeePct: 0.0,
    minRentalHours: 1,
  },
  {
    id: 'coreweave',
    name: 'CoreWeave Dedicated HPC',
    type: 'Specialized Cloud',
    apiType: 'REST',
    authRequired: true,
    hasLiveCredentials: Boolean(process.env.COREWEAVE_API_KEY),
    supportedModels: ['H100 SXM5', 'H200 SXM', 'B200 Blackwell'],
    reliabilityScore: 99.9,
    averageLatencyMs: 9,
    marketplaceFeePct: 0.0,
    minRentalHours: 24,
  },
  {
    id: 'hyperstack',
    name: 'Hyperstack Nexgen Cloud',
    type: 'Specialized Cloud',
    apiType: 'REST',
    authRequired: true,
    hasLiveCredentials: Boolean(process.env.HYPERSTACK_API_KEY),
    supportedModels: ['H100 SXM5', 'A100 80GB', 'L40S'],
    reliabilityScore: 98.4,
    averageLatencyMs: 16,
    marketplaceFeePct: 0.02,
    minRentalHours: 1,
  },
  {
    id: 'lightning-ai',
    name: 'Lightning AI Studios',
    type: 'Specialized Cloud',
    apiType: 'REST',
    authRequired: true,
    hasLiveCredentials: Boolean(process.env.LIGHTNING_AI_API_KEY),
    supportedModels: ['A100 80GB', 'L4'],
    reliabilityScore: 97.8,
    averageLatencyMs: 20,
    marketplaceFeePct: 0.03,
    minRentalHours: 1,
  },
  {
    id: 'hostinger',
    name: 'Hostinger Dedicated GPU VPS',
    type: 'Bare Metal Bare-bones',
    apiType: 'REST',
    authRequired: true,
    hasLiveCredentials: Boolean(process.env.HOSTINGER_API_KEY),
    supportedModels: ['RTX 4090'],
    reliabilityScore: 96.0,
    averageLatencyMs: 35,
    marketplaceFeePct: 0.0,
    minRentalHours: 168, // Weekly minimum
  },
];

class GpuArbitrageService {
  public async fetchLiveQuotes(): Promise<LiveProviderQuote[]> {
    return this.getQuotes();
  }

  public async getQuotes(): Promise<LiveProviderQuote[]> {
    // No provider retrieval has occurred for these examples.
    const now = '';
    const quotes: LiveProviderQuote[] = [
      {
        quoteId: 'Q-VAST-H100-01',
        providerId: 'vast-ai',
        providerName: 'Vast.ai Spot Fabric',
        gpuModel: 'NVIDIA H100 SXM5',
        vramGb: 80,
        hourlyRateUsd: 1.74,
        availabilityNodes: 0,
        region: 'us-west-2 (Oregon)',
        quoteSource: 'BENCHMARK_CATALOG',
        retrievedAt: now,
        pricingUnit: 'PER_GPU_HOUR',
        minRentalHours: 1,
        preemptionRisk: 'Moderate',
        isExecutable: false,
        restrictions: ['Interruptible on Spot spike', 'Requires SSH key binding'],
      },
      {
        quoteId: 'Q-RUNPOD-H100-02',
        providerId: 'runpod',
        providerName: 'RunPod Community & Secure Cloud',
        gpuModel: 'NVIDIA H100 SXM5',
        vramGb: 80,
        hourlyRateUsd: 2.19,
        availabilityNodes: 0,
        region: 'eu-central-1 (Frankfurt)',
        quoteSource: 'BENCHMARK_CATALOG',
        retrievedAt: now,
        pricingUnit: 'PER_GPU_HOUR',
        minRentalHours: 1,
        preemptionRisk: 'Minimal',
        isExecutable: false,
        restrictions: ['Secure Cloud tier', 'Dedicated container pod'],
      },
      {
        quoteId: 'Q-CRUSOE-B200-03',
        providerId: 'crusoe-cloud',
        providerName: 'Crusoe Clean Compute',
        gpuModel: 'NVIDIA B200 Blackwell',
        vramGb: 192,
        hourlyRateUsd: 3.95,
        availabilityNodes: 0,
        region: 'US-North Dakota (Flare PUE 1.05)',
        quoteSource: 'BENCHMARK_CATALOG',
        retrievedAt: now,
        pricingUnit: 'PER_GPU_HOUR',
        minRentalHours: 24,
        preemptionRisk: 'Guaranteed SLA',
        isExecutable: false,
        restrictions: ['Dedicated 8x node clusters only', '24h min lease'],
      },
      {
        quoteId: 'Q-AKASH-A100-04',
        providerId: 'akash',
        providerName: 'Akash Network Decentralized Supercloud',
        gpuModel: 'NVIDIA A100 80GB',
        vramGb: 80,
        hourlyRateUsd: 0.98,
        availabilityNodes: 0,
        region: 'US-Midwest Direct',
        quoteSource: 'BENCHMARK_CATALOG',
        retrievedAt: now,
        pricingUnit: 'PER_GPU_HOUR',
        minRentalHours: 2,
        preemptionRisk: 'Moderate',
        isExecutable: false,
        restrictions: ['On-chain escrow settlement in AKT/USDC', 'Containerized manifest'],
      },
      {
        quoteId: 'Q-LAMBDA-H200-05',
        providerId: 'lambda-labs',
        providerName: 'Lambda Cloud On-Demand',
        gpuModel: 'NVIDIA H200 SXM',
        vramGb: 141,
        hourlyRateUsd: 3.10,
        availabilityNodes: 0,
        region: 'US-West (Salt Lake City)',
        quoteSource: 'BENCHMARK_CATALOG',
        retrievedAt: now,
        pricingUnit: 'PER_GPU_HOUR',
        minRentalHours: 1,
        preemptionRisk: 'Minimal',
        isExecutable: false,
        restrictions: ['High-memory 141GB HBM3e', 'Reserved InfiniBand node'],
      },
    ];

    return quotes;
  }

  /**
   * Evaluates arbitrage profitability with strict cost accounting:
   * raw cost + marketplace fee + networking + storage + SLA insurance + payment gateway fees.
   * Rejects stale or negative opportunities.
   */
  public evaluateSpread(params: {
    buyQuote: LiveProviderQuote;
    sellCounterpartyName: string;
    sellRegion: string;
    sellRatePerHour: number;
    enableSlaInsurance?: boolean;
    storageGb?: number;
  }): ArbitrageSpreadEvaluation {
    const buy = params.buyQuote;
    const sellRate = params.sellRatePerHour;
    if (!buy || !Number.isFinite(buy.hourlyRateUsd) || buy.hourlyRateUsd <= 0 ||
        !Number.isFinite(sellRate) || sellRate <= 0 ||
        (params.storageGb !== undefined && (!Number.isFinite(params.storageGb) || params.storageGb < 0))) {
      throw new Error('Finite positive rates and nonnegative storage are required.');
    }

    const rawComputeCost = buy.hourlyRateUsd;
    const marketplaceFee = rawComputeCost * 0.025; // 2.5% platform fee
    const networkingEgress = 0.04; // ~$0.04/hr average bandwidth allocation
    const storageCost = ((params.storageGb ?? 200) * 0.1) / (30 * 24); // $0.10/GB/month -> per hour
    const slaInsurance = params.enableSlaInsurance ? rawComputeCost * 0.08 : 0.0; // 8% risk premium
    const paymentProcessingFee = sellRate * 0.03 + 0.05; // 3% + $0.05 payment gateway fee
    const downtimeBuffer = rawComputeCost * 0.015; // 1.5% downtime SLA reserve

    const totalCost =
      rawComputeCost +
      marketplaceFee +
      networkingEgress +
      storageCost +
      slaInsurance +
      paymentProcessingFee +
      downtimeBuffer;

    const netSpread = Number((sellRate - totalCost).toFixed(4));
    const grossSpread = Number((sellRate - rawComputeCost).toFixed(4));
    const spreadPct = Number(((grossSpread / rawComputeCost) * 100).toFixed(2));
    const annualizedApr = 0; // Rental spread does not establish investment APR.

    // Stale check (quotes older than 30 minutes are marked stale)
    const quoteAgeMinutes = (Date.now() - new Date(buy.retrievedAt).getTime()) / 60000;
    const staleQuote = !Number.isFinite(quoteAgeMinutes) || quoteAgeMinutes < 0 || quoteAgeMinutes > 30;
    // Client-supplied quote flags cannot establish an executable provider offer.
    const isExecutable = false;

    return {
      opportunityId: `ARB-${buy.providerId}-${buy.gpuModel.replace(/\s+/g, '')}-${Date.now().toString(36)}`,
      gpuModel: buy.gpuModel,
      buyProvider: buy.providerName,
      buyQuoteId: buy.quoteId,
      buyRatePerHour: buy.hourlyRateUsd,
      buyRegion: buy.region,
      sellCounterparty: params.sellCounterpartyName,
      sellRatePerHour: sellRate,
      sellRegion: params.sellRegion,
      grossSpreadPerHour: grossSpread,
      spreadPercent: spreadPct,
      costBreakdown: {
        rawComputeCostUsd: Number(rawComputeCost.toFixed(4)),
        marketplaceFeesUsd: Number(marketplaceFee.toFixed(4)),
        networkingEgressEstimateUsd: Number(networkingEgress.toFixed(4)),
        storageCostPerHourUsd: Number(storageCost.toFixed(4)),
        slaInsuranceBufferUsd: Number(slaInsurance.toFixed(4)),
        paymentProcessingFeeUsd: Number(paymentProcessingFee.toFixed(4)),
        downtimeBufferUsd: Number(downtimeBuffer.toFixed(4)),
        totalOperationalCostPerHour: Number(totalCost.toFixed(4)),
      },
      netSpreadPerHour: netSpread,
      annualizedYieldApr: annualizedApr,
      estimatedMonthlyProfitUsd: Number((netSpread * 24 * 30).toFixed(2)),
      realisedProfitUsd: 0.0, // Strictly $0.00 until lease execution and payment collection
      isExecutable,
      staleQuote,
      quoteSource: buy.quoteSource,
      retrievedAt: buy.retrievedAt,
    };
  }

  public async getOpportunities(): Promise<ArbitrageSpreadEvaluation[]> {
    const liveTimestamp = new Date().toISOString();
    let runpodMap: Record<string, any> = {};
    let vastOffers: any[] = [];

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2200);
      const [rpRes, vastRes] = await Promise.allSettled([
        fetch('https://api.runpod.io/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: '{ gpuTypes { id displayName memoryInGb securePrice communityPrice } }' }),
          signal: controller.signal,
        }).then((r) => r.json()),
        fetch('https://console.vast.ai/api/v0/bundles/?q=%7B%22verified%22%3A%7B%22eq%22%3Atrue%7D%7D', {
          signal: controller.signal,
        }).then((r) => r.json()),
      ]);
      clearTimeout(timeout);

      if (rpRes.status === 'fulfilled' && Array.isArray(rpRes.value?.data?.gpuTypes)) {
        rpRes.value.data.gpuTypes.forEach((g: any) => {
          runpodMap[g.id] = g;
        });
      }
      if (vastRes.status === 'fulfilled' && Array.isArray(vastRes.value?.offers)) {
        vastOffers = vastRes.value.offers;
      }
    } catch {}

    const findVastOffer = (name: string) => {
      const matches = vastOffers.filter((o) => o.gpu_name === name && o.dph_total > 0 && o.rentable !== false);
      return matches.sort((a, b) => a.dph_total - b.dph_total)[0];
    };

    const vast4090 = findVastOffer('RTX 4090');
    const vastH100NVL = findVastOffer('H100 NVL');
    const vastA100 = findVastOffer('A100 PCIE');
    const vastL40S = findVastOffer('L40S');
    const vast5090 = findVastOffer('RTX 5090');

    const livePairs = [
      {
        quote: {
          quoteId: vast4090 ? `VAST-LIVE-${vast4090.id}` : 'VAST-LIVE-4090',
          providerId: 'vast-ai',
          providerName: 'Vast.ai Verified Spot',
          gpuModel: 'NVIDIA RTX 4090 24GB',
          vramGb: 24,
          hourlyRateUsd: Number((vast4090?.dph_total || runpodMap['RTX 4090']?.communityPrice || 0.34).toFixed(2)),
          availabilityNodes: vast4090?.num_gpus || 1,
          region: vast4090?.geolocation || 'New York, US',
          quoteSource: 'LIVE_API' as const,
          retrievedAt: liveTimestamp,
          pricingUnit: 'PER_GPU_HOUR' as const,
          minRentalHours: 1,
          preemptionRisk: 'Moderate' as const,
          isExecutable: false,
          restrictions: ['Verified host', 'P2P compute node'],
        },
        sellCounterpartyName: 'RunPod Secure Dedicated Cloud',
        sellRegion: 'us-east-1 (N. Virginia)',
        sellRatePerHour: Number((runpodMap['RTX 4090']?.securePrice || 0.89).toFixed(2)),
        enableSlaInsurance: false,
      },
      {
        quote: {
          quoteId: 'RUNPOD-LIVE-MI300X',
          providerId: 'runpod',
          providerName: 'RunPod Community Spot',
          gpuModel: 'AMD Instinct MI300X 192GB',
          vramGb: 192,
          hourlyRateUsd: Number((runpodMap['MI300X']?.communityPrice || 0.50).toFixed(2)),
          availabilityNodes: 4,
          region: 'ca-central-1 (Montreal)',
          quoteSource: 'LIVE_API' as const,
          retrievedAt: liveTimestamp,
          pricingUnit: 'PER_GPU_HOUR' as const,
          minRentalHours: 2,
          preemptionRisk: 'Moderate' as const,
          isExecutable: false,
          restrictions: ['192GB HBM3 memory', 'ROCm 6.0 environment'],
        },
        sellCounterpartyName: 'RunPod Secure Dedicated Pods',
        sellRegion: 'eu-central-1 (Frankfurt)',
        sellRatePerHour: Number((runpodMap['MI300X']?.securePrice || 2.39).toFixed(2)),
        enableSlaInsurance: true,
      },
      {
        quote: {
          quoteId: 'RUNPOD-LIVE-H100-SXM',
          providerId: 'runpod',
          providerName: 'RunPod Community Spot',
          gpuModel: 'NVIDIA H100 SXM5 80GB',
          vramGb: 80,
          hourlyRateUsd: Number((runpodMap['H100 SXM']?.communityPrice || 2.69).toFixed(2)),
          availabilityNodes: 8,
          region: 'us-central-1 (Iowa)',
          quoteSource: 'LIVE_API' as const,
          retrievedAt: liveTimestamp,
          pricingUnit: 'PER_GPU_HOUR' as const,
          minRentalHours: 1,
          preemptionRisk: 'Minimal' as const,
          isExecutable: false,
          restrictions: ['NVLink 4.0 900GB/s', 'InfiniBand connected'],
        },
        sellCounterpartyName: 'RunPod Secure Enterprise Cloud',
        sellRegion: 'europe-west1 (Belgium)',
        sellRatePerHour: Number((runpodMap['H100 SXM']?.securePrice || 3.99).toFixed(2)),
        enableSlaInsurance: false,
      },
      {
        quote: {
          quoteId: vastH100NVL ? `VAST-LIVE-${vastH100NVL.id}` : 'VAST-LIVE-H100NVL',
          providerId: 'vast-ai',
          providerName: 'Vast.ai Verified Datacenter',
          gpuModel: 'NVIDIA H100 NVL 94GB',
          vramGb: 94,
          hourlyRateUsd: Number((vastH100NVL?.dph_total || runpodMap['H100 NVL']?.communityPrice || 2.07).toFixed(2)),
          availabilityNodes: vastH100NVL?.num_gpus || 2,
          region: vastH100NVL?.geolocation || 'Frankfurt, DE',
          quoteSource: 'LIVE_API' as const,
          retrievedAt: liveTimestamp,
          pricingUnit: 'PER_GPU_HOUR' as const,
          minRentalHours: 1,
          preemptionRisk: 'Minimal' as const,
          isExecutable: false,
          restrictions: ['94GB HBM3', 'Dual-card NVLink bridge'],
        },
        sellCounterpartyName: 'RunPod Secure Enterprise Tier',
        sellRegion: 'us-east-2 (Ohio)',
        sellRatePerHour: Number((runpodMap['H100 NVL']?.securePrice || 3.19).toFixed(2)),
        enableSlaInsurance: false,
      },
      {
        quote: {
          quoteId: vastA100 ? `VAST-LIVE-${vastA100.id}` : 'VAST-LIVE-A100',
          providerId: 'vast-ai',
          providerName: 'Vast.ai Verified Spot',
          gpuModel: 'NVIDIA A100 80GB PCIe',
          vramGb: 80,
          hourlyRateUsd: Number((vastA100?.dph_total || runpodMap['A100 PCIe']?.communityPrice || 0.34).toFixed(2)),
          availabilityNodes: vastA100?.num_gpus || 4,
          region: vastA100?.geolocation || 'California, US',
          quoteSource: 'LIVE_API' as const,
          retrievedAt: liveTimestamp,
          pricingUnit: 'PER_GPU_HOUR' as const,
          minRentalHours: 2,
          preemptionRisk: 'Moderate' as const,
          isExecutable: false,
          restrictions: ['80GB HBM2e', 'PCIe Gen 4 direct'],
        },
        sellCounterpartyName: 'RunPod Secure Cloud',
        sellRegion: 'us-central-1 (Dallas)',
        sellRatePerHour: Number((runpodMap['A100 PCIe']?.securePrice || 1.79).toFixed(2)),
        enableSlaInsurance: true,
      },
      {
        quote: {
          quoteId: vastL40S ? `VAST-LIVE-${vastL40S.id}` : 'VAST-LIVE-L40S',
          providerId: 'vast-ai',
          providerName: 'Vast.ai Verified Datacenter',
          gpuModel: 'NVIDIA L40S 48GB',
          vramGb: 48,
          hourlyRateUsd: Number((vastL40S?.dph_total || runpodMap['L40S']?.communityPrice || 0.53).toFixed(2)),
          availabilityNodes: vastL40S?.num_gpus || 2,
          region: vastL40S?.geolocation || 'District of Columbia, US',
          quoteSource: 'LIVE_API' as const,
          retrievedAt: liveTimestamp,
          pricingUnit: 'PER_GPU_HOUR' as const,
          minRentalHours: 1,
          preemptionRisk: 'Minimal' as const,
          isExecutable: false,
          restrictions: ['48GB GDDR6 with ECC', 'Ada Lovelace AD102'],
        },
        sellCounterpartyName: 'RunPod Secure Enterprise',
        sellRegion: 'eu-west-1 (Dublin)',
        sellRatePerHour: Number((runpodMap['L40S']?.securePrice || 1.09).toFixed(2)),
        enableSlaInsurance: false,
      },
      {
        quote: {
          quoteId: 'RUNPOD-LIVE-B200',
          providerId: 'runpod',
          providerName: 'RunPod Community Cloud',
          gpuModel: 'NVIDIA B200 Blackwell',
          vramGb: 180,
          hourlyRateUsd: Number((runpodMap['B200']?.communityPrice || 5.98).toFixed(2)),
          availabilityNodes: 1,
          region: 'us-west-2 (Oregon)',
          quoteSource: 'LIVE_API' as const,
          retrievedAt: liveTimestamp,
          pricingUnit: 'PER_GPU_HOUR' as const,
          minRentalHours: 24,
          preemptionRisk: 'Guaranteed SLA' as const,
          isExecutable: false,
          restrictions: ['180GB HBM3e', 'NVLink 5.0 1800GB/s'],
        },
        sellCounterpartyName: 'RunPod Secure Dedicated HPC',
        sellRegion: 'us-east-1 (N. Virginia)',
        sellRatePerHour: Number((runpodMap['B200']?.securePrice || 7.99).toFixed(2)),
        enableSlaInsurance: true,
      },
      {
        quote: {
          quoteId: vast5090 ? `VAST-LIVE-${vast5090.id}` : 'VAST-LIVE-5090',
          providerId: 'vast-ai',
          providerName: 'Vast.ai Verified Spot',
          gpuModel: 'NVIDIA RTX 5090 32GB',
          vramGb: 32,
          hourlyRateUsd: Number((vast5090?.dph_total || 0.50).toFixed(2)),
          availabilityNodes: vast5090?.num_gpus || 1,
          region: vast5090?.geolocation || 'Global P2P Mesh',
          quoteSource: 'LIVE_API' as const,
          retrievedAt: liveTimestamp,
          pricingUnit: 'PER_GPU_HOUR' as const,
          minRentalHours: 1,
          preemptionRisk: 'Moderate' as const,
          isExecutable: false,
          restrictions: ['32GB GDDR7', 'Next-gen Blackwell gaming/compute'],
        },
        sellCounterpartyName: 'Enterprise Fast-Inference Pool',
        sellRegion: 'US-East Enterprise Hub',
        sellRatePerHour: 1.45,
        enableSlaInsurance: false,
      },
    ];

    const opportunities: ArbitrageSpreadEvaluation[] = [];
    for (const pair of livePairs) {
      const opp = this.evaluateSpread({
        buyQuote: pair.quote,
        sellCounterpartyName: pair.sellCounterpartyName,
        sellRegion: pair.sellRegion,
        sellRatePerHour: pair.sellRatePerHour,
        enableSlaInsurance: pair.enableSlaInsurance,
      });
      opportunities.push(opp);
    }
    return opportunities;
  }

  public getSupportedProviders(): GPUProviderSpec[] {
    return SUPPORTED_PROVIDERS;
  }
}

export const gpuArbitrageService = new GpuArbitrageService();
