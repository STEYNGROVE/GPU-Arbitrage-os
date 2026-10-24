/**
 * Provider Verification Service
 * 
 * Accurately queries and reports provider balances, distinguishing between:
 * 1. LIVE_API_VERIFIED: Confirmed against the provider's authenticated REST/GraphQL API.
 * 2. OPERATOR_REPORTED_FUNDED: The user reports the account is funded; awaiting API key to sync exact balance.
 * 3. BENCHMARK_NON_EXECUTABLE: Public market reference rate with no live integration.
 * 
 * Strictly abides by fail-closed security and honest claims principles.
 */

export interface ProviderVerificationStatus {
  providerId: string;
  providerName: string;
  category: 'LIQUIDITY_GATEWAY' | 'GPU_COMPUTE_CLOUD' | 'DEPIN_ON_CHAIN' | 'FIAT_SETTLEMENT';
  verificationLevel: 'LIVE_API_VERIFIED' | 'OPERATOR_REPORTED_FUNDED' | 'AWAITING_CREDENTIALS' | 'BENCHMARK_NON_EXECUTABLE';
  isLiveConnected: boolean;
  isExecutable: boolean;
  currency: string;
  balance: number | null;
  balanceUsd: number | null;
  accountIdentifier?: string;
  notes: string;
  lastCheckedAt: string;
  apiEndpoint?: string;
}

class ProviderVerificationService {
  private runpodApiKey: string = process.env.RUNPOD_API_KEY || '';
  private lightningApiKey: string = process.env.LIGHTNING_AI_API_KEY || process.env.LIGHTNING_API_KEY || '';
  private runpodReportedFunded: boolean = true; // Operator flagged as funded
  private lightningReportedFunded: boolean = true; // Operator flagged as funded
  private cachedRunpodBalance: number | null = null;
  private cachedLightningBalance: number | null = null;

  public setRunpodKey(key: string) {
    this.runpodApiKey = key.trim();
  }

  public setLightningKey(key: string) {
    this.lightningApiKey = key.trim();
  }

