import crypto from 'crypto';
import { pgDbService } from './pgDatabase.js';
import { ComputeProviderName } from './providerFloatManager.js';
import { auditRepo } from './repositories/index.js';

export interface ProviderFundingEventRecord {
  id: string;
  provider: ComputeProviderName;
  amount: number;
  currency: string;
  timestamp: string;
  externalTransactionReference: string;
  providerAccountId: string;
  binanceReference?: string;
  status: 'PENDING' | 'CONFIRMED' | 'SETTLED' | 'FAILED' | 'REJECTED';
  reconciliationResult: 'RECONCILED' | 'UNRECONCILED' | 'DISCREPANCY';
  fundingType: 'PREPAID_CREDIT' | 'POSTPAID_CARD' | 'ON_DEMAND_HOURLY';
  metadata?: Record<string, any>;
  auditHash: string;
}

export interface ProviderFinancialCapabilities {
  provider: ComputeProviderName;
  configured: boolean;
  capable: boolean;
  billingMechanism: 'PREPAID_CREDIT' | 'POSTPAID_CARD' | 'ON_DEMAND_HOURLY';
  accountId?: string;
  accountEmail?: string;
  currentBalanceUsd?: number;
  creditLimitUsd?: number;
  paymentMethodVerified: boolean;
  canAcceptAutonomousFunding: boolean;
  statusMessage: string;
  lastCheckedAt: string;
}

export interface ProviderFinancialAdapter {
  readonly provider: ComputeProviderName;
  getBillingMechanism(): 'PREPAID_CREDIT' | 'POSTPAID_CARD' | 'ON_DEMAND_HOURLY';
  verifyPaymentCapabilities(): Promise<ProviderFinancialCapabilities>;
  executeRealFunding(params: {
    amountUsd: number;
    idempotencyKey: string;
    binanceReference?: string;
    reason?: string;
  }): Promise<ProviderFundingEventRecord>;
}

/**
 * 1. Vast.ai Financial Adapter:
 * Uses Vast.ai prepaid credit model (credits in USD balance)
 */
export class VastAiFinancialAdapter implements ProviderFinancialAdapter {
  readonly provider: ComputeProviderName = 'vast_ai';
  private apiKey: string;

  constructor() {
    this.apiKey = (process.env.VAST_API_KEY || '').trim();
  }

  getBillingMechanism(): 'PREPAID_CREDIT' | 'POSTPAID_CARD' | 'ON_DEMAND_HOURLY' {
    return 'PREPAID_CREDIT';
  }

  async verifyPaymentCapabilities(): Promise<ProviderFinancialCapabilities> {
    if (!this.apiKey) {
      return {
        provider: this.provider,
        configured: false,
        capable: false,
        billingMechanism: 'PREPAID_CREDIT',
        paymentMethodVerified: false,
        canAcceptAutonomousFunding: false,
        statusMessage: 'VAST_API_KEY is not configured in environment.',
        lastCheckedAt: new Date().toISOString()
      };
    }

    try {
      const res = await fetch('https://console.vast.ai/api/v0/users/current/', {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(8000)
      });

      if (!res.ok) {
        return {
          provider: this.provider,
          configured: true,
          capable: false,
          billingMechanism: 'PREPAID_CREDIT',
          paymentMethodVerified: false,
          canAcceptAutonomousFunding: false,
          statusMessage: `Vast.ai API returned HTTP ${res.status}`,
          lastCheckedAt: new Date().toISOString()
        };
      }

      const data = await res.json();
      const accountId = String(data.id || '');
      const credit = Number(data.credit || 0);
      const capable = Boolean(accountId);

      return {
        provider: this.provider,
        configured: true,
        capable,
        billingMechanism: 'PREPAID_CREDIT',
        accountId,
        accountEmail: data.email,
        currentBalanceUsd: credit,
        paymentMethodVerified: capable,
        canAcceptAutonomousFunding: false, // Provider requires interactive Stripe checkout; automated deposit API is unavailable
        statusMessage: capable
          ? `Vast.ai Account #${accountId} verified (Prepaid Credit Balance: $${credit.toFixed(2)}). Autonomous deposit API is UNAVAILABLE.`
          : 'Vast.ai user data returned empty account ID',
        lastCheckedAt: new Date().toISOString()
      };
    } catch (err: any) {
      return {
        provider: this.provider,
        configured: true,
        capable: false,
        billingMechanism: 'PREPAID_CREDIT',
        paymentMethodVerified: false,
        canAcceptAutonomousFunding: false,
        statusMessage: `Vast.ai capabilities verification failed: ${err.message}`,
        lastCheckedAt: new Date().toISOString()
      };
    }
  }

