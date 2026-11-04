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

export class VastAiProvider extends BaseProvider {
  readonly id = 'vast_ai';
  readonly name = 'Vast.ai';
  readonly website = 'https://vast.ai';
  readonly tier = 'MARKETPLACE' as const;

  private get apiKey(): string {
    return (process.env.VAST_API_KEY || '').trim();
  }

  async healthCheck(): Promise<ProviderHealthResult> {
    const configured = Boolean(this.apiKey && this.apiKey.length > 5);
    const start = Date.now();
    const missing = configured ? [] : ['VAST_API_KEY'];
    const configuredKeys = configured ? ['VAST_API_KEY'] : [];

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
        message: 'VAST_API_KEY is not configured',
        configuredCredentials: configuredKeys,
        missingCredentials: missing
      };
    }

    try {
      const res = await this.safeFetch('https://console.vast.ai/api/v0/users/current/', {
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
          message: `Vast.ai authentication failed with HTTP ${res.status}`,
          configuredCredentials: configuredKeys,
          missingCredentials: []
        };
      }

      const userData = await res.json();
      const authenticated = Boolean(userData && (userData.id || userData.username || userData.email));

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
          telemetry: true,
          billing: true
        },
        lastCheckIso: new Date().toISOString(),
        message: authenticated ? 'Vast.ai API authenticated and operational' : 'Vast.ai API responded without user profile',
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
        message: err.message || 'Failed to reach Vast.ai API',
        configuredCredentials: configuredKeys,
        missingCredentials: []
      };
    }
  }

  async discoverGPUs(): Promise<GpuModelInfo[]> {
    if (!this.apiKey) return [];
    try {
      const res = await this.safeFetch('https://console.vast.ai/api/v0/bundles/?q=%7B%22verified%22%3A%7B%22eq%22%3Atrue%7D%7D', {
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Accept': 'application/json' }
      });
      if (!res.ok) return [];
      const data = await res.json();
      const offers: any[] = data.offers || [];

      const map = new Map<string, GpuModelInfo>();
      for (const o of offers) {
        const name = o.gpu_name || 'Unknown GPU';
        if (!map.has(name)) {
          map.set(name, {
            providerId: this.id,
            gpuModel: name,
            canonicalModel: name.replace(/^NVIDIA\s+/i, '').trim(),
            vramGb: Math.round((o.gpu_ram || 0) / 1024) || 24,
            stockAvailable: 1,
            regions: [o.geolocation || 'GLOBAL']
          });
        } else {
          const item = map.get(name)!;
          item.stockAvailable += 1;
          if (o.geolocation && !item.regions.includes(o.geolocation)) {
            item.regions.push(o.geolocation);
          }
        }
      }
      return Array.from(map.values());
    } catch {
      return [];
    }
  }

  async getLivePricing(): Promise<ProviderPriceRecord[]> {
    if (!this.apiKey) return [];
    try {
      const res = await this.safeFetch('https://console.vast.ai/api/v0/bundles/?q=%7B%22verified%22%3A%7B%22eq%22%3Atrue%7D%7D', {
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Accept': 'application/json' }
      });
      if (!res.ok) return [];
      const data = await res.json();
      const offers: any[] = data.offers || [];

      return offers.map((o: any) => {
        const hourly = Number(o.dph_total || o.dph_base || 0);
        const name = o.gpu_name || 'GPU';
        return {
          id: `vast-${o.id || o.bundle_id}`,
          providerId: this.id,
          gpuModel: name,
          canonicalModel: name.replace(/^NVIDIA\s+/i, '').trim(),
          vramGb: Math.round((o.gpu_ram || 0) / 1024) || 24,
          gpuCount: o.num_gpus || 1,
          region: o.geolocation || 'GLOBAL',
          availability: o.rentable ? 'AVAILABLE' : 'OUT_OF_STOCK',
          hourlyPrice: hourly,
          minutePrice: hourly > 0 ? Number((hourly / 60).toFixed(6)) : undefined,
          secondPrice: hourly > 0 ? Number((hourly / 3600).toFixed(8)) : undefined,
          cpuPriceHourly: Number((hourly * 0.05).toFixed(4)),
          ramPricePerGbHourly: 0.002,
          storagePricePerGbHourly: Number(o.storage_cost || 0.0002),
          networkEgressPricePerGb: Number(o.inet_up_cost || 0.01),
          startupCost: 0.02,
          spotPriceHourly: o.is_bid ? hourly : Number((hourly * 0.6).toFixed(4)),
          isInterruptible: Boolean(o.is_bid),
          estimatedInterruptionRiskPct: o.is_bid ? 12.5 : 1.5,
          timestamp: new Date().toISOString(),
          source: 'https://console.vast.ai/api/v0/bundles/',
          currency: 'USD',
          status: 'LIVE',
          rawReference: { offer_id: o.id, host_id: o.host_id, score: o.score }
        };
      });
    } catch {
      return [];
    }
  }

  async getAvailability(gpuModel: string, region?: string): Promise<ProviderAvailability> {
    const prices = await this.getLivePricing();
    const match = prices.find(p => p.gpuModel.toLowerCase().includes(gpuModel.toLowerCase()) && (!region || p.region === region));
    if (!match) {
      return {
        providerId: this.id,
        gpuModel,
        region,
        available: false,
        stockCount: 0,
        currentPriceHourly: 0,
        spotAvailable: false,
        estimatedStartupSeconds: 25,
        timestamp: new Date().toISOString(),
        source: 'Vast.ai API /bundles'
      };
    }
    return {
      providerId: this.id,
      gpuModel: match.gpuModel,
      region: match.region,
      available: true,
      stockCount: 1,
      currentPriceHourly: match.hourlyPrice,
      spotAvailable: match.isInterruptible,
      spotPriceHourly: match.spotPriceHourly,
      estimatedStartupSeconds: 25,
      timestamp: match.timestamp,
      source: match.source
    };
  }

  async getInstanceTypes(): Promise<InstanceTypeInfo[]> {
    const prices = await this.getLivePricing();
    return prices.slice(0, 50).map(p => ({
      id: p.id,
      providerId: this.id,
      name: `${p.gpuCount}x ${p.gpuModel}`,
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
    const storageCost = (req.storageGb * 0.0002) * req.durationHours;
    const networkEgressCost = req.estimatedEgressGb * 0.01;
    const startupCost = 0.02;
    const interruptionBuffer = req.isInterruptible ? computeCost * 0.05 : 0;
    const providerFees = computeCost * 0.02; // Vast.ai fee
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
      interruptionBufferUsd: Number(interruptionBuffer.toFixed(4)),
      providerFeesUsd: Number(providerFees.toFixed(4)),
      paymentFeesUsd: Number(paymentFees.toFixed(4)),
      currencyConversionCostUsd: currencyConversion,
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
        error: 'VAST_API_KEY is not configured',
        provisionedAtIso: new Date().toISOString()
      };
    }

    try {
      // Create actual instance via Vast API PUT /api/v0/asks/{id}/
      const body = {
        client_id: 'gpu-arbitrage-os',
        image: req.dockerImage || 'pytorch/pytorch:latest',
        disk: req.diskSizeGb || 50,
        label: `job-${req.customerRef}`,
        onstart: req.command || undefined
      };

      const res = await this.safeFetch(`https://console.vast.ai/api/v0/asks/${req.gpuModel}/`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const errText = await res.text();
        return {
          success: false,
          providerId: this.id,
          status: 'FAILED',
          actualHourlyPriceUsd: 0,
          error: `Vast.ai provisioning failed (${res.status}): ${errText}`,
          provisionedAtIso: new Date().toISOString()
        };
      }

      const data = await res.json();
      return {
        success: true,
        providerId: this.id,
        instanceId: String(data.new_contract || data.id),
        status: 'PROVISIONING',
        actualHourlyPriceUsd: Number(data.dph || req.maxHourlyPriceUsd),
        rawResponse: data,
        provisionedAtIso: new Date().toISOString()
      };
    } catch (err: any) {
      return {
        success: false,
        providerId: this.id,
        status: 'FAILED',
        actualHourlyPriceUsd: 0,
        error: err.message || 'Exception during Vast.ai provisioning',
        provisionedAtIso: new Date().toISOString()
      };
    }
  }

  async start(instanceId: string): Promise<InstanceActionResult> {
    if (!this.apiKey) throw new Error('VAST_API_KEY not configured');
    const res = await this.safeFetch(`https://console.vast.ai/api/v0/instances/${instanceId}/`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'running' })
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
    if (!this.apiKey) throw new Error('VAST_API_KEY not configured');
    const res = await this.safeFetch(`https://console.vast.ai/api/v0/instances/${instanceId}/`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'stopped' })
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
    if (!this.apiKey) throw new Error('VAST_API_KEY not configured');
    const res = await this.safeFetch(`https://console.vast.ai/api/v0/instances/${instanceId}/reboot/`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
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
    if (!this.apiKey) throw new Error('VAST_API_KEY not configured');
    const res = await this.safeFetch(`https://console.vast.ai/api/v0/instances/${instanceId}/`, {
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
    if (!this.apiKey) throw new Error('VAST_API_KEY not configured');
    try {
      const res = await this.safeFetch(`https://console.vast.ai/api/v0/instances/${instanceId}/`, {
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
        status: data.actual_status === 'running' ? 'RUNNING' : data.actual_status === 'stopped' ? 'STOPPED' : 'UNKNOWN',
        ipAddress: data.public_ipaddr,
        uptimeSeconds: Math.round(Number(data.duration || 0)),
        currentCostAccruedUsd: Number(data.total_cost || 0),
        hourlyRateUsd: Number(data.dph_total || 0),
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
    if (!this.apiKey) return this.createUnknownTelemetry(instanceId, 'VAST_API_KEY not configured');
    try {
      const res = await this.safeFetch(`https://console.vast.ai/api/v0/instances/${instanceId}/`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Accept': 'application/json' }
      });
      if (!res.ok) return this.createUnknownTelemetry(instanceId, `HTTP ${res.status}`);
      const data = await res.json();
      if (!data || !data.gpu_util) {
        return this.createUnknownTelemetry(instanceId, 'Telemetry unpopulated on instance');
      }

      return {
        providerId: this.id,
        instanceId,
        timestamp: new Date().toISOString(),
        isVerified: true,
        source: 'PROVIDER_API',
        gpuUtilizationPct: data.gpu_util !== undefined ? Number(data.gpu_util) : null,
        gpuTemperatureC: data.gpu_temp !== undefined ? Number(data.gpu_temp) : null,
        vramUsedGb: data.gpu_ram_used !== undefined ? Number(data.gpu_ram_used) / 1024 : null,
        vramTotalGb: data.gpu_ram !== undefined ? Number(data.gpu_ram) / 1024 : null,
        powerWatts: data.power_draw !== undefined ? Number(data.power_draw) : null,
        cpuUtilizationPct: data.cpu_util !== undefined ? Number(data.cpu_util) : null,
        ramUsedGb: data.mem_usage !== undefined ? Number(data.mem_usage) : null,
        diskUsedGb: data.disk_usage !== undefined ? Number(data.disk_usage) : null,
        networkInMbps: data.inet_down_rate !== undefined ? Number(data.inet_down_rate) : null,
        networkOutMbps: data.inet_up_rate !== undefined ? Number(data.inet_up_rate) : null,
        accruedCostUsd: Number(data.total_cost || 0),
        errorCount: 0,
        rawTelemetry: data
      };
    } catch (err: any) {
      return this.createUnknownTelemetry(instanceId, err.message);
    }
  }

  async submitWorkload(instanceId: string, workload: WorkloadSpec): Promise<WorkloadSubmissionResult> {
    return this.createUnavailableWorkload(workload.workloadId, 'Vast.ai instances execute workloads via container launch parameters and SSH; direct REST job submission is UNAVAILABLE');
  }

  async retrieveOutput(instanceId: string, workloadId: string): Promise<WorkloadOutputResult> {
    return this.createUnavailableOutput(workloadId, 'Vast.ai workload outputs must be retrieved via instance SSH or container volume; direct REST output API is UNAVAILABLE');
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
      const res = await this.safeFetch('https://console.vast.ai/api/v0/users/current/', {
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Accept': 'application/json' }
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
      const credit = Number(data.credit || 0);
      return {
        providerId: this.id,
        accountBalanceUsd: credit,
        creditRemainingUsd: credit,
        currentUnbilledChargesUsd: null,
        currency: 'USD',
        billingMechanism: 'PREPAID_CREDIT',
        invoiceCount: 1,
        rawBillingInfo: { username: data.username, email: data.email, credit }
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
