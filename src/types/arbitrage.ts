export interface GPUHardware {
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

export interface Provider {
  id: string;
  name: string;
  type: 'Decentralized Spot' | 'Specialized Cloud' | 'Hyperscaler' | 'Green Datacenter';
  region: string;
  datacenterPUE: number;
  energySource: 'Hydro' | 'Geothermal' | 'Nuclear / Clean' | 'Grid Mix';
  preemptionRatePerHour: number;
  apiLatencyMs: number;
  reliabilityScore: number; // 0 - 100
}

export interface ArbitrageOpportunity {
  id: string;
  gpuId: string;
  gpuName: string;
  architecture: string;
  vram: string;
  buyProvider: string;
  buyRegion: string;
  buyPricePerHour: number;
  buyAvailabilityNodes: number;
  sellCounterparty: string;
  sellRegion: string;
  sellPricePerHour: number;
  spreadPerHour: number;
  spreadPercent: number;
  annualizedYieldApr: number;
  latencyDeltaMs: number;
  preemptionRisk: 'Minimal' | 'Moderate' | 'Guaranteed SLA';
  slaInsuranceCostPerHour: number;
  netSpreadPerHour: number;
  contractType: 'On-Demand Spot Arb' | '7-Day Reserve Relay' | '30-Day Cluster Resell' | 'Fractional Slice Swap';
  recommendedNodes: number;
}

export interface ActiveContract {
  id: string;
  opportunityId: string;
  gpuName: string;
  nodeCount: number;
  totalGpus: number;
  buyProvider: string;
  buyRegion: string;
  buyRate: number;
  sellCounterparty: string;
  sellRegion: string;
  sellRate: number;
  netSpreadPerHour: number;
  totalAccruedPnL: number;
  startTime: number;
  durationHours: number;
  status: 'ACTIVE_ROUTING' | 'HEDGING_FAILOVER' | 'COMPLETED' | 'PAUSED';
  uptimeSla: number;
  autoRenew: boolean;
  preemptionProtection: boolean;
  datacenterPUE: number;
}

export interface FleetWorker {
  id: string;
  workerNumber: number;
  fleetType: 'autonomous_discovery_fleet' | 'yield_optimizer_fleet';
  target: string;
  currentTask: string;
  status: 'ACTIVE' | 'PROCESSING' | 'THROTTLED' | 'SYNCING';
  nodesScannedPerSec: number;
  latencyMs: number;
  memoryMb: number;
  lastHeartbeat: string;
}

export interface DatabaseRelation {
  schemaName: string;
  relationName: string;
  category: 'Market Microstructure' | 'Hardware Registry' | 'Orderbook Escrows' | 'Cross-Cloud Latencies' | 'Fleet Telemetry';
  recordsCount: number;
  tableSizeBytes: string;
  indexStatus: 'OPTIMAL' | 'REINDEXING' | 'SYNCHRONIZED';
  queryLatencyMs: number;
  writeThroughputPerSec: number;
}

export interface ExecutionLog {
  id: string;
  timestamp: string;
  level: 'SPREAD_ALERT' | 'ORDER_EXEC' | 'FLEET_SYNC' | 'SYSTEM_INFO' | 'PREEMPTION_HEDGE';
  service: string;
  message: string;
  latencyMs: number;
  metadata?: Record<string, string | number>;
}

export interface BinanceAccount {
  isConnected: boolean;
  ownerEmail: string;
  ownerName: string;
  binanceUid: string;
  subaccountName: string;
  kycStatus: string;
  whitelistedIp: string;
  outboundEgressIp?: string;
  recommendedWhitelistIps?: string[];
  accountType: 'VIP 3 Institutional' | 'Corporate Master' | 'Spot & Cross-Margin' | string;
  apiKeyMasked: string;
  apiPermissions: string[];
  pingLatencyMs: number;
  usdtBalance: number;
  usdcBalance: number;
  btcBalance: number;
  ethBalance: number;
  totalEquityUsd: number;
  availableMarginUsd: number;
  autoSweepProfits: boolean;
  sweepThresholdUsd: number;
  vipTier: string;
  makerFeeRate: number;
  takerFeeRate: number;
  verifiedDepositAddress?: string;
  verifiedTronAddress?: string;
  connectionStatus?: string;
  isLiveApiKey?: boolean;
  isSimulated?: boolean;
  notes?: string;
  lastSyncAt?: string;
}

export interface DePINToken {
  symbol: string;
  name: string;
  spotPriceUsd: number;
  change24h: number;
  binanceVolume24h: string;
  impliedComputeGpu: string;
  futuresHedgingPair: string;
  openInterestUsd: string;
}

export interface BinanceHedgePosition {
  id: string;
  pair: string;
  side: 'SHORT' | 'LONG';
  sizeTokens: number;
  sizeUsd: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  hedgeRatio: number;
  linkedContractId: string;
  purpose: string;
}

export interface BinanceTransfer {
  id: string;
  timestamp: string;
  type: 'PROFIT_SWEEP' | 'MARGIN_COLLATERAL' | 'HEDGE_PAYOUT' | 'ESCROW_SETTLEMENT' | 'DIRECT_DEPOSIT' | 'WITHDRAWAL';
  asset: string;
  amount: number;
  txHash?: string;
  status: 'CONFIRMED' | 'SETTLING' | 'PENDING' | 'BLOCKED';
  network?: string;
  destinationAddress?: string;
  blockExplorerUrl?: string;
  confirmations?: string;
  providerRef?: string;
  isSimulated?: boolean;
}

export interface ArbitrageOrderRequest {
  opportunityId: string;
  gpuName: string;
  nodeCount: number;
  buyProvider: string;
  sellCounterparty: string;
  buyRate: number;
  sellRate: number;
  durationHours: number;
  enableSlaInsurance: boolean;
  enableAutoFailover: boolean;
  fundingSource?: 'BINANCE_MARGIN' | 'INTERNAL_ESCROW';
}
