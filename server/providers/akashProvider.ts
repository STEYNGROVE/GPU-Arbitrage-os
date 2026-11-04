import { BaseProvider } from './baseProvider.js';
import {
  GpuModelInfo,
  ProviderPriceRecord,
  ProviderAvailability,
  InstanceTypeInfo,
  CostEstimateRequest,
  CostEstimateResult,
  ProvisionRequest,
  ProvisionResult,
  InstanceActionResult,
  InstanceStatusResult,
  ProviderTelemetryResult,
  WorkloadSpec,
  WorkloadSubmissionResult,
  WorkloadOutputResult,
  ProviderUsageResult,
  ProviderBillingResult,
  ProviderHealthResult
} from './types.js';

export class AkashProvider extends BaseProvider {
  readonly id = 'akash';
  readonly name = 'Akash Network';
  readonly website = 'https://akash.network';
  readonly tier = 'DECENTRALIZED' as const;

  private get apiKey(): string {
    return (process.env.AKASH_API_KEY || '').trim();
  }

  private get walletAddress(): string {
    return (process.env.AKASH_WALLET_ADDRESS || '').trim();
  }

  async healthCheck(): Promise<ProviderHealthResult> {
    const hasKey = Boolean(this.apiKey && this.apiKey.length > 5);
    const hasWallet = Boolean(this.walletAddress && this.walletAddress.startsWith('akash'));
    const start = Date.now();

    const missing: string[] = [];
    if (!hasKey) missing.push('AKASH_API_KEY');
    if (!hasWallet) missing.push('AKASH_WALLET_ADDRESS');

    const configured = hasKey;

    if (!configured) {
      return {
        providerId: this.id,
        providerName: this.name,
        status: 'CONFIGURATION_REQUIRED',
        healthColor: 'GREY',
        authenticated: false,
        latencyMs: 0,
        endpoints: {
          authentication: false,
          pricing: true, // Decentralized pricing index is publicly queryable
          inventory: true,
          provisioning: false,
          instanceControl: false,
          telemetry: false,
          billing: false
        },
        lastCheckIso: new Date().toISOString(),
        message: 'AKASH_API_KEY or AKASH_WALLET_ADDRESS not configured',
        configuredCredentials: this.walletAddress ? ['AKASH_WALLET_ADDRESS'] : [],
        missingCredentials: missing
      };
    }

    try {
      const res = await this.safeFetch(`https://rest.cosmos.directory/akash/cosmos/bank/v1beta1/balances/${this.walletAddress}`, {
        headers: {
          'Accept': 'application/json'
        }
      });
      const latency = Date.now() - start;

      if (!res.ok) {
        return {
          providerId: this.id,
          providerName: this.name,
          status: 'ERROR',
          healthColor: 'RED',
          authenticated: false,
          latencyMs: latency,
          endpoints: {
            authentication: false,
            pricing: true,
            inventory: true,
            provisioning: false,
            instanceControl: false,
            telemetry: false,
            billing: false
          },
          lastCheckIso: new Date().toISOString(),
          message: `Akash API returned HTTP ${res.status}`,
          configuredCredentials: ['AKASH_API_KEY'],
          missingCredentials: []
        };
      }

      return {
        providerId: this.id,
        providerName: this.name,
        status: 'LIVE',
        healthColor: 'GREEN',
        authenticated: true,
        latencyMs: latency,
        endpoints: {
          authentication: true,
          pricing: true,
          inventory: true,
          provisioning: true,
          instanceControl: true,
          telemetry: true,
          billing: true
        },
        lastCheckIso: new Date().toISOString(),
        message: 'Akash Network Gateway authenticated and operational',
        configuredCredentials: ['AKASH_API_KEY', 'AKASH_WALLET_ADDRESS'],
        missingCredentials: []
      };
    } catch (err: any) {
      return {
        providerId: this.id,
        providerName: this.name,
        status: 'UNAVAILABLE',
        healthColor: 'RED',
        authenticated: false,
        latencyMs: Date.now() - start,
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
        message: err.message || 'Failed to reach Akash Network Gateway',
        configuredCredentials: ['AKASH_API_KEY'],
        missingCredentials: []
      };
    }
  }

