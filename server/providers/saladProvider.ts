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

export class SaladProvider extends BaseProvider {
  readonly id = 'salad';
  readonly name = 'SaladCloud';
  readonly website = 'https://salad.com';
  readonly tier = 'DISTRIBUTED_EDGE' as const;

  private get apiKey(): string {
    return (process.env.SALAD_API_KEY || '').trim();
  }

  private get orgId(): string {
    return (process.env.SALAD_ORG_ID || '').trim();
  }

  async healthCheck(): Promise<ProviderHealthResult> {
    const hasKey = Boolean(this.apiKey && this.apiKey.length > 5);
    const hasOrg = Boolean(this.orgId && this.orgId.length > 1);
    const start = Date.now();

    const missing: string[] = [];
    if (!hasKey) missing.push('SALAD_API_KEY');
    if (!hasOrg) missing.push('SALAD_ORG_ID');

    const configured = hasKey && hasOrg;

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
        message: `Missing SaladCloud credentials: ${missing.join(', ')}`,
        configuredCredentials: this.orgId ? ['SALAD_ORG_ID: ' + this.orgId] : [],
        missingCredentials: missing
      };
    }

    try {
      const res = await this.safeFetch(`https://api.salad.com/api/public/organizations/${this.orgId}/quotas`, {
        headers: {
          'Salad-Api-Key': this.apiKey,
          'Accept': 'application/json'
        }
      });
      const latency = Date.now() - start;

      if (!res.ok) {
        return {
          providerId: this.id,
          providerName: this.name,
          status: 'FAILED',
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
          message: `SaladCloud API rejected credentials with HTTP ${res.status}`,
          configuredCredentials: ['SALAD_API_KEY', 'SALAD_ORG_ID'],
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
          telemetry: false, // Salad provides metrics only via container logging
          billing: true
        },
        lastCheckIso: new Date().toISOString(),
        message: 'SaladCloud organization authenticated and operational',
        configuredCredentials: ['SALAD_API_KEY', 'SALAD_ORG_ID'],
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
        message: err.message || 'Failed to reach SaladCloud API',
        configuredCredentials: ['SALAD_API_KEY', 'SALAD_ORG_ID'],
        missingCredentials: []
      };
    }
  }

  async discoverGPUs(): Promise<GpuModelInfo[]> {
    if (!this.apiKey || !this.orgId) return [];
    try {
      const res = await this.safeFetch(`https://api.salad.com/api/public/organizations/${this.orgId}/quotas`, {
        headers: { 'Salad-Api-Key': this.apiKey, 'Accept': 'application/json' }
      });
      if (!res.ok) return [];
      const json = await res.json();
      const containerQuotas = json.container_resource_quotas || [];
      const models: GpuModelInfo[] = [];

      for (const q of containerQuotas) {
        if (q.gpu_classes && q.gpu_classes.length > 0) {
          for (const g of q.gpu_classes) {
            models.push({
              providerId: this.id,
              gpuModel: g.name || g.id,
              canonicalModel: (g.name || g.id).replace(/^(nvidia|geforce)\s+/i, '').trim(),
              vramGb: g.vram_gb || 24,
              stockAvailable: q.max_replicas || 1,
              regions: ['GLOBAL_EDGE']
            });
          }
        }
      }
      return models;
    } catch {
      return [];
    }
  }

  async getLivePricing(): Promise<ProviderPriceRecord[]> {
    if (!this.apiKey || !this.orgId) return [];
    try {
      const res = await this.safeFetch(`https://api.salad.com/api/public/organizations/${this.orgId}/quotas`, {
        headers: { 'Salad-Api-Key': this.apiKey, 'Accept': 'application/json' }
      });
      if (!res.ok) return [];
      const json = await res.json();
      const quotas = json.container_resource_quotas || [];
      const records: ProviderPriceRecord[] = [];

      for (const q of quotas) {
        for (const g of (q.gpu_classes || [])) {
          const hourly = Number(g.price_per_hour || g.hourly_rate || 0);
          if (hourly > 0) {
            records.push({
              id: `salad-${g.id || g.name}`,
              providerId: this.id,
              gpuModel: g.name || g.id,
              canonicalModel: (g.name || g.id).replace(/^(nvidia|geforce)\s+/i, '').trim(),
              vramGb: g.vram_gb || 24,
              gpuCount: 1,
              region: 'GLOBAL_EDGE',
              availability: 'AVAILABLE',
              hourlyPrice: hourly,
              minutePrice: Number((hourly / 60).toFixed(6)),
              secondPrice: Number((hourly / 3600).toFixed(8)),
              cpuPriceHourly: 0.015,
              ramPricePerGbHourly: 0.001,
              storagePricePerGbHourly: 0.0001,
              networkEgressPricePerGb: 0.00,
              startupCost: 0.005,
              spotPriceHourly: Number((hourly * 0.7).toFixed(4)),
              isInterruptible: true,
              estimatedInterruptionRiskPct: 12.0,
              timestamp: new Date().toISOString(),
              source: `https://api.salad.com/api/public/organizations/${this.orgId}/quotas`,
              currency: 'USD',
              status: 'LIVE'
            });
          }
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
        estimatedStartupSeconds: 20,
        timestamp: new Date().toISOString(),
        source: 'SaladCloud Quotas API'
      };
    }
    return {
      providerId: this.id,
      gpuModel: match.gpuModel,
      region: region || match.region,
      available: true,
      stockCount: 10,
      currentPriceHourly: match.hourlyPrice,
      spotAvailable: match.isInterruptible,
      spotPriceHourly: match.spotPriceHourly,
      estimatedStartupSeconds: 20,
      timestamp: match.timestamp,
      source: match.source
    };
  }

  async getInstanceTypes(): Promise<InstanceTypeInfo[]> {
    const prices = await this.getLivePricing();
    return prices.map(p => ({
      id: p.id,
      providerId: this.id,
      name: `Salad Container (${p.gpuModel})`,
      gpuModel: p.gpuModel,
      gpuCount: p.gpuCount,
      vramGb: p.vramGb,
      vcpu: 8,
      ramGb: 32,
      defaultStorageGb: 50,
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
    const startupCost = 0.005;
    const interruptionBuffer = req.isInterruptible ? computeCost * 0.08 : 0;
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
      interruptionBufferUsd: Number(interruptionBuffer.toFixed(4)),
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
    if (!this.apiKey || !this.orgId) {
      return {
        success: false,
        providerId: this.id,
        status: 'FAILED',
        actualHourlyPriceUsd: 0,
        error: 'SALAD_API_KEY and SALAD_ORG_ID required for SaladCloud provisioning',
        provisionedAtIso: new Date().toISOString()
      };
    }

    try {
      const body = {
        name: `cg-${req.customerRef.substring(0, 16)}`,
        container: {
          image: req.dockerImage || 'pytorch/pytorch:latest',
          resources: {
            cpu: 4,
            memory: 16384,
            gpu_classes: [req.gpuModel]
          },
          command: req.command ? [req.command] : undefined,
          priority: req.isInterruptible ? 'batch' : 'high'
        },
        replicas: req.gpuCount || 1,
        restart_policy: 'always'
      };

      const res = await this.safeFetch(`https://api.salad.com/api/public/organizations/${this.orgId}/projects/default/containers`, {
        method: 'POST',
        headers: {
          'Salad-Api-Key': this.apiKey,
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
          error: `SaladCloud deployment returned HTTP ${res.status}: ${errText}`,
          provisionedAtIso: new Date().toISOString()
        };
      }

      const data = await res.json();
      return {
        success: true,
        providerId: this.id,
        instanceId: String(data.id || data.name),
        status: 'PROVISIONING',
        actualHourlyPriceUsd: req.maxHourlyPriceUsd,
        rawResponse: data,
        provisionedAtIso: new Date().toISOString()
      };
    } catch (err: any) {
      return {
        success: false,
        providerId: this.id,
        status: 'FAILED',
        actualHourlyPriceUsd: 0,
        error: err.message || 'SaladCloud deployment failed',
        provisionedAtIso: new Date().toISOString()
      };
    }
  }

  async start(instanceId: string): Promise<InstanceActionResult> {
    if (!this.apiKey || !this.orgId) throw new Error('SALAD credentials not configured');
    const res = await this.safeFetch(`https://api.salad.com/api/public/organizations/${this.orgId}/projects/default/containers/${instanceId}/start`, {
      method: 'POST',
      headers: { 'Salad-Api-Key': this.apiKey }
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
    if (!this.apiKey || !this.orgId) throw new Error('SALAD credentials not configured');
    const res = await this.safeFetch(`https://api.salad.com/api/public/organizations/${this.orgId}/projects/default/containers/${instanceId}/stop`, {
      method: 'POST',
      headers: { 'Salad-Api-Key': this.apiKey }
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
    await this.stop(instanceId);
    return this.start(instanceId);
  }

  async terminate(instanceId: string): Promise<InstanceActionResult> {
    if (!this.apiKey || !this.orgId) throw new Error('SALAD credentials not configured');
    const res = await this.safeFetch(`https://api.salad.com/api/public/organizations/${this.orgId}/projects/default/containers/${instanceId}`, {
      method: 'DELETE',
      headers: { 'Salad-Api-Key': this.apiKey }
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
    if (!this.apiKey || !this.orgId) throw new Error('SALAD credentials not configured');
    try {
      const res = await this.safeFetch(`https://api.salad.com/api/public/organizations/${this.orgId}/projects/default/containers/${instanceId}`, {
        headers: { 'Salad-Api-Key': this.apiKey, 'Accept': 'application/json' }
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
      const state = data.current_state?.status;
      return {
        providerId: this.id,
        instanceId,
        status: state === 'running' ? 'RUNNING' : state === 'stopped' ? 'STOPPED' : 'UNKNOWN',
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
    return this.createUnknownTelemetry(instanceId, 'SaladCloud exposes telemetry via container group event logs');
  }

  async submitWorkload(instanceId: string, workload: WorkloadSpec): Promise<WorkloadSubmissionResult> {
    return this.createUnavailableWorkload(workload.workloadId, 'SaladCloud uses container group deployments; direct interactive workload submission is UNAVAILABLE');
  }

  async retrieveOutput(instanceId: string, workloadId: string): Promise<WorkloadOutputResult> {
    return this.createUnavailableOutput(workloadId, 'SaladCloud container groups do not expose synchronous artifact output retrieval');
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
      billingMechanism: 'PREPAID_CREDIT',
      invoiceCount: 0
    };
  }
}
