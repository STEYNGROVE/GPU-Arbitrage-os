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

export class LambdaProvider extends BaseProvider {
  readonly id = 'lambda';
  readonly name = 'Lambda Cloud';
  readonly website = 'https://lambdalabs.com';
  readonly tier = 'NEOCLOUD' as const;

  private get apiKey(): string {
    return (process.env.LAMBDA_API_KEY || '').trim();
  }

  async healthCheck(): Promise<ProviderHealthResult> {
    const configured = Boolean(this.apiKey && this.apiKey.length > 5);
    const start = Date.now();
    const missing = configured ? [] : ['LAMBDA_API_KEY'];

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
          pricing: true,
          inventory: true,
          provisioning: false,
          instanceControl: false,
          telemetry: false,
          billing: false
        },
        lastCheckIso: new Date().toISOString(),
        message: 'LAMBDA_API_KEY is not configured',
        configuredCredentials: [],
        missingCredentials: missing
      };
    }

    try {
      const res = await this.safeFetch('https://cloud.lambdalabs.com/api/v1/instance-types', {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
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
            pricing: false,
            inventory: false,
            provisioning: false,
            instanceControl: false,
            telemetry: false,
            billing: false
          },
          lastCheckIso: new Date().toISOString(),
          message: `Lambda Cloud API returned HTTP ${res.status}`,
          configuredCredentials: ['LAMBDA_API_KEY'],
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
        message: 'Lambda Cloud API authenticated and operational',
        configuredCredentials: ['LAMBDA_API_KEY'],
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
        message: err.message || 'Failed to reach Lambda Cloud API',
        configuredCredentials: ['LAMBDA_API_KEY'],
        missingCredentials: []
      };
    }
  }

  async discoverGPUs(): Promise<GpuModelInfo[]> {
    if (!this.apiKey) return [];
    try {
      const res = await this.safeFetch('https://cloud.lambdalabs.com/api/v1/instance-types', {
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Accept': 'application/json' }
      });
      if (!res.ok) return [];
      const json = await res.json();
      const types = json.data || {};
      const results: GpuModelInfo[] = [];

      for (const key of Object.keys(types)) {
        const item = types[key]?.instance_type;
        if (item) {
          results.push({
            providerId: this.id,
            gpuModel: item.description || item.name,
            canonicalModel: (item.description || item.name).replace(/^NVIDIA\s+/i, '').trim(),
            vramGb: item.specs?.vram_gb || 24,
            stockAvailable: types[key].regions_with_capacity_available?.length > 0 ? 5 : 0,
            regions: (types[key].regions_with_capacity_available || []).map((r: any) => r.name)
          });
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  async getLivePricing(): Promise<ProviderPriceRecord[]> {
    if (!this.apiKey) return [];
    try {
      const res = await this.safeFetch('https://cloud.lambdalabs.com/api/v1/instance-types', {
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Accept': 'application/json' }
      });
      if (!res.ok) return [];
      const json = await res.json();
      const types = json.data || {};
      const records: ProviderPriceRecord[] = [];

      for (const key of Object.keys(types)) {
        const item = types[key]?.instance_type;
        const available = (types[key].regions_with_capacity_available || []).length > 0;
        const hourly = Number(item?.price_cents_per_hour || 0) / 100;

        if (item && hourly > 0) {
          records.push({
            id: `lambda-${item.name}`,
            providerId: this.id,
            gpuModel: item.description || item.name,
            canonicalModel: (item.description || item.name).replace(/^NVIDIA\s+/i, '').trim(),
            vramGb: item.specs?.vram_gb || 24,
            gpuCount: item.specs?.gpus || 1,
            region: types[key].regions_with_capacity_available?.[0]?.name || 'us-west-1',
            availability: available ? 'AVAILABLE' : 'OUT_OF_STOCK',
            hourlyPrice: hourly,
            minutePrice: hourly > 0 ? Number((hourly / 60).toFixed(6)) : undefined,
            secondPrice: hourly > 0 ? Number((hourly / 3600).toFixed(8)) : undefined,
            cpuPriceHourly: 0.05,
            ramPricePerGbHourly: 0.002,
            storagePricePerGbHourly: 0.0001,
            networkEgressPricePerGb: 0.00, // Lambda has free egress
            startupCost: 0.02,
            spotPriceHourly: undefined,
            isInterruptible: false,
            estimatedInterruptionRiskPct: 0.5,
            timestamp: new Date().toISOString(),
            source: 'https://cloud.lambdalabs.com/api/v1/instance-types',
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
        estimatedStartupSeconds: 30,
        timestamp: new Date().toISOString(),
        source: 'Lambda Cloud API'
      };
    }
    return {
      providerId: this.id,
      gpuModel: match.gpuModel,
      region: region || match.region,
      available: match.availability === 'AVAILABLE',
      stockCount: match.availability === 'AVAILABLE' ? 2 : 0,
      currentPriceHourly: match.hourlyPrice,
      spotAvailable: false,
      estimatedStartupSeconds: 30,
      timestamp: match.timestamp,
      source: match.source
    };
  }

  async getInstanceTypes(): Promise<InstanceTypeInfo[]> {
    const prices = await this.getLivePricing();
    return prices.map(p => ({
      id: p.id,
      providerId: this.id,
      name: `Lambda ${p.gpuModel}`,
      gpuModel: p.gpuModel,
      gpuCount: p.gpuCount,
      vramGb: p.vramGb,
      vcpu: 14,
      ramGb: 64,
      defaultStorageGb: 100,
      hourlyPrice: p.hourlyPrice,
      isSpot: false,
      region: p.region
    }));
  }

  async estimateCost(req: CostEstimateRequest): Promise<CostEstimateResult> {
    const avail = await this.getAvailability(req.gpuModel, req.regionPreference);
    const hourly = avail.available ? avail.currentPriceHourly : 0;
    const computeCost = hourly * req.durationHours * req.gpuCount;
    const storageCost = (req.storageGb * 0.0001) * req.durationHours;
    const networkEgressCost = 0;
    const startupCost = 0.02;
    const interruptionBuffer = 0;
    const providerFees = 0;
    const paymentFees = (computeCost + storageCost) * 0.029 + 0.30;
    const currencyConversion = 0;
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
      interruptionBufferUsd: 0,
      providerFeesUsd: 0,
      paymentFeesUsd: Number(paymentFees.toFixed(4)),
      currencyConversionCostUsd: 0,
      totalTrueCostUsd: Number(totalTrueCost.toFixed(4)),
      effectiveHourlyRateUsd: req.durationHours > 0 ? Number((totalTrueCost / req.durationHours).toFixed(4)) : 0,
      isCalculatedFromLivePricing: avail.available,
      pricingTimestamp: avail.timestamp,
      pricingSource: avail.source
    };
  }

  async provision(req: ProvisionRequest): Promise<ProvisionResult> {
    if (!this.apiKey) {
      return {
        success: false,
        providerId: this.id,
        status: 'FAILED',
        actualHourlyPriceUsd: 0,
        error: 'LAMBDA_API_KEY is not configured',
        provisionedAtIso: new Date().toISOString()
      };
    }

    try {
      const res = await this.safeFetch('https://cloud.lambdalabs.com/api/v1/instance-operations/launch', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          region_name: req.region || 'us-west-1',
          instance_type_name: req.gpuModel,
          ssh_key_names: req.sshPublicKey ? ['gpu-arbitrage-os'] : [],
          quantity: 1,
          name: `arb-lambda-${req.customerRef}`
        })
      });

      if (!res.ok) {
        const text = await res.text();
        return {
          success: false,
          providerId: this.id,
          status: 'FAILED',
          actualHourlyPriceUsd: 0,
          error: `Lambda Labs launch failed (${res.status}): ${text}`,
          provisionedAtIso: new Date().toISOString()
        };
      }

      const json = await res.json();
      const instId = json.data?.instance_ids?.[0];
      return {
        success: true,
        providerId: this.id,
        instanceId: String(instId),
        status: 'PROVISIONING',
        actualHourlyPriceUsd: req.maxHourlyPriceUsd,
        rawResponse: json,
        provisionedAtIso: new Date().toISOString()
      };
    } catch (err: any) {
      return {
        success: false,
        providerId: this.id,
        status: 'FAILED',
        actualHourlyPriceUsd: 0,
        error: err.message || 'Lambda Labs provisioning request failed',
        provisionedAtIso: new Date().toISOString()
      };
    }
  }

  async start(instanceId: string): Promise<InstanceActionResult> {
    return {
      success: false,
      providerId: this.id,
      instanceId,
      action: 'START',
      resultingStatus: 'UNAVAILABLE',
      timestamp: new Date().toISOString(),
      message: 'Lambda cloud instances do not support start/stop actions'
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
      message: 'Lambda cloud instances do not support stop actions'
    };
  }

  async restart(instanceId: string): Promise<InstanceActionResult> {
    if (!this.apiKey) throw new Error('LAMBDA_API_KEY not configured');
    const res = await this.safeFetch('https://cloud.lambdalabs.com/api/v1/instance-operations/restart', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ instance_ids: [instanceId] })
    });
    return {
      success: res.ok,
      providerId: this.id,
      instanceId,
      action: 'RESTART',
      resultingStatus: res.ok ? 'RESTARTING' : 'FAILED',
      timestamp: new Date().toISOString()
    };
  }

  async terminate(instanceId: string): Promise<InstanceActionResult> {
    if (!this.apiKey) throw new Error('LAMBDA_API_KEY not configured');
    const res = await this.safeFetch('https://cloud.lambdalabs.com/api/v1/instance-operations/terminate', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ instance_ids: [instanceId] })
    });
    return {
      success: res.ok,
      providerId: this.id,
      instanceId,
      action: 'TERMINATE',
      resultingStatus: res.ok ? 'TERMINATED' : 'FAILED',
      timestamp: new Date().toISOString()
    };
  }

  async getInstanceStatus(instanceId: string): Promise<InstanceStatusResult> {
    if (!this.apiKey) {
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
    try {
      const res = await this.safeFetch(`https://cloud.lambdalabs.com/api/v1/instances/${instanceId}`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Accept': 'application/json' }
      });
      if (!res.ok) {
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
      const json = await res.json();
      const inst = json.data || {};
      const statusMap: Record<string, 'PROVISIONING' | 'RUNNING' | 'TERMINATED' | 'UNKNOWN'> = {
        'active': 'RUNNING',
        'booting': 'PROVISIONING',
        'terminated': 'TERMINATED'
      };
      return {
        providerId: this.id,
        instanceId,
        status: statusMap[inst.status] || 'UNKNOWN',
        ipAddress: inst.ip,
        uptimeSeconds: 0,
        currentCostAccruedUsd: 0,
        hourlyRateUsd: 0,
        lastCheckedIso: new Date().toISOString(),
        rawStatus: inst
      };
    } catch {
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
  }

  async getTelemetry(instanceId: string): Promise<ProviderTelemetryResult> {
    return this.createUnknownTelemetry(instanceId, 'Lambda telemetry accessible via SSH/API probe');
  }

  async submitWorkload(instanceId: string, workload: WorkloadSpec): Promise<WorkloadSubmissionResult> {
    return this.createUnavailableWorkload(workload.workloadId, 'Lambda Labs provisions cloud instances; direct REST workload submission is UNAVAILABLE');
  }

  async retrieveOutput(instanceId: string, workloadId: string): Promise<WorkloadOutputResult> {
    return this.createUnavailableOutput(workloadId, 'Lambda Labs instance outputs must be retrieved via SSH; direct REST output API is UNAVAILABLE');
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
      currency: 'USD',
      billingMechanism: 'POSTPAID_CARD',
      invoiceCount: 0
    };
  }
}
