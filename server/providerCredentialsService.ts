import fs from 'fs';
import path from 'path';
import { providerRegistry } from './providers/providerRegistry.js';
import { ProviderId, ProviderHealthResult } from './providers/types.js';

export interface ProviderCredentialField {
  key: string;
  label: string;
  placeholder: string;
  isSecret: boolean;
  required: boolean;
  description: string;
}

export interface ProviderSpecDef {
  id: string;
  name: string;
  tier: 'MARKETPLACE' | 'DECENTRALIZED' | 'DISTRIBUTED_EDGE' | 'NEOCLOUD' | 'ENTERPRISE_HYPERSCALER';
  website: string;
  docsUrl: string;
  description: string;
  fields: ProviderCredentialField[];
  sshSupport?: boolean;
}

export interface StoredCredentials {
  canonical: Record<string, Record<string, string>>;
  customProviders: CustomProviderConfig[];
  updatedAt: string;
}

export interface CustomProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  authHeaderName: string;
  authHeaderPrefix: string;
  apiKey: string;
  tier: 'NEOCLOUD' | 'MARKETPLACE' | 'DECENTRALIZED';
  website?: string;
  supportedGpuModels?: string[];
  notes?: string;
  createdAt: string;
}

const STORAGE_FILE_PATH = path.resolve(process.cwd(), 'data', 'provider_credentials.json');

