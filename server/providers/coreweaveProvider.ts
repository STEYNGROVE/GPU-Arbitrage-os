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

export class CoreweaveProvider extends BaseProvider {
  readonly id = 'coreweave';
  readonly name = 'CoreWeave';
  readonly website = 'https://coreweave.com';
  readonly tier = 'ENTERPRISE_HYPERSCALER' as const;

  private get apiKey(): string {
    return (process.env.COREWEAVE_API_KEY || '').trim();
  }

  async healthCheck(): Promise<ProviderHealthResult> {
    const configured = Boolean(this.apiKey && this.apiKey.length > 5);
    const start = Date.now();
    const missing = configured ? [] : ['COREWEAVE_API_KEY'];

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
        message: 'COREWEAVE_API_KEY is not configured',
        configuredCredentials: [],
        missingCredentials: missing
      };
    }

    try {
      const res = await this.safeFetch('https://api.coreweave.com/v1/user', {
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
            pricing: true,
            inventory: true,
            provisioning: false,
            instanceControl: false,
            telemetry: false,
            billing: false
          },
          lastCheckIso: new Date().toISOString(),
          message: `CoreWeave API returned HTTP ${res.status}`,
          configuredCredentials: ['COREWEAVE_API_KEY'],
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
        message: 'CoreWeave Kubernetes Cloud API authenticated and operational',
        configuredCredentials: ['COREWEAVE_API_KEY'],
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
        message: err.message || 'Failed to reach CoreWeave API',
        configuredCredentials: ['COREWEAVE_API_KEY'],
        missingCredentials: []
      };
    }
  }

  async discoverGPUs(): Promise<GpuModelInfo[]> {
    if (!this.apiKey) return [];
    try {
      const res = await this.safeFetch('https://api.coreweave.com/v1/catalog', {
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Accept': 'application/json' }
      });
      if (!res.ok) return [];
      const json = await res.json();
      const items = json.gpus || json.data || [];
      return items.map((item: any) => ({
        providerId: this.id,
        gpuModel: item.name || item.model,
        canonicalModel: (item.name || item.model).replace(/^NVIDIA\s+/i, '').trim(),
        vramGb: item.vram_gb || 80,
        stockAvailable: item.available_count ?? 1,
        regions: item.regions || ['US-EAST-CW']
      }));
    } catch {
      return [];
    }
  }

  async getLivePricing(): Promise<ProviderPriceRecord[]> {
    if (!this.apiKey) return [];
    try {
      const res = await this.safeFetch('https://api.coreweave.com/v1/pricing', {
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Accept': 'application/json' }
      });
      if (!res.ok) return [];
      const json = await res.json();
      const items = json.pricing || json.data || [];
      const records: ProviderPriceRecord[] = [];

      for (const item of items) {
        const hourly = Number(item.price_hourly || item.cost_per_hour || 0);
        if (hourly > 0) {
          records.push({
            id: `cw-${item.id || item.sku}`,
            providerId: this.id,
            gpuModel: item.gpu_name || item.name,
            canonicalModel: (item.gpu_name || item.name).replace(/^NVIDIA\s+/i, '').trim(),
            vramGb: item.vram_gb || 80,
            gpuCount: item.gpu_count || 1,
            region: item.region || 'US-EAST-CW',
            availability: 'AVAILABLE',
            hourlyPrice: hourly,
            minutePrice: Number((hourly / 60).toFixed(6)),
            secondPrice: Number((hourly / 3600).toFixed(8)),
            cpuPriceHourly: 0.15,
            ramPricePerGbHourly: 0.004,
            storagePricePerGbHourly: 0.0002,
            networkEgressPricePerGb: 0.01,
            startupCost: 0.03,
            spotPriceHourly: undefined,
            isInterruptible: false,
            estimatedInterruptionRiskPct: 0.1,
            timestamp: new Date().toISOString(),
            source: 'https://api.coreweave.com/v1/pricing',
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
        estimatedStartupSeconds: 15,
        timestamp: new Date().toISOString(),
        source: 'CoreWeave Cloud'
      };
    }
    return {
      providerId: this.id,
      gpuModel: match.gpuModel,
      region: region || match.region,
      available: true,
      stockCount: 8,
      currentPriceHourly: match.hourlyPrice,
      spotAvailable: false,
      estimatedStartupSeconds: 15,
      timestamp: match.timestamp,
      source: match.source
    };
  }

  async getInstanceTypes(): Promise<InstanceTypeInfo[]> {
    const prices = await this.getLivePricing();
    return prices.map(p => ({
      id: p.id,
      providerId: this.id,
      name: `CoreWeave Pod (${p.gpuModel})`,
      gpuModel: p.gpuModel,
      gpuCount: p.gpuCount,
      vramGb: p.vramGb,
      vcpu: 16,
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
    const storageCost = (req.storageGb * 0.0002) * req.durationHours;
    const networkEgressCost = req.estimatedEgressGb * 0.01;
    const startupCost = 0.03;
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
      networkEgressCostUsd: Number(networkEgressCost.toFixed(4)),
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
        error: 'COREWEAVE_API_KEY is not configured',
        provisionedAtIso: new Date().toISOString()
      };
    }

    try {
      const res = await this.safeFetch('https://api.coreweave.com/v1/deployments', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: `cw-dep-${req.customerRef}`,
          gpu_type: req.gpuModel,
          gpu_count: req.gpuCount,
          image: req.dockerImage || 'pytorch/pytorch:latest',
          command: req.command ? [req.command] : undefined
        })
      });

      if (!res.ok) {
        const text = await res.text();
        return {
          success: false,
          providerId: this.id,
          status: 'FAILED',
          actualHourlyPriceUsd: 0,
          error: `CoreWeave provisioning failed (${res.status}): ${text}`,
          provisionedAtIso: new Date().toISOString()
        };
      }

      const data = await res.json();
      return {
        success: true,
        providerId: this.id,
        instanceId: String(data.id || data.name),
        status: 'PROVISIONING',
        actualHourlyPriceUsd: Number(data.cost_per_hour || req.maxHourlyPriceUsd),
        rawResponse: data,
        provisionedAtIso: new Date().toISOString()
      };
    } catch (err: any) {
      return {
        success: false,
        providerId: this.id,
        status: 'FAILED',
        actualHourlyPriceUsd: 0,
        error: err.message || 'CoreWeave provisioning request failed',
        provisionedAtIso: new Date().toISOString()
      };
    }
  }

  async start(instanceId: string): Promise<InstanceActionResult> {
    if (!this.apiKey) throw new Error('COREWEAVE_API_KEY not configured');
    const res = await this.safeFetch(`https://api.coreweave.com/v1/deployments/${instanceId}/start`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });
    return {
      success: res.ok,
      providerId: this.id,
      instanceId,
      action: 'START',
      resultingStatus: res.ok ? 'STARTING' : 'FAILED',
      timestamp: new Date().toISOString()
    };
  }

  async stop(instanceId: string): Promise<InstanceActionResult> {
    if (!this.apiKey) throw new Error('COREWEAVE_API_KEY not configured');
    const res = await this.safeFetch(`https://api.coreweave.com/v1/deployments/${instanceId}/stop`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });
    return {
      success: res.ok,
      providerId: this.id,
      instanceId,
      action: 'STOP',
      resultingStatus: res.ok ? 'STOPPED' : 'FAILED',
      timestamp: new Date().toISOString()
    };
  }

  async restart(instanceId: string): Promise<InstanceActionResult> {
    if (!this.apiKey) throw new Error('COREWEAVE_API_KEY not configured');
    const res = await this.safeFetch(`https://api.coreweave.com/v1/deployments/${instanceId}/restart`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
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
    if (!this.apiKey) throw new Error('COREWEAVE_API_KEY not configured');
    const res = await this.safeFetch(`https://api.coreweave.com/v1/deployments/${instanceId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
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
      const res = await this.safeFetch(`https://api.coreweave.com/v1/deployments/${instanceId}`, {
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
      const data = await res.json();
      return {
        providerId: this.id,
        instanceId,
        status: data.status === 'Running' ? 'RUNNING' : data.status === 'Terminated' ? 'TERMINATED' : 'UNKNOWN',
        uptimeSeconds: 0,
        currentCostAccruedUsd: 0,
        hourlyRateUsd: 0,
        lastCheckedIso: new Date().toISOString(),
        rawStatus: data
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
    return this.createUnknownTelemetry(instanceId, 'CoreWeave exposes Prometheus metrics via cluster exporter');
  }

  async submitWorkload(instanceId: string, workload: WorkloadSpec): Promise<WorkloadSubmissionResult> {
    return this.createUnavailableWorkload(workload.workloadId, 'CoreWeave executes workloads via Kubernetes manifests; direct REST submission is UNAVAILABLE');
  }

  async retrieveOutput(instanceId: string, workloadId: string): Promise<WorkloadOutputResult> {
    return this.createUnavailableOutput(workloadId, 'CoreWeave pod outputs must be retrieved via PVC storage or Kubernetes logs; direct REST output API is UNAVAILABLE');
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