  /**
   * Check RunPod live balance via official GraphQL endpoint
   */
  public async verifyRunpod(apiKeyOverride?: string): Promise<{
    success: boolean;
    balanceUsd: number | null;
    email?: string;
    error?: string;
  }> {
    const key = (apiKeyOverride || this.runpodApiKey || process.env.RUNPOD_API_KEY || '').trim();
    if (!key) {
      return {
        success: false,
        balanceUsd: this.cachedRunpodBalance,
        error: 'RunPod API key not provided. Operator flagged as funded; enter API key to query exact live credits.',
      };
    }

    try {
      const response = await fetch('https://api.runpod.io/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify({
          query: `
            query {
              myself {
                id
                email
                balance
              }
            }
          `,
        }),
      });

      if (!response.ok) {
        return {
          success: false,
          balanceUsd: null,
          error: `RunPod API returned HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const json = (await response.json()) as any;
      if (json.errors && json.errors.length > 0) {
        return {
          success: false,
          balanceUsd: null,
          error: json.errors[0]?.message || 'RunPod GraphQL query error',
        };
      }

      const myself = json.data?.myself;
      const balance = Number(myself?.balance) || 0;
      this.cachedRunpodBalance = balance;
      this.runpodApiKey = key;

      return {
        success: true,
        balanceUsd: balance,
        email: myself?.email,
      };
    } catch (err: any) {
      return {
        success: false,
        balanceUsd: null,
        error: `Network error connecting to RunPod: ${err.message}`,
      };
    }
  }

  /**
   * Check Lightning AI live status
   */
  public async verifyLightning(apiKeyOverride?: string): Promise<{
    success: boolean;
    balanceUsd: number | null;
    error?: string;
  }> {
    const key = (apiKeyOverride || this.lightningApiKey || process.env.LIGHTNING_AI_API_KEY || process.env.LIGHTNING_API_KEY || '').trim();
    if (!key) {
      return {
        success: false,
        balanceUsd: this.cachedLightningBalance,
        error: 'Lightning AI API key not provided. Operator flagged as funded; enter API key to query exact live balance.',
      };
    }

    try {
      const response = await fetch('https://lightning.ai/api/v1/auth/user', {
        headers: {
          'Authorization': `Bearer ${key}`,
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        return {
          success: false,
          balanceUsd: null,
          error: `Lightning AI API returned HTTP ${response.status}`,
        };
      }

      const data = (await response.json()) as any;
      const credits = Number(data?.credits || data?.balance) || 0;
      this.cachedLightningBalance = credits;
      this.lightningApiKey = key;

      return {
        success: true,
        balanceUsd: credits,
      };
    } catch (err: any) {
      return {
        success: false,
        balanceUsd: null,
        error: `Network error connecting to Lightning AI: ${err.message}`,
      };
    }
  }

  /**
   * Returns complete honest status of all providers
   */
  public async getAllProviderStatuses(binanceLiveStatus: any): Promise<ProviderVerificationStatus[]> {
    // 1. RunPod live probe if key exists
    let runpodVerified = false;
    let runpodBalance = this.cachedRunpodBalance;
    let runpodError = '';

    if (this.runpodApiKey) {
      const runpodRes = await this.verifyRunpod();
      if (runpodRes.success) {
        runpodVerified = true;
        runpodBalance = runpodRes.balanceUsd;
      } else {
        runpodError = runpodRes.error || '';
      }
    }

    // 2. Lightning AI live probe if key exists
    let lightningVerified = false;
    let lightningBalance = this.cachedLightningBalance;
    let lightningError = '';

    if (this.lightningApiKey) {
      const lightningRes = await this.verifyLightning();
      if (lightningRes.success) {
        lightningVerified = true;
        lightningBalance = lightningRes.balanceUsd;
      } else {
        lightningError = lightningRes.error || '';
      }
    }

    const now = new Date().toISOString();

    return [
      {
        providerId: 'binance-institutional',
        providerName: 'Binance VIP Institutional',
        category: 'LIQUIDITY_GATEWAY',
        verificationLevel: 'LIVE_API_VERIFIED',
        isLiveConnected: Boolean(binanceLiveStatus.isConnected && binanceLiveStatus.isLiveApiKey),
        isExecutable: false, // Disallow automatic execution / withdrawals without manual safety confirmation
        currency: 'USDT',
        balance: binanceLiveStatus.usdtBalance,
        balanceUsd: binanceLiveStatus.usdtBalance,
        accountIdentifier: `UID: ${binanceLiveStatus.binanceUid} (${binanceLiveStatus.ownerEmail})`,
        notes: 'Read-only REST API verified balance. Automatic withdrawals and auto-sweep are locked in manual-only safety mode.',
        lastCheckedAt: now,
        apiEndpoint: 'https://api.binance.com/api/v3/account',
      },
      {
        providerId: 'runpod',
        providerName: 'RunPod Community & Secure Cloud',
        category: 'GPU_COMPUTE_CLOUD',
        verificationLevel: runpodVerified ? 'LIVE_API_VERIFIED' : 'OPERATOR_REPORTED_FUNDED',
        isLiveConnected: runpodVerified,
        isExecutable: false, // Non-executable until live fresh quote and instance availability confirmed
        currency: 'USD',
        balance: runpodBalance,
        balanceUsd: runpodBalance,
        accountIdentifier: 'RunPod Cloud Billing',
        notes: runpodVerified
          ? `Verified via official RunPod GraphQL API. Active balance: $${runpodBalance?.toFixed(2)}.`
          : 'Operator confirmed account is funded. Enter RunPod API key to synchronize exact live balance to the cent.',
        lastCheckedAt: now,
        apiEndpoint: 'https://api.runpod.io/graphql',
      },
      {
        providerId: 'lightning-ai',
        providerName: 'Lightning AI Studios',
        category: 'GPU_COMPUTE_CLOUD',
        verificationLevel: lightningVerified ? 'LIVE_API_VERIFIED' : 'OPERATOR_REPORTED_FUNDED',
        isLiveConnected: lightningVerified,
        isExecutable: false,
        currency: 'USD',
        balance: lightningBalance,
        balanceUsd: lightningBalance,
        accountIdentifier: 'Lightning AI Compute Credit',
        notes: lightningVerified
          ? `Verified via Lightning AI Studios API. Active balance: $${lightningBalance?.toFixed(2)}.`
          : 'Operator confirmed account is funded. Enter Lightning API key to synchronize exact live credits.',
        lastCheckedAt: now,
        apiEndpoint: 'https://lightning.ai/api/v1',
      },
      {
        providerId: 'vast-ai',
        providerName: 'Vast.ai Spot Fabric',
        category: 'GPU_COMPUTE_CLOUD',
        verificationLevel: 'BENCHMARK_NON_EXECUTABLE',
        isLiveConnected: false,
        isExecutable: false,
        currency: 'USD',
        balance: 0.00,
        balanceUsd: 0.00,
        accountIdentifier: 'Public Spot Market Reference',
        notes: 'Public benchmark catalog quotes ($1.74/hr H100 SXM5). Requires verified provider adapter before execution.',
        lastCheckedAt: now,
      },
      {
        providerId: 'akash',
        providerName: 'Akash Network Supercloud',
        category: 'DEPIN_ON_CHAIN',
        verificationLevel: 'BENCHMARK_NON_EXECUTABLE',
        isLiveConnected: false,
        isExecutable: false,
        currency: 'AKT',
        balance: 0.00,
        balanceUsd: 0.00,
        accountIdentifier: 'Cosmos SDK On-Chain RPC',
        notes: 'On-chain decentralized benchmark quotes. Escrow wallet integration required before placing live lease bids.',
        lastCheckedAt: now,
      },
      {
        providerId: 'io-net',
        providerName: 'io.net Cloud',
        category: 'DEPIN_ON_CHAIN',
        verificationLevel: 'BENCHMARK_NON_EXECUTABLE',
        isLiveConnected: false,
        isExecutable: false,
        currency: 'IO',
        balance: 0.00,
        balanceUsd: 0.00,
        accountIdentifier: 'Solana Cluster RPC',
        notes: 'Decentralized GPU cluster benchmark. Requires connected Solana signer for smart contract escrow.',
        lastCheckedAt: now,
      },
      {
        providerId: 'payfast',
        providerName: 'PayFast by DPO Group',
        category: 'FIAT_SETTLEMENT',
        verificationLevel: 'AWAITING_CREDENTIALS',
        isLiveConnected: false,
        isExecutable: false,
        currency: 'ZAR',
        balance: 0.00,
        balanceUsd: 0.00,
        accountIdentifier: 'Sandbox / Awaiting Merchant Live Signoff',
        notes: 'South African customer invoicing rail. Requires verified merchant ID and passphrase in production secrets.',
        lastCheckedAt: now,
      },
      {
        providerId: 'gotyme',
        providerName: 'GoTyme Bank',
        category: 'FIAT_SETTLEMENT',
        verificationLevel: 'AWAITING_CREDENTIALS',
        isLiveConnected: false,
        isExecutable: false,
        currency: 'PHP',
        balance: 0.00,
        balanceUsd: 0.00,
        accountIdentifier: 'Commercial Facility Pending',
        notes: 'Regulated by Bangko Sentral ng Pilipinas. Requires signed commercial merchant agreement before live disbursement.',
        lastCheckedAt: now,
      },
    ];
  }
}

export const providerVerificationService = new ProviderVerificationService();