export const CANONICAL_PROVIDERS_SPEC: ProviderSpecDef[] = [
  {
    id: 'lightning_ai',
    name: 'Lightning AI Studios',
    tier: 'NEOCLOUD',
    website: 'https://lightning.ai/steyngrovesar-org/dashboard/teamspaces',
    docsUrl: 'https://lightning.ai/docs/overview/studios',
    description: 'PyTorch Lightning studios, serverless multi-node GPU compute, and dedicated teamspaces (steyngrovesar-org).',
    sshSupport: true,
    fields: [
      {
        key: 'LIGHTNING_API_KEY',
        label: 'Lightning API Key',
        placeholder: 'Enter lightning.ai studio/compute API key...',
        isSecret: true,
        required: true,
        description: 'Generated from Lightning AI Dashboard -> Settings -> API Keys.'
      },
      {
        key: 'LIGHTNING_USER_ID',
        label: 'Lightning User ID',
        placeholder: 'e.g. usr_01h... or username',
        isSecret: false,
        required: true,
        description: 'Your unique Lightning account or member user ID.'
      },
      {
        key: 'LIGHTNING_ORG_ID',
        label: 'Lightning Org / Teamspace ID',
        placeholder: 'steyngrovesar-org',
        isSecret: false,
        required: false,
        description: 'Teamspace slug or Org ID (defaults to steyngrovesar-org).'
      }
    ]
  },
  {
    id: 'vast_ai',
    name: 'Vast.ai',
    tier: 'MARKETPLACE',
    website: 'https://cloud.vast.ai/',
    docsUrl: 'https://cloud.vast.ai/api/',
    description: 'P2P decentralized marketplace with high liquidity on RTX 4090, A100 SXM4, and H100 PCIe.',
    fields: [
      {
        key: 'VAST_API_KEY',
        label: 'Vast.ai API Key',
        placeholder: 'Enter Vast.ai account API key...',
        isSecret: true,
        required: true,
        description: 'From cloud.vast.ai/account/ -> API Key.'
      }
    ]
  },
  {
    id: 'runpod',
    name: 'RunPod',
    tier: 'NEOCLOUD',
    website: 'https://www.runpod.io/',
    docsUrl: 'https://docs.runpod.io/reference/graphql-api',
    description: 'GraphQL-driven cloud compute pods & serverless endpoints with immediate provisioning.',
    fields: [
      {
        key: 'RUNPOD_API_KEY',
        label: 'RunPod API Key',
        placeholder: 'rpa_... or RunPod API key',
        isSecret: true,
        required: true,
        description: 'From runpod.io/console/user/settings -> API Keys.'
      }
    ]
  },
  {
    id: 'tensordock',
    name: 'TensorDock',
    tier: 'MARKETPLACE',
    website: 'https://tensordock.com/',
    docsUrl: 'https://dashboard.tensordock.com/api',
    description: 'API v2 low-cost GPU marketplace across decentralized global datacenters.',
    fields: [
      {
        key: 'TENSORDOCK_API_KEY',
        label: 'TensorDock API Key',
        placeholder: 'Enter TensorDock API v2 key...',
        isSecret: true,
        required: true,
        description: 'TensorDock Dashboard -> API Access -> API Key (v2).'
      },
      {
        key: 'TENSORDOCK_API_TOKEN',
        label: 'TensorDock Token (Optional)',
        placeholder: 'Secondary token if applicable...',
        isSecret: true,
        required: false,
        description: 'Optional secondary authentication token.'
      }
    ]
  },
  {
    id: 'salad',
    name: 'SaladCloud',
    tier: 'DISTRIBUTED_EDGE',
    website: 'https://salad.com/',
    docsUrl: 'https://docs.salad.com/',
    description: 'Residential & edge distributed GPU grid, lowest cost for high-throughput batch inference.',
    fields: [
      {
        key: 'SALAD_API_KEY',
        label: 'Salad API Key',
        placeholder: 'Enter SaladCloud Portal API Key...',
        isSecret: true,
        required: true,
        description: 'From portal.salad.com -> Organization Settings -> API Keys.'
      },
      {
        key: 'SALAD_ORG_ID',
        label: 'Salad Org ID / Slug',
        placeholder: 'e.g. my-salad-org-slug',
        isSecret: false,
        required: false,
        description: 'Salad Organization identifier used in API endpoint path.'
      }
    ]
  },
  {
    id: 'akash',
    name: 'Akash Network',
    tier: 'DECENTRALIZED',
    website: 'https://akash.network/',
    docsUrl: 'https://docs.akash.network/',
    description: 'Cosmos-based decentralized open cloud compute with reverse-auction bidding for GPU tenants.',
    fields: [
      {
        key: 'AKASH_API_KEY',
        label: 'Akash Console / Gateway Token',
        placeholder: 'Enter Akash console access token...',
        isSecret: true,
        required: true,
        description: 'Gateway authentication token or Cloudmos Console token.'
      },
      {
        key: 'AKASH_WALLET_ADDRESS',
        label: 'Akash Wallet Address (Optional)',
        placeholder: 'akash1...',
        isSecret: false,
        required: false,
        description: 'Cosmos Akash tenant wallet address for on-chain escrows.'
      }
    ]
  },
  {
    id: 'hyperstack',
    name: 'Hyperstack',
    tier: 'NEOCLOUD',
    website: 'https://www.hyperstack.cloud/',
    docsUrl: 'https://docs.hyperstack.cloud/',
    description: 'European enterprise GPU neocloud with NexGen green energy data centers.',
    fields: [
      {
        key: 'HYPERSTACK_API_KEY',
        label: 'Hyperstack API Key',
        placeholder: 'Enter Hyperstack API token...',
        isSecret: true,
        required: true,
        description: 'Hyperstack console -> API credentials -> Generate token.'
      }
    ]
  },
  {
    id: 'coreweave',
    name: 'CoreWeave',
    tier: 'ENTERPRISE_HYPERSCALER',
    website: 'https://www.coreweave.com/',
    docsUrl: 'https://docs.coreweave.com/',
    description: 'High-density Kubernetes enterprise GPU cloud with NVLink & InfiniBand fabrics.',
    fields: [
      {
        key: 'COREWEAVE_API_KEY',
        label: 'CoreWeave Token',
        placeholder: 'Enter CoreWeave service account token...',
        isSecret: true,
        required: true,
        description: 'Kubernetes service account token or Cloud API key.'
      },
      {
        key: 'COREWEAVE_NAMESPACE',
        label: 'CoreWeave Namespace (Optional)',
        placeholder: 'e.g. tenant-gpu-prod',
        isSecret: false,
        required: false,
        description: 'Dedicated Kubernetes namespace for resource provisioning.'
      }
    ]
  },
  {
    id: 'lambda',
    name: 'Lambda Cloud',
    tier: 'NEOCLOUD',
    website: 'https://lambdalabs.com/',
    docsUrl: 'https://docs.lambdalabs.com/cloud/api/',
    description: 'Dedicated AI infrastructure and on-demand GPU cloud with 1-click instances.',
    fields: [
      {
        key: 'LAMBDA_API_KEY',
        label: 'Lambda Cloud API Key',
        placeholder: 'secret_...',
        isSecret: true,
        required: true,
        description: 'Lambda console -> API Keys -> Create API Key.'
      }
    ]
  },
  {
    id: 'hostinger',
    name: 'Hostinger GPU',
    tier: 'NEOCLOUD',
    website: 'https://www.hostinger.com/',
    docsUrl: 'https://developers.hostinger.com/',
    description: 'High-availability KVM cloud VPS with dedicated NVIDIA RTX/A100 instances and static IP.',
    fields: [
      {
        key: 'HOSTINGER_API_KEY',
        label: 'Hostinger API Token',
        placeholder: 'Enter Hostinger API Bearer Token...',
        isSecret: true,
        required: true,
        description: 'From hPanel -> Account Settings -> Access Management -> API Tokens.'
      }
    ]
  }
];