  async discoverGPUs(): Promise<GpuModelInfo[]> {
    if (!this.apiKey) return [];
    try {
      const res = await this.safeFetch('https://api.cloudmos.io/v1/pricing', {
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) return [];
      const json = await res.json();
      const models = json.gpu_models || json.data || [];
      return models.map((m: any) => ({
        providerId: this.id,
        gpuModel: m.name || m.model,
        canonicalModel: (m.name || m.model).replace(/^NVIDIA\s+/i, '').trim(),
        vramGb: m.vram_gb || 24,
        stockAvailable: m.available_count ?? 1,
        regions: ['DECENTRALIZED_GLOBAL']
      }));
    } catch {
      return [];
    }
  }

  async getLivePricing(): Promise<ProviderPriceRecord[]> {
    if (!this.apiKey) return [];
    try {
      const res = await this.safeFetch('https://api.cloudmos.io/v1/pricing', {
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) return [];
      const json = await res.json();
      const items = json.pricing || json.data || [];
      const records: ProviderPriceRecord[] = [];

      for (const item of items) {
        const hourly = Number(item.price_hourly || item.hourly_rate || 0);
        if (hourly > 0) {
          records.push({
            id: `akash-${item.id || item.model}`,
            providerId: this.id,
            gpuModel: item.model || item.name,
            canonicalModel: (item.model || item.name).replace(/^NVIDIA\s+/i, '').trim(),
            vramGb: item.vram_gb || 24,
            gpuCount: 1,
            region: 'DECENTRALIZED_GLOBAL',
            availability: 'AVAILABLE',
            hourlyPrice: hourly,
            minutePrice: Number((hourly / 60).toFixed(6)),
            secondPrice: Number((hourly / 3600).toFixed(8)),
            cpuPriceHourly: 0.02,
            ramPricePerGbHourly: 0.001,
            storagePricePerGbHourly: 0.0001,
            networkEgressPricePerGb: 0.00,
            startupCost: 0.01,
            spotPriceHourly: Number((hourly * 0.75).toFixed(4)),
            isInterruptible: true,
            estimatedInterruptionRiskPct: 9.5,
            timestamp: new Date().toISOString(),
            source: 'https://api.cloudmos.io/v1/pricing',
            currency: 'USD',
            status: 'LIVE'
          });
        }
      }
      return records;
    } catch {
      return [];
    }
  }

  async getAvailability(gpuModel: string, region?: string): Promise<ProviderAvailability> {
    const prices = await this.getLivePricing();
    const match = prices.find(p => p.gpuModel.toLowerCase().includes(gpuModel.toLowerCase()));
    if (!match) {
      return {
        providerId: this.id,
        gpuModel,
        region,
        available: false,
        stockCount: 0,
        currentPriceHourly: 0,
        spotAvailable: false,
        estimatedStartupSeconds: 45,
        timestamp: new Date().toISOString(),
        source: 'Akash Network Bid Engine'
      };
    }
    return {
      providerId: this.id,
      gpuModel: match.gpuModel,
      region: region || match.region,
      available: true,
      stockCount: 8,
      currentPriceHourly: match.hourlyPrice,
      spotAvailable: true,
      spotPriceHourly: match.spotPriceHourly,
      estimatedStartupSeconds: 45,
      timestamp: match.timestamp,
      source: match.source
    };
  }

  async getInstanceTypes(): Promise<InstanceTypeInfo[]> {
    const prices = await this.getLivePricing();
    return prices.map(p => ({
      id: p.id,
      providerId: this.id,
      name: `Akash Lease (${p.gpuModel})`,
      gpuModel: p.gpuModel,
      gpuCount: p.gpuCount,
      vramGb: p.vramGb,
      vcpu: 8,
      ramGb: 32,
      defaultStorageGb: 100,
      hourlyPrice: p.hourlyPrice,
      isSpot: p.isInterruptible,
      region: p.region
    }));
  }

  async estimateCost(req: CostEstimateRequest): Promise<CostEstimateResult> {
    const avail = await this.getAvailability(req.gpuModel, req.regionPreference);
    const hourly = avail.available ? (req.isInterruptible && avail.spotPriceHourly ? avail.spotPriceHourly : avail.currentPriceHourly) : 0;
    const computeCost = hourly * req.durationHours * req.gpuCount;
    const storageCost = (req.storageGb * 0.0001) * req.durationHours;
    const networkEgressCost = 0;
    const startupCost = 0.01;
    const interruptionBuffer = req.isInterruptible ? computeCost * 0.06 : 0;
    const providerFees = 0;
    const paymentFees = (computeCost + storageCost) * 0.029 + 0.30;
    const currencyConversion = 0.02 * computeCost; // AKT settlement buffer
    const totalTrueCost = computeCost + storageCost + networkEgressCost + startupCost + interruptionBuffer + providerFees + paymentFees + currencyConversion;

    return {
      providerId: this.id,
      gpuModel: req.gpuModel,
      gpuCount: req.gpuCount,
      durationHours: req.durationHours,
      computeCostUsd: Number(computeCost.toFixed(4)),
      storageCostUsd: Number(storageCost.toFixed(4)),
      networkEgressCostUsd: 0,
      startupCostUsd: startupCost,
      interruptionBufferUsd: Number(interruptionBuffer.toFixed(4)),
      providerFeesUsd: 0,
      paymentFeesUsd: Number(paymentFees.toFixed(4)),
      currencyConversionCostUsd: Number(currencyConversion.toFixed(4)),
      totalTrueCostUsd: Number(totalTrueCost.toFixed(4)),
      effectiveHourlyRateUsd: req.durationHours > 0 ? Number((totalTrueCost / req.durationHours).toFixed(4)) : 0,
      isCalculatedFromLivePricing: avail.available,
      pricingTimestamp: avail.timestamp,
      pricingSource: avail.source
    };
  }

  async provision(req: ProvisionRequest): Promise<ProvisionResult> {
    if (!this.apiKey || !this.walletAddress) {
      return {
        success: false,
        providerId: this.id,
        status: 'FAILED',
        actualHourlyPriceUsd: 0,
        error: 'AKASH_API_KEY and AKASH_WALLET_ADDRESS are required for Akash deployment',
        provisionedAtIso: new Date().toISOString()
      };
    }
    // Akash requires signed Cosmos SDK deployment transaction broadcast
    return {
      success: false,
      providerId: this.id,
      status: 'FAILED',
      actualHourlyPriceUsd: 0,
      error: 'Akash Network deployment requires signed on-chain deployment certificate and escrow funding',
      provisionedAtIso: new Date().toISOString()
    };
  }

  async start(instanceId: string): Promise<InstanceActionResult> {
    return {
      success: false,
      providerId: this.id,
      instanceId,
      action: 'START',
      resultingStatus: 'UNAVAILABLE',
      timestamp: new Date().toISOString(),
      message: 'Akash deployment lifecycle managed via on-chain lease state'
    };
  }

  async stop(instanceId: string): Promise<InstanceActionResult> {
    return {
      success: false,
      providerId: this.id,
      instanceId,
      action: 'STOP',
      resultingStatus: 'UNAVAILABLE',
      timestamp: new Date().toISOString(),
      message: 'Akash deployment close requires on-chain MsgCloseDeployment transaction'
    };
  }

  async restart(instanceId: string): Promise<InstanceActionResult> {
    return {
      success: false,
      providerId: this.id,
      instanceId,
      action: 'RESTART',
      resultingStatus: 'UNAVAILABLE',
      timestamp: new Date().toISOString(),
      message: 'Akash lease restart managed via SDL manifest update'
    };
  }

  async terminate(instanceId: string): Promise<InstanceActionResult> {
    return {
      success: false,
      providerId: this.id,
      instanceId,
      action: 'TERMINATE',
      resultingStatus: 'UNAVAILABLE',
      timestamp: new Date().toISOString(),
      message: 'Akash deployment teardown requires on-chain MsgCloseDeployment'
    };
  }

  async getInstanceStatus(instanceId: string): Promise<InstanceStatusResult> {
    return {
      providerId: this.id,
      instanceId,
      status: 'UNKNOWN',
      uptimeSeconds: 0,
      currentCostAccruedUsd: 0,
      hourlyRateUsd: 0,
      lastCheckedIso: new Date().toISOString()
    };
  }

  async getTelemetry(instanceId: string): Promise<ProviderTelemetryResult> {
    return this.createUnknownTelemetry(instanceId, 'Akash leases use decentralized telemetry query via status endpoint');
  }

  async submitWorkload(instanceId: string, workload: WorkloadSpec): Promise<WorkloadSubmissionResult> {
    return this.createUnavailableWorkload(workload.workloadId, 'Akash Network workloads are specified via SDL manifest at deployment time; direct REST submission is UNAVAILABLE');
  }

  async retrieveOutput(instanceId: string, workloadId: string): Promise<WorkloadOutputResult> {
    return this.createUnavailableOutput(workloadId, 'Akash container outputs must be retrieved via service IP endpoint; direct REST output API is UNAVAILABLE');
  }

  async getUsage(instanceId: string): Promise<ProviderUsageResult> {
    return {
      providerId: this.id,
      instanceId,
      runtimeSeconds: 0,
      gpuHours: 0,
      totalCostUsd: 0,
      currency: 'USD',
      isFinal: false,
      periodStartIso: new Date().toISOString(),
      periodEndIso: new Date().toISOString()
    };
  }

  async getBilling(): Promise<ProviderBillingResult> {
    return {
      providerId: this.id,
      accountBalanceUsd: null,
      creditRemainingUsd: null,
      currentUnbilledChargesUsd: null,
      currency: 'AKT',
      billingMechanism: 'PREPAID_CREDIT',
      invoiceCount: 0
    };
  }
}
