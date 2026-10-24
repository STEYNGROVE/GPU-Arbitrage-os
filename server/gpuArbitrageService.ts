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
    reliabilityScore: 92.4,
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
    hasLiveCredentials: true,
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
    const now = new Date().toISOString();
    const quotes: LiveProviderQuote[] = [
      {
        quoteId: 'Q-VAST-H100-01',
        providerId: 'vast-ai',
        providerName: 'Vast.ai Spot Fabric',
        gpuModel: 'NVIDIA H100 SXM5',
        vramGb: 80,
        hourlyRateUsd: 1.74,
        availabilityNodes: 12,
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
        availabilityNodes: 8,
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
        availabilityNodes: 4,
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
        availabilityNodes: 24,
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
        availabilityNodes: 6,
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

    const rawComputeCost = buy.hourlyRateUsd;
    const marketplaceFee = rawComputeCost * 0.025; // 2.5% platform fee
    const networkingEgress = 0.04; // ~$0.04/hr average bandwidth allocation
    const storageCost = ((params.storageGb || 200) * 0.1) / (30 * 24); // $0.10/GB/month -> per hour
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
    const annualizedApr = Number(((netSpread / rawComputeCost) * 24 * 365 * 100).toFixed(1));

    // Stale check (quotes older than 30 minutes are marked stale)
    const quoteAgeMinutes = (Date.now() - new Date(buy.retrievedAt).getTime()) / 60000;
    const staleQuote = quoteAgeMinutes > 30;
    const isExecutable = netSpread > 0 && !staleQuote && buy.isExecutable;

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

  public getSupportedProviders(): GPUProviderSpec[] {
    return SUPPORTED_PROVIDERS;
  }
}

export const gpuArbitrageService = new GpuArbitrageService();