class ProviderCredentialsService {
  private inMemoryStore: StoredCredentials = {
    canonical: {},
    customProviders: [],
    updatedAt: new Date().toISOString()
  };

  constructor() {
    this.init();
  }

  public init(): void {
    try {
      const dir = path.dirname(STORAGE_FILE_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (fs.existsSync(STORAGE_FILE_PATH)) {
        const raw = fs.readFileSync(STORAGE_FILE_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as StoredCredentials;
        this.inMemoryStore = {
          canonical: parsed.canonical || {},
          customProviders: parsed.customProviders || [],
          updatedAt: parsed.updatedAt || new Date().toISOString()
        };

        // Hydrate process.env from persistent storage if not already present
        for (const [providerId, fields] of Object.entries(this.inMemoryStore.canonical)) {
          for (const [key, val] of Object.entries(fields)) {
            if (val && !process.env[key]) {
              process.env[key] = val;
            }
          }
        }

        // Also ingest any active process.env keys into persistent store
        let storeUpdated = false;
        for (const spec of CANONICAL_PROVIDERS_SPEC) {
          for (const field of spec.fields) {
            const envVal = (process.env[field.key] || '').trim();
            if (envVal) {
              if (!this.inMemoryStore.canonical[spec.id]) {
                this.inMemoryStore.canonical[spec.id] = {};
              }
              if (this.inMemoryStore.canonical[spec.id][field.key] !== envVal) {
                this.inMemoryStore.canonical[spec.id][field.key] = envVal;
                storeUpdated = true;
              }
            }
          }
        }
        if (storeUpdated) {
          this.persist();
        }
      }
    } catch (err) {
      console.warn('[ProviderCredentialsService] Note: Could not read credentials file, using process.env:', err);
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(STORAGE_FILE_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.inMemoryStore.updatedAt = new Date().toISOString();
      fs.writeFileSync(STORAGE_FILE_PATH, JSON.stringify(this.inMemoryStore, null, 2), 'utf-8');
    } catch (err) {
      console.error('[ProviderCredentialsService] Failed to persist credentials:', err);
    }
  }

  private maskSecret(val: string): string {
    if (!val || val.length === 0) return '';
    if (val.length <= 6) return '••••••';
    const start = val.slice(0, 3);
    const end = val.slice(-3);
    return `${start}••••••••${end}`;
  }

  /**
   * Get all provider configurations with masked values and current health state
   */
  public async getAllProvidersSummary(): Promise<{
    providers: any[];
    customProviders: any[];
    stats: {
      total: number;
      configured: number;
      live: number;
      unconfigured: number;
    };
  }> {
    const healthMap = await providerRegistry.runHealthChecks();

    let configuredCount = 0;
    let liveCount = 0;

    const providers = await Promise.all(
      CANONICAL_PROVIDERS_SPEC.map(async spec => {
        const health = healthMap[spec.id as ProviderId] || {
          providerId: spec.id,
          providerName: spec.name,
          status: 'CONFIGURATION_REQUIRED',
          healthColor: 'GREY',
          authenticated: false,
          latencyMs: 0,
          message: 'No health check data',
          endpoints: { authentication: false, pricing: false, inventory: false, provisioning: false, instanceControl: false, telemetry: false, billing: false },
          lastCheckIso: new Date().toISOString(),
          configuredCredentials: [],
          missingCredentials: []
        };

        const fieldValues: Record<string, { value: string; masked: string; isSet: boolean }> = {};
        let allRequiredSet = true;

        for (const field of spec.fields) {
          // Read either from process.env or stored credentials
          const currentVal = (process.env[field.key] || this.inMemoryStore.canonical[spec.id]?.[field.key] || '').trim();
          const isSet = currentVal.length > 0;
          if (field.required && !isSet) {
            allRequiredSet = false;
          }

          fieldValues[field.key] = {
            value: field.isSecret ? '' : currentVal, // never return plain text secrets
            masked: field.isSecret ? this.maskSecret(currentVal) : currentVal,
            isSet
          };
        }

        if (allRequiredSet) configuredCount++;
        if (health.status === 'LIVE' || health.status === 'AUTHENTICATED') liveCount++;

        let billingInfo: {
          balanceUsd: number | null;
          formatted: string;
          mechanism: string;
          isFunded: boolean;
        } = {
          balanceUsd: null,
          formatted: 'UNFUNDED ($0.00)',
          mechanism: 'PREPAID_CREDIT',
          isFunded: false
        };

        const providerInst = providerRegistry.getProvider(spec.id as ProviderId);
        if (providerInst && (health.status === 'LIVE' || health.status === 'AUTHENTICATED')) {
          try {
            const b = await providerInst.getBilling();
            const bal = b.accountBalanceUsd ?? b.creditRemainingUsd ?? null;
            if (bal !== null && bal > 0) {
              billingInfo = {
                balanceUsd: bal,
                formatted: `$${bal.toFixed(2)}`,
                mechanism: b.billingMechanism,
                isFunded: true
              };
            } else if (bal === 0) {
              billingInfo = {
                balanceUsd: 0,
                formatted: '$0.00',
                mechanism: b.billingMechanism,
                isFunded: false
              };
            }
          } catch {
            // fallback
          }
        }

        return {
          ...spec,
          health,
          isConfigured: allRequiredSet,
          fieldValues,
          billing: billingInfo
        };
      })
    );

    const customProviders = (this.inMemoryStore.customProviders || []).map(cp => ({
      ...cp,
      apiKeyMasked: this.maskSecret(cp.apiKey)
    }));

    return {
      providers,
      customProviders,
      stats: {
        total: CANONICAL_PROVIDERS_SPEC.length + customProviders.length,
        configured: configuredCount,
        live: liveCount,
        unconfigured: CANONICAL_PROVIDERS_SPEC.length - configuredCount
      }
    };
  }

  /**
   * Save credentials for a canonical provider
   */
  public async saveCanonicalCredentials(
    providerId: string,
    fieldUpdates: Record<string, string>
  ): Promise<{ success: boolean; message: string; health: ProviderHealthResult }> {
    const spec = CANONICAL_PROVIDERS_SPEC.find(s => s.id === providerId);
    if (!spec) {
      throw new Error(`Unknown provider ID: ${providerId}`);
    }

    if (!this.inMemoryStore.canonical[providerId]) {
      this.inMemoryStore.canonical[providerId] = {};
    }

    for (const [key, val] of Object.entries(fieldUpdates)) {
      if (typeof val === 'string' && val.trim().length > 0) {
        const trimmed = val.trim();
        process.env[key] = trimmed;
        this.inMemoryStore.canonical[providerId][key] = trimmed;
      }
    }

    this.persist();

    // Trigger immediate health check for this provider
    const provider = providerRegistry.getProvider(providerId as ProviderId);
    let health: ProviderHealthResult;
    if (provider) {
      try {
        health = await provider.healthCheck();
      } catch (err: any) {
        health = {
          providerId: spec.id as ProviderId,
          providerName: spec.name,
          status: 'ERROR',
          healthColor: 'RED',
          authenticated: false,
          latencyMs: 0,
          endpoints: { authentication: false, pricing: false, inventory: false, provisioning: false, instanceControl: false, telemetry: false, billing: false },
          lastCheckIso: new Date().toISOString(),
          message: err.message || 'Health check failed',
          configuredCredentials: [],
          missingCredentials: []
        };
      }
    } else {
      health = {
        providerId: spec.id as ProviderId,
        providerName: spec.name,
        status: 'CONFIGURATION_REQUIRED',
        healthColor: 'GREY',
        authenticated: false,
        latencyMs: 0,
        endpoints: { authentication: false, pricing: false, inventory: false, provisioning: false, instanceControl: false, telemetry: false, billing: false },
        lastCheckIso: new Date().toISOString(),
        message: 'Provider not initialized in registry',
        configuredCredentials: [],
        missingCredentials: []
      };
    }

    return {
      success: true,
      message: `Credentials updated for ${spec.name}. Status: ${health.status}`,
      health
    };
  }

  /**
   * Test connection using provided or existing credentials
   */
  public async testProviderConnection(
    providerId: string,
    tempFields?: Record<string, string>
  ): Promise<{ success: boolean; latencyMs: number; status: string; message: string; details?: any }> {
    // If tempFields provided, temporarily set env vars to test
    const originalEnv: Record<string, string | undefined> = {};
    if (tempFields) {
      for (const [key, val] of Object.entries(tempFields)) {
        if (typeof val === 'string' && val.trim().length > 0) {
          originalEnv[key] = process.env[key];
          process.env[key] = val.trim();
        }
      }
    }

    try {
      const provider = providerRegistry.getProvider(providerId as ProviderId);
      if (!provider) {
        return {
          success: false,
          latencyMs: 0,
          status: 'ERROR',
          message: `Provider ${providerId} is not registered in the provider registry.`
        };
      }

      const start = Date.now();
      const health = await provider.healthCheck();
      const latencyMs = Date.now() - start;

      const success = health.status === 'LIVE' || health.status === 'AUTHENTICATED';

      return {
        success,
        latencyMs,
        status: health.status,
        message: health.message,
        details: {
          authenticated: health.authenticated,
          healthColor: health.healthColor,
          endpoints: health.endpoints,
          missingCredentials: health.missingCredentials
        }
      };
    } finally {
      // Restore original env if tempFields was used
      if (tempFields) {
        for (const [key, origVal] of Object.entries(originalEnv)) {
          if (origVal === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = origVal;
          }
        }
      }
    }
  }

  /**
   * Add a custom GPU provider not yet in canonical 10
   */
  public addCustomProvider(config: Omit<CustomProviderConfig, 'createdAt'>): CustomProviderConfig {
    const existingIdx = this.inMemoryStore.customProviders.findIndex(c => c.id === config.id);
    const newEntry: CustomProviderConfig = {
      ...config,
      createdAt: new Date().toISOString()
    };

    if (existingIdx >= 0) {
      this.inMemoryStore.customProviders[existingIdx] = newEntry;
    } else {
      this.inMemoryStore.customProviders.push(newEntry);
    }

    this.persist();
    return newEntry;
  }

  /**
   * Remove custom provider
   */
  public deleteCustomProvider(id: string): boolean {
    const initialLen = this.inMemoryStore.customProviders.length;
    this.inMemoryStore.customProviders = this.inMemoryStore.customProviders.filter(c => c.id !== id);
    if (this.inMemoryStore.customProviders.length !== initialLen) {
      this.persist();
      return true;
    }
    return false;
  }
}

export const providerCredentialsService = new ProviderCredentialsService();
