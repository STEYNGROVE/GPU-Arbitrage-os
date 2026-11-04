/**
 * UNIFIED GPU PROVIDER ADAPTER ARCHITECTURE
 * 
 * Standardized interface for all 10 GPU providers:
 * 1. Vast.ai
 * 2. RunPod
 * 3. TensorDock
 * 4. Akash
 * 5. Salad
 * 6. Lightning AI
 * 7. Hyperstack
 * 8. CoreWeave
 * 9. Lambda
 * 10. Hostinger GPU
 * 
 * Strict Reality Rules:
 * - Providers are NOT marked "LIVE" unless their API has authenticated AND returned real valid data.
 * - No simulated provider capacity, fake prices, or fake telemetry.
 * - If data is missing or unauthenticated, return DATA_UNAVAILABLE / UNKNOWN / CONFIGURATION_REQUIRED.
 */

export type ProviderId =
  | 'vast_ai'
  | 'runpod'
  | 'tensordock'
  | 'akash'
  | 'salad'
  | 'lightning_ai'
  | 'hyperstack'
  | 'coreweave'
  | 'lambda'
  | 'hostinger';

export type ProviderStatus =
  | 'LIVE'
  | 'AUTHENTICATED'
  | 'PARTIAL'
  | 'DISCOVERY_ONLY'
  | 'UNAVAILABLE'
  | 'FAILED'
  | 'UNVERIFIED'
  | 'CONFIGURATION_REQUIRED'
  | 'ERROR';

export type HealthColor = 'GREEN' | 'YELLOW' | 'RED' | 'GREY';

export type ProviderFinancialState =
  | 'NOT_FUNDED'
  | 'FUNDED'
  | 'INSUFFICIENT_BALANCE'
  | 'CREDIT_AVAILABLE'
  | 'PAY_AS_YOU_GO'
  | 'PAYMENT_REQUIRED'
  | 'UNKNOWN'
  | 'FUNDING_STATUS_UNKNOWN';

export type ProviderExecutionState =
  | 'BLOCKED'
  | 'WAITING_FOR_FUNDING'
  | 'EXECUTABLE'
  | 'CUSTOMER_FUNDED_ONLY'
  | 'OWNER_FUNDED_ONLY'
  | 'UNAVAILABLE';

export type GpuExecutionFeasibility =
  | 'AVAILABLE_GPU'
  | 'PURCHASABLE_GPU'
  | 'EXECUTABLE_GPU';

export interface CustomerFundedJobEscrow {
  jobId: string;
  demandOrderId: string;
  customerPaymentId: string;
  amountReceived: number;
  currency: string;
  providerBudget: number;
  maxProviderSpend: number;
  expectedProfit: number;
  maxLoss: number;
  paymentFees: number;
  reservedAmount: number;
  actualProviderCost: number | null;
  refundLiability: number;
  state: 'PAYMENT_RECEIVED' | 'FUNDS_RESERVED_FOR_JOB' | 'WAITING_FOR_FUNDING' | 'EXECUTION_BLOCKED' | 'EXECUTING' | 'COMPLETED' | 'SETTLED' | 'REFUNDED';
  providerId: ProviderId;
  createdAt: string;
  updatedAt: string;
  executionEvidenceHash?: string;
}

export interface ZeroFundedProviderStatus {
  providerId: ProviderId;
  providerName: string;
  authStatus: ProviderStatus;
  fundingStatus: ProviderFinancialState;
  executionStatus: ProviderExecutionState;
  billingMechanism: 'PREPAID_CREDIT' | 'POSTPAID_CARD' | 'HYBRID' | 'ON_DEMAND' | 'UNKNOWN';
  verifiedBalanceDisplay: string;
  verifiedBalanceUsd: number | null;
  genuineCreditsDetected: boolean;
  creditDetails?: {
    promotionalCreditUsd?: number;
    freeTrialCreditUsd?: number;
    grantCreditUsd?: number;
    description?: string;
  };
  requiresPrepaidBalance: boolean;
  allowsCustomerFundedExecution: boolean;
  allowsPayAsYouGo: boolean;
  minDepositUsd: number;
  canExecuteWithoutOperatorCapital: boolean;
  lastCheckedIso: string;
  message: string;
}

export interface ProviderHealthResult {
  providerId: ProviderId;
  providerName: string;
  status: ProviderStatus;
  healthColor: HealthColor;
  authenticated: boolean;
  productionExecutionEligible?: boolean;
  latencyMs: number;
  endpoints: {
    authentication: boolean;
    pricing: boolean;
    inventory: boolean;
    provisioning: boolean;
    instanceControl: boolean;
    workloadExecution?: boolean;
    telemetry: boolean;
    billing: boolean;
    outputRetrieval?: boolean;
  };
  lastCheckIso: string;
  message: string;
  configuredCredentials: string[];
  missingCredentials: string[];
}