  async executeRealFunding(params: {
    amountUsd: number;
    idempotencyKey: string;
    binanceReference?: string;
    reason?: string;
  }): Promise<ProviderFundingEventRecord> {
    const caps = await this.verifyPaymentCapabilities();
    if (!caps.capable || !caps.accountId) {
      throw new Error(`VAST_FUNDING_FAILED: Provider capabilities not verified: ${caps.statusMessage}`);
    }

    // Invariant (Requirement 2): Never return CONFIRMED or RECONCILED until provider confirms
    // actual transaction and balance. If no genuine automated deposit API exists, return UNAVAILABLE.
    throw new Error(`PROVIDER_FUNDING_UNAVAILABLE: Provider vast_ai does not expose a programmatic deposit API without interactive Stripe checkout. Funding API is UNAVAILABLE.`);
  }
}

/**
 * 2. RunPod Financial Adapter:
 * Uses RunPod GraphQL billing / client balance / card charge mechanism
 */
export class RunPodFinancialAdapter implements ProviderFinancialAdapter {
  readonly provider: ComputeProviderName = 'runpod';
  private apiKey: string;

  constructor() {
    this.apiKey = (process.env.RUNPOD_API_KEY || '').trim();
  }

  getBillingMechanism(): 'PREPAID_CREDIT' | 'POSTPAID_CARD' | 'ON_DEMAND_HOURLY' {
    return 'PREPAID_CREDIT';
  }

  async verifyPaymentCapabilities(): Promise<ProviderFinancialCapabilities> {
    if (!this.apiKey) {
      return {
        provider: this.provider,
        configured: false,
        capable: false,
        billingMechanism: 'PREPAID_CREDIT',
        paymentMethodVerified: false,
        canAcceptAutonomousFunding: false,
        statusMessage: 'RUNPOD_API_KEY is not configured in environment.',
        lastCheckedAt: new Date().toISOString()
      };
    }

    try {
      const res = await fetch('https://api.runpod.io/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          query: `query { myself { id email clientBalance } }`
        }),
        signal: AbortSignal.timeout(8000)
      });

      if (!res.ok) {
        return {
          provider: this.provider,
          configured: true,
          capable: false,
          billingMechanism: 'PREPAID_CREDIT',
          paymentMethodVerified: false,
          canAcceptAutonomousFunding: false,
          statusMessage: `RunPod API returned HTTP ${res.status}`,
          lastCheckedAt: new Date().toISOString()
        };
      }

      const json = await res.json();
      const myself = json.data?.myself;
      const accountId = String(myself?.id || '');
      const balance = Number(myself?.clientBalance || 0);
      const capable = Boolean(accountId);

      return {
        provider: this.provider,
        configured: true,
        capable,
        billingMechanism: 'PREPAID_CREDIT',
        accountId,
        accountEmail: myself?.email,
        currentBalanceUsd: balance,
        paymentMethodVerified: capable,
        canAcceptAutonomousFunding: false, // Automated deposit API unavailable without web portal checkout
        statusMessage: capable
          ? `RunPod Account ${myself?.email || accountId} verified (Prepaid Balance: $${balance.toFixed(2)}). Automated programmatic deposit API is UNAVAILABLE.`
          : 'RunPod GraphQL response missing user identity',
        lastCheckedAt: new Date().toISOString()
      };
    } catch (err: any) {
      return {
        provider: this.provider,
        configured: true,
        capable: false,
        billingMechanism: 'PREPAID_CREDIT',
        paymentMethodVerified: false,
        canAcceptAutonomousFunding: false,
        statusMessage: `RunPod capabilities verification failed: ${err.message}`,
        lastCheckedAt: new Date().toISOString()
      };
    }
  }

  async executeRealFunding(params: {
    amountUsd: number;
    idempotencyKey: string;
    binanceReference?: string;
    reason?: string;
  }): Promise<ProviderFundingEventRecord> {
    const caps = await this.verifyPaymentCapabilities();
    if (!caps.capable || !caps.accountId) {
      throw new Error(`RUNPOD_FUNDING_FAILED: Provider capabilities not verified: ${caps.statusMessage}`);
    }

    // Invariant (Requirement 2): Never return CONFIRMED or RECONCILED until provider confirms
    // actual transaction and balance. If no genuine automated deposit API exists, return UNAVAILABLE.
    throw new Error(`PROVIDER_FUNDING_UNAVAILABLE: Provider runpod does not expose a programmatic deposit API without interactive web portal checkout. Funding API is UNAVAILABLE.`);
  }
}

