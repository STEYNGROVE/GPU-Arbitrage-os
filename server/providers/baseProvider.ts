import {
  GPUProvider,
  ProviderId,
  ProviderHealthResult,
  ProviderStatus,
  HealthColor,
  CostEstimateRequest,
  CostEstimateResult,
  ProviderTelemetryResult
} from './types.js';

export abstract class BaseProvider implements GPUProvider {
  abstract readonly id: ProviderId;
  abstract readonly name: string;
  abstract readonly website: string;
  abstract readonly tier: 'MARKETPLACE' | 'DECENTRALIZED' | 'DISTRIBUTED_EDGE' | 'NEOCLOUD' | 'ENTERPRISE_HYPERSCALER';

  abstract discoverGPUs(): Promise<any>;
  abstract getLivePricing(): Promise<any>;
  abstract getAvailability(gpuModel: string, region?: string): Promise<any>;
  abstract getInstanceTypes(): Promise<any>;
  abstract estimateCost(req: CostEstimateRequest): Promise<CostEstimateResult>;
  abstract provision(req: any): Promise<any>;
  abstract start(instanceId: string): Promise<any>;
  abstract stop(instanceId: string): Promise<any>;
  abstract restart(instanceId: string): Promise<any>;
  abstract terminate(instanceId: string): Promise<any>;
  abstract getInstanceStatus(instanceId: string): Promise<any>;
  abstract getTelemetry(instanceId: string): Promise<ProviderTelemetryResult>;
  abstract submitWorkload(instanceId: string, workload: any): Promise<any>;
  abstract retrieveOutput(instanceId: string, workloadId: string): Promise<any>;
  abstract getUsage(instanceId: string): Promise<any>;
  abstract getBilling(): Promise<any>;
  abstract healthCheck(): Promise<ProviderHealthResult>;

  /**
   * Safe fetch with strict timeout and no credential leakage
   */
  protected async safeFetch(url: string, options: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      return res;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`Connection to ${this.name} timed out after ${timeoutMs}ms`);
      }
      // Sanitize message to strip API keys or query params
      const sanitized = (err.message || 'Unknown network error').replace(/([?&][a-zA-Z0-9_]*=)[^&]*/g, '$1[REDACTED]');
      throw new Error(`Network failure connecting to ${this.name}: ${sanitized}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Mask credentials for display
   */
  protected maskSecret(secret?: string): string {
    if (!secret || secret.trim().length === 0) return 'NOT_CONFIGURED';
    const clean = secret.trim();
    if (clean.length <= 8) return '****';
    return `${clean.substring(0, 4)}...${clean.substring(clean.length - 4)}`;
  }

  /**
   * Generate an unknown telemetry response (Fail closed: No fake telemetry)
   */
  protected createUnknownTelemetry(instanceId: string, reason = 'Telemetry unavailable from provider'): ProviderTelemetryResult {
    return {
      providerId: this.id,
      instanceId,
      timestamp: new Date().toISOString(),
      isVerified: false,
      source: 'UNKNOWN',
      gpuUtilizationPct: null,
      gpuTemperatureC: null,
      vramUsedGb: null,
      vramTotalGb: null,
      powerWatts: null,
      cpuUtilizationPct: null,
      ramUsedGb: null,
      diskUsedGb: null,
      networkInMbps: null,
      networkOutMbps: null,
      accruedCostUsd: null,
      errorCount: 0,
      rawTelemetry: { error: reason }
    };
  }

  /**
   * Standardized health color evaluation
   */
  protected determineHealthColor(status: ProviderStatus, authenticated: boolean): HealthColor {
    if (status === 'LIVE') return 'GREEN';
    if (status === 'AUTHENTICATED' || status === 'PARTIAL' || status === 'DISCOVERY_ONLY') return 'YELLOW';
    if (status === 'CONFIGURATION_REQUIRED' || status === 'UNVERIFIED') return 'GREY';
    return 'RED';
  }

  /**
   * Fail closed workload response when provider API does not natively support direct workload submission
   */
  protected createUnavailableWorkload(workloadId: string, reason = 'Workload submission API not natively supported by provider'): any {
    return {
      success: false,
      workloadId,
      providerId: this.id,
      status: 'UNAVAILABLE',
      submittedAtIso: new Date().toISOString(),
      error: reason
    };
  }

  /**
   * Fail closed output response when provider API does not natively support direct artifact retrieval
   */
  protected createUnavailableOutput(workloadId: string, reason = 'Workload output API not natively supported by provider'): any {
    return {
      workloadId,
      providerId: this.id,
      status: 'UNAVAILABLE',
      outputArtifactUrls: [],
      error: reason
    };
  }
}