export interface GpuModelInfo {
  providerId: ProviderId;
  gpuModel: string;
  canonicalModel: string;
  vramGb: number;
  architecture?: string;
  cudaCapability?: string;
  memoryBandwidthGbps?: number;
  fp16Tflops?: number;
  bf16Tflops?: number;
  fp32Tflops?: number;
  tensorTflops?: number;
  interconnect?: string; // PCIe, SXM4, SXM5, NVLink
  stockAvailable: number;
  regions: string[];
}

export interface ProviderPriceRecord {
  id: string;
  providerId: ProviderId;
  gpuModel: string;
  canonicalModel: string;
  vramGb: number;
  gpuCount: number;
  region: string;
  availability: 'AVAILABLE' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN';
  hourlyPrice: number;
  minutePrice?: number;
  secondPrice?: number;
  cpuPriceHourly: number;
  ramPricePerGbHourly: number;
  storagePricePerGbHourly: number;
  networkEgressPricePerGb: number;
  startupCost: number;
  spotPriceHourly?: number;
  isInterruptible: boolean;
  estimatedInterruptionRiskPct: number;
  timestamp: string; // UTC ISO-8601
  source: string; // Real Provider API Endpoint
  currency: string;
  status: 'LIVE' | 'STALE' | 'UNAVAILABLE';
  rawReference?: Record<string, unknown>;
}

export interface ProviderAvailability {
  providerId: ProviderId;
  gpuModel: string;
  region?: string;
  available: boolean;
  stockCount: number;
  currentPriceHourly: number;
  spotAvailable: boolean;
  spotPriceHourly?: number;
  estimatedStartupSeconds: number;
  timestamp: string;
  source: string;
}

export interface InstanceTypeInfo {
  id: string;
  providerId: ProviderId;
  name: string;
  gpuModel: string;
  gpuCount: number;
  vramGb: number;
  vcpu: number;
  ramGb: number;
  defaultStorageGb: number;
  hourlyPrice: number;
  isSpot: boolean;
  region: string;
}

export interface CostEstimateRequest {
  gpuModel: string;
  gpuCount: number;
  durationHours: number;
  storageGb: number;
  estimatedEgressGb: number;
  isInterruptible: boolean;
  regionPreference?: string;
}

export interface CostEstimateResult {
  providerId: ProviderId;
  gpuModel: string;
  gpuCount: number;
  durationHours: number;
  computeCostUsd: number;
  storageCostUsd: number;
  networkEgressCostUsd: number;
  startupCostUsd: number;
  interruptionBufferUsd: number;
  providerFeesUsd: number;
  paymentFeesUsd: number;
  currencyConversionCostUsd: number;
  totalTrueCostUsd: number;
  effectiveHourlyRateUsd: number;
  isCalculatedFromLivePricing: boolean;
  pricingTimestamp: string;
  pricingSource: string;
}

export interface ProvisionRequest {
  idempotencyKey: string;
  gpuModel: string;
  gpuCount: number;
  region?: string;
  isInterruptible?: boolean;
  maxHourlyPriceUsd: number;
  workloadType: string;
  customerRef: string;
  dockerImage?: string;
  command?: string;
  environmentVariables?: Record<string, string>;
  diskSizeGb?: number;
  sshPublicKey?: string;
}

export interface ProvisionResult {
  success: boolean;
  providerId: ProviderId;
  instanceId?: string;
  status: 'PROVISIONING' | 'RUNNING' | 'FAILED' | 'REJECTED';
  actualHourlyPriceUsd: number;
  ipAddress?: string;
  sshPort?: number;
  sshUser?: string;
  error?: string;
  rawResponse?: Record<string, unknown>;
  provisionedAtIso: string;
}

export interface InstanceActionResult {
  success: boolean;
  providerId: ProviderId;
  instanceId: string;
  action: 'START' | 'STOP' | 'RESTART' | 'TERMINATE';
  resultingStatus: string;
  timestamp: string;
  message?: string;
  rawResponse?: Record<string, unknown>;
}

export interface InstanceStatusResult {
  providerId: ProviderId;
  instanceId: string;
  status: 'PROVISIONING' | 'RUNNING' | 'STOPPED' | 'TERMINATED' | 'FAILED' | 'UNKNOWN';
  ipAddress?: string;
  uptimeSeconds: number;
  currentCostAccruedUsd: number;
  hourlyRateUsd: number;
  lastCheckedIso: string;
  rawStatus?: Record<string, unknown>;
}

export interface ProviderTelemetryResult {
  providerId: ProviderId;
  instanceId: string;
  timestamp: string;
  isVerified: boolean;
  source: 'PROVIDER_API' | 'INSTANCE_AGENT' | 'UNKNOWN';
  gpuUtilizationPct: number | null;
  gpuTemperatureC: number | null;
  vramUsedGb: number | null;
  vramTotalGb: number | null;
  powerWatts: number | null;
  cpuUtilizationPct: number | null;
  ramUsedGb: number | null;
  diskUsedGb: number | null;
  networkInMbps: number | null;
  networkOutMbps: number | null;
  accruedCostUsd: number | null;
  errorCount: number;
  rawTelemetry?: Record<string, unknown>;
}