/**
 * 3. Lambda Cloud Financial Adapter:
 * Uses Lambda hourly on-demand postpaid billing / account card authorization
 */
export class LambdaFinancialAdapter implements ProviderFinancialAdapter {
  readonly provider: ComputeProviderName = 'lambda';
  private apiKey: string;

  constructor() {
    this.apiKey = (process.env.LAMBDA_API_KEY || '').trim();
  }

  getBillingMechanism(): 'PREPAID_CREDIT' | 'POSTPAID_CARD' | 'ON_DEMAND_HOURLY' {
    return 'ON_DEMAND_HOURLY';
  }

  async verifyPaymentCapabilities(): Promise<ProviderFinancialCapabilities> {
    if (!this.apiKey) {
      return {
        provider: this.provider,
        configured: false,
        capable: false,
        billingMechanism: 'ON_DEMAND_HOURLY',
        paymentMethodVerified: false,
        canAcceptAutonomousFunding: false,
        statusMessage: 'LAMBDA_API_KEY is not configured in environment.',
        lastCheckedAt: new Date().toISOString()
      };
    }

    try {
      const res = await fetch('https://cloud.lambda.ai/api/v1/instance-types', {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(8000)
      });

      if (!res.ok) {
        return {
          provider: this.provider,
          configured: true,
          capable: false,
          billingMechanism: 'ON_DEMAND_HOURLY',
          paymentMethodVerified: false,
          canAcceptAutonomousFunding: false,
          statusMessage: `Lambda API returned HTTP ${res.status}`,
          lastCheckedAt: new Date().toISOString()
        };
      }

      return {
        provider: this.provider,
        configured: true,
        capable: true,
        billingMechanism: 'ON_DEMAND_HOURLY',
        accountId: 'lambda_cloud_auth',
        paymentMethodVerified: true,
        canAcceptAutonomousFunding: false, // Programmatic deposit API unavailable without card checkout
        statusMessage: 'Lambda Cloud API authenticated; authorized for on-demand hourly postpaid billing. Programmatic deposit API is UNAVAILABLE.',
        lastCheckedAt: new Date().toISOString()
      };
    } catch (err: any) {
      return {
        provider: this.provider,
        configured: true,
        capable: false,
        billingMechanism: 'ON_DEMAND_HOURLY',
        paymentMethodVerified: false,
        canAcceptAutonomousFunding: false,
        statusMessage: `Lambda capabilities verification failed: ${err.message}`,
        lastCheckedAt: new Date().toISOString()
      };
    }
  }

  async executeRealFunding(params: {
    amountUsd: number;
    idempotencyKey: string;
    binanceReference?: string;
    reason?: string;
  }): Promise<ProviderFundingEventRecord> {
    const caps = await this.verifyPaymentCapabilities();
    if (!caps.capable) {
      throw new Error(`LAMBDA_FUNDING_FAILED: Provider capabilities not verified: ${caps.statusMessage}`);
    }

    // Invariant (Requirement 2): Never return CONFIRMED or RECONCILED until provider confirms
    // actual transaction and balance. If no genuine automated deposit API exists, return UNAVAILABLE.
    throw new Error(`PROVIDER_FUNDING_UNAVAILABLE: Provider lambda does not expose a programmatic deposit API without interactive credit card authorization. Funding API is UNAVAILABLE.`);
  }
}

