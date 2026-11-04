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

export class TensordockProvider extends BaseProvider {
  readonly id = 'tensordock';
  readonly name = 'TensorDock';
  readonly website = 'https://tensordock.com';
  readonly tier = 'MARKETPLACE' as const;

  private get apiKey(): string {
    return (process.env.TENSORDOCK_API_KEY || '').trim();
  }

  async healthCheck(): Promise<ProviderHealthResult> {
    const configured = Boolean(this.apiKey && this.apiKey.length > 5);
    const start = Date.now();
    const missing = configured ? [] : ['TENSORDOCK_API_KEY'];
    const configuredKeys = configured ? ['TENSORDOCK_API_KEY'] : [];

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
          pricing: false,
          inventory: false,
          provisioning: false,
          instanceControl: false,
          telemetry: false,
          billing: false
        },
        lastCheckIso: new Date().toISOString(),
        message: 'TENSORDOCK_API_KEY is not configured',
        configuredCredentials: configuredKeys,
        missingCredentials: missing
      };
    }

    try {
      // Use TensorDock API v2 Bearer token authentication
      const res = await this.safeFetch('https://marketplace.tensordock.com/api/v2/client/balance', {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'api-key': this.apiKey,
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
          message: `TensorDock API v2 returned HTTP ${res.status}`,
          configuredCredentials: configuredKeys,
          missingCredentials: []
        };
      }

      const body = await res.json();
      const authenticated = res.ok && (body.balance !== undefined || body.success === true);

      return {
        providerId: this.id,
        providerName: this.name,
        status: authenticated ? 'LIVE' : 'AUTHENTICATED',
        healthColor: authenticated ? 'GREEN' : 'YELLOW',
        authenticated,
        latencyMs: latency,
        endpoints: {
          authentication: true,
          pricing: true,
          inventory: true,
          provisioning: true,
          instanceControl: true,
          telemetry: false, // TensorDock provides telemetry via guest agent only
          billing: true
        },
        lastCheckIso: new Date().toISOString(),
        message: authenticated ? 'TensorDock API v2 authenticated and operational' : 'TensorDock response received without balance confirmation',
        configuredCredentials: configuredKeys,
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
        message: err.message || 'Failed to reach TensorDock API v2',
        configuredCredentials: configuredKeys,
        missingCredentials: []
      };
    }
  }

  async discoverGPUs(): Promise<GpuModelInfo[]> {
    if (!this.apiKey) return [];
    try {
      const res = await this.safeFetch('https://marketplace.tensordock.com/api/v2/client/deploy/locations', {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'api-key': this.apiKey,
          'Accept': 'application/json'
        }
      });
      if (!res.ok) return [];
      const json = await res.json();
      const locations = json.locations || json.data || [];
      const results: GpuModelInfo[] = [];

      for (const loc of locations) {
        const gpus = loc.gpus || [];
        for (const g of gpus) {
          results.push({
            providerId: this.id,
            gpuModel: g.name || g.model,
            canonicalModel: (g.name || g.model).replace(/^NVIDIA\s+/i, '').trim(),
            vramGb: g.vram_gb || 24,
            stockAvailable: g.available_stock || 1,
            regions: [loc.location_name || 'US']
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
      const res = await this.safeFetch('https://marketplace.tensordock.com/api/v2/client/deploy/locations', {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'api-key': this.apiKey,
          'Accept': 'application/json'
        }
      });
      if (!res.ok) return [];
      const json = await res.json();
      const locations = json.locations || json.data || [];
      const records: ProviderPriceRecord[] = [];

      for (const loc of locations) {
        for (const g of (loc.gpus || [])) {
          const hourly = Number(g.price_hourly || 0);
          records.push({
            id: `tensordock-${loc.id}-${g.model}`,
            providerId: this.id,
            gpuModel: g.name || g.model,
            canonicalModel: (g.name || g.model).replace(/^NVIDIA\s+/i, '').trim(),
            vramGb: g.vram_gb || 24,
            gpuCount: 1,
            region: loc.location_name || 'US',
            availability: (g.available_stock || 0) > 0 ? 'AVAILABLE' : 'OUT_OF_STOCK',
            hourlyPrice: hourly,
            minutePrice: hourly > 0 ? Number((hourly / 60).toFixed(6)) : undefined,
            secondPrice: hourly > 0 ? Number((hourly / 3600).toFixed(8)) : undefined,
            cpuPriceHourly: 0.04,
            ramPricePerGbHourly: 0.002,
            storagePricePerGbHourly: 0.00015,
            networkEgressPricePerGb: 0.005,
            startupCost: 0.02,
            spotPriceHourly: undefined,
            isInterruptible: false,
            estimatedInterruptionRiskPct: 2.0,
            timestamp: new Date().toISOString(),
            source: 'https://marketplace.tensordock.com/api/v2/client/deploy/locations',
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
        source: 'TensorDock API v2'
      };
    }
    return {
      providerId: this.id,
      gpuModel: match.gpuModel,
      region: region || match.region,
      available: true,
      stockCount: 2,
      currentPriceHourly: match.hourlyPrice,
      spotAvailable: false,
      estimatedStartupSeconds: 30,
      timestamp: match.timestamp,
      source: match.source
    };
  }

  async getInstanceTypes(): Promise<InstanceTypeInfo[]> {
    const prices = await this.getLivePricing();
    return prices.slice(0, 20).map(p => ({
      id: p.id,
      providerId: this.id,
      name: `TensorDock ${p.gpuModel}`,
      gpuModel: p.gpuModel,
      gpuCount: 1,
      vramGb: p.vramGb,
      vcpu: 8,
      ramGb: 32,
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
    const storageCost = (req.storageGb * 0.00015) * req.durationHours;
    const networkEgressCost = req.estimatedEgressGb * 0.005;
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
        error: 'TENSORDOCK_API_KEY is not configured',
        provisionedAtIso: new Date().toISOString()
      };
    }

    try {
      const res = await this.safeFetch('https://marketplace.tensordock.com/api/v2/client/deploy', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'api-key': this.apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          gpu_model: req.gpuModel,
          gpu_count: req.gpuCount,
          name: `arb-td-${req.customerRef}`,
          operating_system: 'Ubuntu 22.04 LTS',
          storage_gb: req.diskSizeGb || 100,
          ssh_key: req.sshPublicKey
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        return {
          success: false,
          providerId: this.id,
          status: 'FAILED',
          actualHourlyPriceUsd: 0,
          error: `TensorDock deploy returned HTTP ${res.status}: ${errText}`,
          provisionedAtIso: new Date().toISOString()
        };
      }

      const data = await res.json();
      return {
        success: true,
        providerId: this.id,
        instanceId: String(data.server_id || data.id),
        status: 'PROVISIONING',
        actualHourlyPriceUsd: Number(data.price_hourly || req.maxHourlyPriceUsd),
        rawResponse: data,
        provisionedAtIso: new Date().toISOString()
      };
    } catch (err: any) {
      return {
        success: false,
        providerId: this.id,
        status: 'FAILED',
        actualHourlyPriceUsd: 0,
        error: err.message || 'TensorDock provisioning failed',
        provisionedAtIso: new Date().toISOString()
      };
    }
  }

  async start(instanceId: string): Promise<InstanceActionResult> {
    if (!this.apiKey) throw new Error('TENSORDOCK_API_KEY not configured');
    const res = await this.safeFetch(`https://marketplace.tensordock.com/api/v2/client/virtualmachines/${instanceId}/action`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start' })
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
    if (!this.apiKey) throw new Error('TENSORDOCK_API_KEY not configured');
    const res = await this.safeFetch(`https://marketplace.tensordock.com/api/v2/client/virtualmachines/${instanceId}/action`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop' })
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
    if (!this.apiKey) throw new Error('TENSORDOCK_API_KEY not configured');
    const res = await this.safeFetch(`https://marketplace.tensordock.com/api/v2/client/virtualmachines/${instanceId}/action`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reboot' })
    });
    return {
      success: res.ok,
      providerId: this.id,
      instanceId,
      action: 'RESTART',
      resultingStatus: res.ok ? 'REBOOTING' : 'FAILED',
      timestamp: new Date().toISOString()
    };
  }

  async terminate(instanceId: string): Promise<InstanceActionResult> {
    if (!this.apiKey) throw new Error('TENSORDOCK_API_KEY not configured');
    const res = await this.safeFetch(`https://marketplace.tensordock.com/api/v2/client/virtualmachines/${instanceId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'api-key': this.apiKey }
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
    if (!this.apiKey) throw new Error('TENSORDOCK_API_KEY not configured');
    try {
      const res = await this.safeFetch(`https://marketplace.tensordock.com/api/v2/client/virtualmachines/${instanceId}`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'api-key': this.apiKey, 'Accept': 'application/json' }
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
        status: data.status === 'running' ? 'RUNNING' : data.status === 'stopped' ? 'STOPPED' : 'UNKNOWN',
        ipAddress: data.ip_address,
        uptimeSeconds: Math.round(Number(data.uptime_seconds || 0)),
        currentCostAccruedUsd: Number(data.cost_accrued || 0),
        hourlyRateUsd: Number(data.price_hourly || 0),
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
    return this.createUnknownTelemetry(instanceId, 'TensorDock API does not expose native hardware telemetry');
  }

  async submitWorkload(instanceId: string, workload: WorkloadSpec): Promise<WorkloadSubmissionResult> {
    return this.createUnavailableWorkload(workload.workloadId, 'TensorDock deploys virtual machines via cloud-init; direct REST job submission is UNAVAILABLE');
  }

  async retrieveOutput(instanceId: string, workloadId: string): Promise<WorkloadOutputResult> {
    return this.createUnavailableOutput(workloadId, 'TensorDock VM outputs must be retrieved via SSH or mounted storage; direct REST output API is UNAVAILABLE');
  }

  async getUsage(instanceId: string): Promise<ProviderUsageResult> {
    const status = await this.getInstanceStatus(instanceId);
    return {
      providerId: this.id,
      instanceId,
      runtimeSeconds: status.uptimeSeconds,
      gpuHours: Number((status.uptimeSeconds / 3600).toFixed(4)),
      totalCostUsd: status.currentCostAccruedUsd,
      currency: 'USD',
      isFinal: status.status === 'TERMINATED',
      periodStartIso: new Date(Date.now() - status.uptimeSeconds * 1000).toISOString(),
      periodEndIso: new Date().toISOString()
    };
  }

  async getBilling(): Promise<ProviderBillingResult> {
    if (!this.apiKey) {
      return {
        providerId: this.id,
        accountBalanceUsd: null,
        creditRemainingUsd: null,
        currentUnbilledChargesUsd: null,
        currency: 'USD',
        billingMechanism: 'PREPAID_CREDIT',
        invoiceCount: 0
      };
    }
    try {
      const res = await this.safeFetch('https://marketplace.tensordock.com/api/v2/client/balance', {
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'api-key': this.apiKey, 'Accept': 'application/json' }
      });
      if (!res.ok) {
        return {
          providerId: this.id,
          accountBalanceUsd: null,
          creditRemainingUsd: null,
          currentUnbilledChargesUsd: null,
          currency: 'USD',
          billingMechanism: 'PREPAID_CREDIT',
          invoiceCount: 0
        };
      }
      const data = await res.json();
      const bal = Number(data.balance || 0);
      return {
        providerId: this.id,
        accountBalanceUsd: bal,
        creditRemainingUsd: bal,
        currentUnbilledChargesUsd: null,
        currency: 'USD',
        billingMechanism: 'PREPAID_CREDIT',
        invoiceCount: 1,
        rawBillingInfo: data
      };
    } catch {
      return {
        providerId: this.id,
        accountBalanceUsd: null,
        creditRemainingUsd: null,
        currentUnbilledChargesUsd: null,
        currency: 'USD',
        billingMechanism: 'PREPAID_CREDIT',
        invoiceCount: 0
      };
    }
  }
}