export interface WorkloadSpec {
  workloadId: string;
  workloadCategory: string;
  dockerImage: string;
  command: string[];
  entrypoint?: string[];
  environment?: Record<string, string>;
  inputArtifactUrls?: string[];
  expectedOutputPaths?: string[];
  timeoutSeconds?: number;
}

export interface WorkloadSubmissionResult {
  success: boolean;
  workloadId: string;
  providerId: ProviderId;
  instanceId?: string;
  status: 'SUBMITTED' | 'QUEUED' | 'RUNNING' | 'UNAVAILABLE' | 'REJECTED' | 'FAILED';
  submissionHash?: string;
  submittedAtIso: string;
  error?: string;
}

export interface WorkloadOutputResult {
  workloadId: string;
  instanceId?: string;
  providerId: ProviderId;
  status: 'COMPLETED' | 'RUNNING' | 'UNAVAILABLE' | 'FAILED' | 'UNKNOWN';
  outputArtifactUrls: string[];
  stdoutExcerpt?: string;
  stderrExcerpt?: string;
  exitCode?: number;
  executionDurationSeconds?: number;
  inputHash?: string;
  outputHash?: string;
  completedAtIso?: string;
  error?: string;
}

export interface ProviderUsageResult {
  providerId: ProviderId;
  instanceId: string;
  runtimeSeconds: number;
  gpuHours: number;
  totalCostUsd: number;
  currency: string;
  isFinal: boolean;
  invoiceLineItemId?: string;
  periodStartIso: string;
  periodEndIso: string;
}

export interface ProviderBillingResult {
  providerId: ProviderId;
  accountBalanceUsd: number | null;
  creditRemainingUsd: number | null;
  currentUnbilledChargesUsd: number | null;
  currency: string;
  billingMechanism: 'PREPAID_CREDIT' | 'POSTPAID_CARD' | 'HYBRID' | 'ON_DEMAND';
  invoiceCount: number;
  lastInvoiceAmountUsd?: number;
  lastInvoiceDateIso?: string;
  rawBillingInfo?: Record<string, unknown>;
}

/**
 * MANDATORY UNIFIED GPU PROVIDER INTERFACE
 * Every one of the 10 providers must implement this exact interface.
 */
export interface GPUProvider {
  readonly id: ProviderId;
  readonly name: string;
  readonly website: string;
  readonly tier: 'MARKETPLACE' | 'DECENTRALIZED' | 'DISTRIBUTED_EDGE' | 'NEOCLOUD' | 'ENTERPRISE_HYPERSCALER';

  /** 1. Discover all GPUs offered by this provider */
  discoverGPUs(): Promise<GpuModelInfo[]>;

  /** 2. Real-time live pricing collector */
  getLivePricing(): Promise<ProviderPriceRecord[]>;

  /** 3. Check specific availability */
  getAvailability(gpuModel: string, region?: string): Promise<ProviderAvailability>;

  /** 4. Retrieve hardware instance types */
  getInstanceTypes(): Promise<InstanceTypeInfo[]>;

  /** 5. Estimate comprehensive true cost */
  estimateCost(req: CostEstimateRequest): Promise<CostEstimateResult>;

  /** 6. Provision hardware instance */
  provision(req: ProvisionRequest): Promise<ProvisionResult>;

  /** 7. Start stopped instance */
  start(instanceId: string): Promise<InstanceActionResult>;

  /** 8. Stop running instance */
  stop(instanceId: string): Promise<InstanceActionResult>;

  /** 9. Restart instance */
  restart(instanceId: string): Promise<InstanceActionResult>;

  /** 10. Terminate instance completely */
  terminate(instanceId: string): Promise<InstanceActionResult>;

  /** 11. Get current instance status */
  getInstanceStatus(instanceId: string): Promise<InstanceStatusResult>;

  /** 12. Retrieve actual hardware telemetry */
  getTelemetry(instanceId: string): Promise<ProviderTelemetryResult>;

  /** 13. Submit compute workload */
  submitWorkload(instanceId: string, workload: WorkloadSpec): Promise<WorkloadSubmissionResult>;

  /** 14. Retrieve workload output */
  retrieveOutput(instanceId: string, workloadId: string): Promise<WorkloadOutputResult>;

  /** 15. Retrieve instance usage & billing accrual */
  getUsage(instanceId: string): Promise<ProviderUsageResult>;

  /** 16. Retrieve account-level billing and balances */
  getBilling(): Promise<ProviderBillingResult>;

  /** 17. Automated health check and credential verification */
  healthCheck(): Promise<ProviderHealthResult>;
}