/**
 * Central Real Provider Funding Manager:
 * Enforces that internal accounting transfers NEVER mark provider funds as funded
 * without external evidence proving the real transaction occurred.
 */
export class RealProviderFundingManager {
  private adapters: Map<ComputeProviderName, ProviderFinancialAdapter> = new Map();

  constructor() {
    this.adapters.set('vast_ai', new VastAiFinancialAdapter());
    this.adapters.set('runpod', new RunPodFinancialAdapter());
    this.adapters.set('lambda', new LambdaFinancialAdapter());
  }

  getAdapter(provider: ComputeProviderName): ProviderFinancialAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`UNSUPPORTED_PROVIDER: No financial adapter for provider '${provider}'`);
    }
    return adapter;
  }

  async verifyAllCapabilities(): Promise<Record<ComputeProviderName, ProviderFinancialCapabilities>> {
    const [vast, runpod, lambda] = await Promise.all([
      this.getAdapter('vast_ai').verifyPaymentCapabilities(),
      this.getAdapter('runpod').verifyPaymentCapabilities(),
      this.getAdapter('lambda').verifyPaymentCapabilities()
    ]);

    return {
      vast_ai: vast,
      runpod,
      lambda
    };
  }

  /**
   * Executes verified real provider funding and persists the external transaction evidence to PostgreSQL
   */
  async executeRealFunding(params: {
    provider: ComputeProviderName;
    amountUsd: number;
    idempotencyKey: string;
    binanceReference?: string;
    reason?: string;
  }): Promise<ProviderFundingEventRecord> {
    const adapter = this.getAdapter(params.provider);

    // 1. Verify capabilities first
    const caps = await adapter.verifyPaymentCapabilities();
    if (!caps.capable || !caps.canAcceptAutonomousFunding) {
      throw new Error(
        `REAL_FUNDING_BLOCKED: Provider '${params.provider}' payment capabilities not verified: ${caps.statusMessage}`
      );
    }

    // 2. Execute external funding adapter
    const fundingRecord = await adapter.executeRealFunding(params);

    // 3. Persist to authoritative PostgreSQL provider_funding_events
    if (pgDbService.isLiveDatabaseConnected()) {
      await pgDbService.query(
        `INSERT INTO provider_funding_events
          (id, provider, amount, currency, timestamp, external_transaction_reference, provider_account_id, binance_reference, status, reconciliation_result, funding_type, metadata, audit_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [
          fundingRecord.id,
          fundingRecord.provider,
          fundingRecord.amount,
          fundingRecord.currency,
          fundingRecord.timestamp,
          fundingRecord.externalTransactionReference,
          fundingRecord.providerAccountId,
          fundingRecord.binanceReference || null,
          fundingRecord.status,
          fundingRecord.reconciliationResult,
          fundingRecord.fundingType,
          JSON.stringify(fundingRecord.metadata || {}),
          fundingRecord.auditHash
        ]
      );
    }

    // 4. Record audit event
    await auditRepo.recordEvent({
      eventType: 'PROVIDER_REAL_FUNDING_EXECUTED',
      severity: 'INFO',
      message: `Executed real funding of $${fundingRecord.amount.toFixed(2)} to ${fundingRecord.provider} (ext ref: ${fundingRecord.externalTransactionReference})`,
      details: {
        fundingId: fundingRecord.id,
        provider: fundingRecord.provider,
        amount: fundingRecord.amount,
        externalTransactionReference: fundingRecord.externalTransactionReference,
        providerAccountId: fundingRecord.providerAccountId,
        binanceReference: fundingRecord.binanceReference
      }
    });

    return fundingRecord;
  }
}

export const realProviderFundingManager = new RealProviderFundingManager();
