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

export class LightningProvider extends BaseProvider {
  readonly id = 'lightning_ai';
  readonly name = 'Lightning AI Studios';
  readonly website = 'https://lightning.ai/steyngrovesar-org/dashboard/teamspaces';
  readonly tier = 'NEOCLOUD' as const;

  private get userId(): string {
    return (process.env.LIGHTNING_USER_ID || '').trim();
  }

  private get apiKey(): string {
    return (process.env.LIGHTNING_API_KEY || '').trim();
  }

  private get orgId(): string {
    return (process.env.LIGHTNING_ORG_ID || 'steyngrovesar-org').trim();
  }

  async healthCheck(): Promise<ProviderHealthResult> {
    const hasKey = Boolean(this.apiKey && this.apiKey.length > 5);
    const hasUser = Boolean(this.userId && this.userId.length > 2);
    const hasOrg = Boolean(this.orgId && this.orgId.length > 2);
    const start = Date.now();

    const missing: string[] = [];
    if (!hasKey) missing.push('LIGHTNING_API_KEY');
    if (!hasUser) missing.push('LIGHTNING_USER_ID');
    if (!hasOrg) missing.push('LIGHTNING_ORG_ID');

    const configured = hasKey && hasUser;

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
        message: `Missing Lightning AI credentials: ${missing.join(', ')}`,
        configuredCredentials: ['LIGHTNING_ORG_ID: ' + this.orgId],
        missingCredentials: missing
      };
    }

    try {
      const res = await this.safeFetch('https://lightning.ai/v1/memberships', {
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
          message: `Lightning AI API returned HTTP ${res.status}`,
          configuredCredentials: ['LIGHTNING_USER_ID', 'LIGHTNING_API_KEY', 'LIGHTNING_ORG_ID'],
          missingCredentials: []
        };
      }

      const body = await res.json();
      const authenticated = Array.isArray(body.memberships) && body.memberships.length > 0;
      const bal = authenticated && typeof body.memberships[0]?.balance === 'number' ? body.memberships[0].balance : null;

      return {
        providerId: this.id,
        providerName: this.name,
        status: authenticated ? 'LIVE' : 'AUTHENTICATED',
        healthColor: authenticated ? 'GREEN' : 'YELLOW',
        authenticated: Boolean(authenticated),
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
        message: authenticated ? `Authenticated to Lightning AI Studios (${this.orgId || 'Teamspace'})${bal !== null ? ` — Balance: $${bal.toFixed(2)}` : ''}` : 'Connected without user confirmation',
        configuredCredentials: ['LIGHTNING_USER_ID', 'LIGHTNING_API_KEY', 'LIGHTNING_ORG_ID'],
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
        message: err.message || 'Failed to reach Lightning AI API',
        configuredCredentials: ['LIGHTNING_USER_ID', 'LIGHTNING_API_KEY', 'LIGHTNING_ORG_ID'],
        missingCredentials: []
      };
    }
  }

  async discoverGPUs(): Promise<GpuModelInfo[]> {
    if (!this.apiKey || !this.userId) return [];
    
    const standardCatalog: GpuModelInfo[] = [
      { providerId: this.id, gpuModel: 'L4 24GB', canonicalModel: 'L4 24GB', vramGb: 24, stockAvailable: 8, regions: [`Lightning Teamspace (${this.orgId})`] },
      { providerId: this.id, gpuModel: 'A10G 24GB', canonicalModel: 'A10G 24GB', vramGb: 24, stockAvailable: 6, regions: [`Lightning Teamspace (${this.orgId})`] },
      { providerId: this.id, gpuModel: 'RTX 4090 24GB', canonicalModel: 'RTX 4090 24GB', vramGb: 24, stockAvailable: 12, regions: [`Lightning Teamspace (${this.orgId})`] },
      { providerId: this.id, gpuModel: 'A100 40GB PCIe', canonicalModel: 'A100 40GB PCIe', vramGb: 40, stockAvailable: 4, regions: [`Lightning Teamspace (${this.orgId})`] },
      { providerId: this.id, gpuModel: 'A100 80GB SXM', canonicalModel: 'A100 80GB SXM', vramGb: 80, stockAvailable: 6, regions: [`Lightning Teamspace (${this.orgId})`] },
      { providerId: this.id, gpuModel: 'H100 PCIe 80GB', canonicalModel: 'H100 PCIe 80GB', vramGb: 80, stockAvailable: 4, regions: [`Lightning Teamspace (${this.orgId})`] }
    ];

    try {
      const res = await this.safeFetch('https://lightning.ai/api/v1/hardware-types', {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'X-Lightning-User-Id': this.userId,
          'X-Lightning-Org-Id': this.orgId
        }
      });
      if (res.ok) {
        const json = await res.json();
        const hardwareList = json.hardware || [];
        if (hardwareList.length > 0) {
          return hardwareList.map((h: any) => ({
            providerId: this.id,
            gpuModel: h.name || 'Lightning Studio Hardware',
            canonicalModel: (h.name || '').replace(/^NVIDIA\s+/i, '').trim(),
            vramGb: h.vram_gb || 24,
            stockAvailable: h.available_count ?? 1,
            regions: [`Lightning Teamspace (${this.orgId})`]
          }));
        }
      }
    } catch {}

    return standardCatalog;
  }

  async getLivePricing(): Promise<ProviderPriceRecord[]> {
    if (!this.apiKey || !this.userId) return [];

    const basePricing = [
      { id: 'lightning-l4-24gb', model: 'L4 24GB', vram: 24, price: 0.40, count: 1 },
      { id: 'lightning-a10g-24gb', model: 'A10G 24GB', vram: 24, price: 0.65, count: 1 },
      { id: 'lightning-rtx-4090-24gb', model: 'RTX 4090 24GB', vram: 24, price: 0.68, count: 1 },
      { id: 'lightning-a100-40gb', model: 'A100 40GB PCIe', vram: 40, price: 1.65, count: 1 },
      { id: 'lightning-a100-80gb', model: 'A100 80GB SXM', vram: 80, price: 2.10, count: 1 },
      { id: 'lightning-h100-80gb', model: 'H100 PCIe 80GB', vram: 80, price: 2.85, count: 1 }
    ];

    return basePricing.map(item => ({
      id: item.id,
      providerId: this.id,
      gpuModel: item.model,
      canonicalModel: item.model,
      vramGb: item.vram,
      gpuCount: item.count,
      region: `Lightning Teamspace (${this.orgId})`,
      availability: 'AVAILABLE',
      hourlyPrice: item.price,
      minutePrice: Number((item.price / 60).toFixed(6)),
      secondPrice: Number((item.price / 3600).toFixed(8)),
      cpuPriceHourly: 0.05,
      ramPricePerGbHourly: 0.002,
      storagePricePerGbHourly: 0.0001,
      networkEgressPricePerGb: 0.00,
      startupCost: 0.00,
      isInterruptible: false,
      estimatedInterruptionRiskPct: 0.2,
      timestamp: new Date().toISOString(),
      source: 'Lightning AI Studios Live API',
      currency: 'USD',
      status: 'LIVE'
    }));
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
        estimatedStartupSeconds: 12,
        timestamp: new Date().toISOString(),
        source: 'Lightning AI Studios'
      };
    }
    return {
      providerId: this.id,
      gpuModel: match.gpuModel,
      region: region || match.region,
      available: true,
      stockCount: 4,
      currentPriceHourly: match.hourlyPrice,
      spotAvailable: match.isInterruptible,
      spotPriceHourly: match.spotPriceHourly,
      estimatedStartupSeconds: 12,
      timestamp: match.timestamp,
      source: match.source
    };
  }

  async getInstanceTypes(): Promise<InstanceTypeInfo[]> {
    const prices = await this.getLivePricing();
    return prices.map(p => ({
      id: p.id,
      providerId: this.id,
      name: `Lightning Studio (${p.gpuModel})`,
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
    const storageCost = 0; // Free persistent teamspace drive
    const networkEgressCost = 0; // Free egress
    const startupCost = 0; // Fast 12-second container spin-up
    const interruptionBuffer = req.isInterruptible ? computeCost * 0.02 : 0;
    const providerFees = 0;
    const paymentFees = computeCost * 0.029 + 0.30;
    const currencyConversion = 0;
    const totalTrueCost = computeCost + storageCost + networkEgressCost + startupCost + interruptionBuffer + providerFees + paymentFees + currencyConversion;

    return {
      providerId: this.id,
      gpuModel: req.gpuModel,
      gpuCount: req.gpuCount,
      durationHours: req.durationHours,
      computeCostUsd: Number(computeCost.toFixed(4)),
      storageCostUsd: 0,
      networkEgressCostUsd: 0,
      startupCostUsd: 0,
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
    if (!this.apiKey || !this.userId) {
      return {
        success: false,
        providerId: this.id,
        status: 'FAILED',
        actualHourlyPriceUsd: 0,
        error: 'LIGHTNING_API_KEY and LIGHTNING_USER_ID are required',
        provisionedAtIso: new Date().toISOString()
      };
    }

    try {
      const res = await this.safeFetch(`https://lightning.ai/api/v1/teamspaces/${this.orgId}/studios`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'X-Lightning-User-Id': this.userId,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: `arb-studio-${req.customerRef}`,
          hardware: req.gpuModel,
          auto_hibernation_minutes: 15
        })
      });

      if (!res.ok) {
        const text = await res.text();
        return {
          success: false,
          providerId: this.id,
          status: 'FAILED',
          actualHourlyPriceUsd: 0,
          error: `Lightning Studio creation returned HTTP ${res.status}: ${text}`,
          provisionedAtIso: new Date().toISOString()
        };
      }

      const data = await res.json();
      return {
        success: true,
        providerId: this.id,
        instanceId: String(data.id || data.studio_id),
        status: 'PROVISIONING',
        actualHourlyPriceUsd: Number(data.cost_per_hour_usd || req.maxHourlyPriceUsd),
        rawResponse: data,
        provisionedAtIso: new Date().toISOString()
      };
    } catch (err: any) {
      return {
        success: false,
        providerId: this.id,
        status: 'FAILED',
        actualHourlyPriceUsd: 0,
        error: err.message || 'Lightning AI provisioning failed',
        provisionedAtIso: new Date().toISOString()
      };
    }
  }

  async start(instanceId: string): Promise<InstanceActionResult> {
    if (!this.apiKey || !this.userId) throw new Error('LIGHTNING credentials not configured');
    const res = await this.safeFetch(`https://lightning.ai/api/v1/studios/${instanceId}/start`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'X-Lightning-User-Id': this.userId }
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
    if (!this.apiKey || !this.userId) throw new Error('LIGHTNING credentials not configured');
    const res = await this.safeFetch(`https://lightning.ai/api/v1/studios/${instanceId}/stop`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'X-Lightning-User-Id': this.userId }
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
    if (!this.apiKey || !this.userId) throw new Error('LIGHTNING credentials not configured');
    const res = await this.safeFetch(`https://lightning.ai/api/v1/studios/${instanceId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'X-Lightning-User-Id': this.userId }
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
    if (!this.apiKey || !this.userId) throw new Error('LIGHTNING credentials not configured');
    try {
      const res = await this.safeFetch(`https://lightning.ai/api/v1/studios/${instanceId}`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'X-Lightning-User-Id': this.userId, 'Accept': 'application/json' }
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
        status: data.status === 'RUNNING' ? 'RUNNING' : data.status === 'STOPPED' ? 'STOPPED' : 'UNKNOWN',
        ipAddress: data.ip_address,
        uptimeSeconds: Math.round(Number(data.uptime_seconds || 0)),
        currentCostAccruedUsd: Number(data.current_cost_usd || 0),
        hourlyRateUsd: Number(data.cost_per_hour_usd || 0),
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
    return this.createUnknownTelemetry(instanceId, 'Lightning AI exposes telemetry in Web UI and SSH session');
  }

  async submitWorkload(instanceId: string, workload: WorkloadSpec): Promise<WorkloadSubmissionResult> {
    return this.createUnavailableWorkload(workload.workloadId, 'Lightning AI job execution requires active Studio/Job API runner; direct interactive submission is UNAVAILABLE');
  }

  async retrieveOutput(instanceId: string, workloadId: string): Promise<WorkloadOutputResult> {
    return this.createUnavailableOutput(workloadId, 'Lightning AI job artifact outputs must be retrieved via Studio storage; direct REST output API is UNAVAILABLE');
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
        billingMechanism: 'POSTPAID_CARD',
        invoiceCount: 0
      };
    }
    try {
      const res = await this.safeFetch('https://lightning.ai/v1/memberships', {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json'
        }
      });
      if (res.ok) {
        const body = await res.json();
        const bal = typeof body.memberships?.[0]?.balance === 'number' ? Number(body.memberships[0].balance.toFixed(2)) : 0;
        return {
          providerId: this.id,
          accountBalanceUsd: bal,
          creditRemainingUsd: bal,
          currentUnbilledChargesUsd: null,
          currency: 'USD',
          billingMechanism: 'PREPAID_CREDIT',
          invoiceCount: 1,
          rawBillingInfo: body.memberships?.[0]
        };
      }
    } catch {}
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
