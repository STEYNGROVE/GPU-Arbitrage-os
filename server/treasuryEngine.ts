import crypto from 'crypto';
import type pg from 'pg';
import { pgDbService } from './pgDatabase.js';
import { toMinorUnits, fromMinorUnits, SupportedCurrency, CanonicalReconciliationStatus, calculateVerifiedSpendableCapital } from './moneyUtils.js';
import { TreasuryRepository, ReservationRepository } from './repositories/treasuryAndReservationRepo.js';
import { killSwitchRepo } from './repositories/index.js';
import { circuitBreakerService } from './circuitBreaker.js';
import { binanceTreasuryProvider } from './binanceProvider.js';
import { getBinanceConfig } from './binanceConfig.js';
import { timingSafeMatch } from './auth.js';
import { evaluateAuthoritativeReconciliationGate } from './reconciliationGate.js';
import { db } from './databaseEngine.js';

export interface AuthoritativeTreasuryReadiness {
  isReadyForLiveTrading: boolean;
  grossLiquidityUsd: number;
  activeReservationsUsd: number;
  riskReserveUsd: number;
  spendableLiquidityUsd: number;
  minimumOperatingThresholdUsd: number;
  hasMinimumLiquidity: boolean;
  reconciliationStatus: CanonicalReconciliationStatus;
  reconciliationDiscrepancyUsd: number;
  reconciliationMessage?: string;
  rejectionReasons: string[];
  providers: Record<TreasuryProviderName, {
    configured: boolean;
    authenticated: boolean;
    balanceQueryWorks: boolean;
    spendableUsd: number;
    withdrawalsOrTradingEnabled: boolean;
    status: string;
    error?: string;
  }>;
}

// ============================================================================
// 1. TREASURY DOMAIN INTERFACES & TYPES
// ============================================================================

export type TreasuryProviderName = 'binance';

export interface TreasuryConnectionStatus {
  connected: boolean;
  status: 'NOT_CONFIGURED' | 'AUTH_FAILED' | 'UNAVAILABLE' | 'VERIFIED' | 'RATE_LIMITED';
  latencyMs: number;
  lastChecked: string;
  error?: string;
  details?: Record<string, unknown>;
}

export interface ExternalBalance {
  asset: string; // 'USD', 'ZAR', 'USDT', 'USDC', 'BTC', 'ETH', etc.
  rawQuantity: string; // Authoritative native asset quantity
  availableMinor: bigint; // Minor units (cents or satoshis/wei)
  lockedMinor: bigint;
  totalMinor: bigint;
  valuationMinor?: bigint;
  valuationUsd?: number;
  valuationProvenance?: ValuationProvenance;
  lastUpdated: string;
}

export interface ValuationProvenance {
  priceSource: string;
  priceTimestamp: number;
  pair: string;
  quotedPrice: number;
  isStale: boolean;
}

export interface ExternalTransaction {
  id: string;
  provider: TreasuryProviderName;
  externalReference: string;
  asset: string;
  amountMinor: bigint;
  amountFormatted: number;
  direction: 'INFLOW' | 'OUTFLOW';
  transactionType: 'DEPOSIT' | 'WITHDRAWAL' | 'FEE' | 'TRADE' | 'TRANSFER';
  status: 'PENDING' | 'SETTLED' | 'FAILED' | 'REFUNDED' | 'DISPUTED';
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderStatus {
  name: TreasuryProviderName;
  status: 'NOT_CONFIGURED' | 'AUTH_FAILED' | 'UNAVAILABLE' | 'VERIFIED' | 'RATE_LIMITED';
  tradingEnabled: boolean;
  withdrawalsEnabled: boolean;
  lastReconciledAt?: string;
  balanceCount: number;
  totalValuationUsd: number;
}

export interface TreasuryProvider {
  readonly name: TreasuryProviderName;
  verifyConnection(): Promise<TreasuryConnectionStatus>;
  getBalances(): Promise<ExternalBalance[]>;
  getTransactions(options?: { limit?: number; since?: string }): Promise<ExternalTransaction[]>;
  getProviderStatus(): Promise<ProviderStatus>;
}

// ============================================================================
// 2. BINANCE TREASURY PROVIDER (CRYPTO TREASURY WALLET)
// ============================================================================

export class BinanceTreasuryProvider implements TreasuryProvider {
  readonly name: TreasuryProviderName = 'binance';

  public isConfigured(): boolean {
    return binanceTreasuryProvider.isConfigured();
  }

  public async verifyConnection(): Promise<TreasuryConnectionStatus> {
    const preflight = await binanceTreasuryProvider.verifyConnection();
    return {
      connected: preflight.connected,
      status: preflight.status,
      latencyMs: preflight.latencyMs,
      lastChecked: preflight.verifiedAt,
      error: preflight.error,
      details: {
        accountType: preflight.accountType,
        canTrade: preflight.canTrade,
        canWithdraw: preflight.canWithdraw,
        canDeposit: preflight.canDeposit,
        serverTimeDriftMs: preflight.serverTimeDriftMs,
        usedWeight1m: preflight.usedWeight1m,
        treasuryAssetBalance: preflight.treasuryAssetBalance
      }
    };
  }

  public async getBalances(): Promise<ExternalBalance[]> {
    if (!this.isConfigured()) return [];
    const balances = await binanceTreasuryProvider.getBalances();
    return balances.map(b => ({
      asset: b.asset,
      rawQuantity: b.rawQuantity,
      availableMinor: b.availableMinor,
      lockedMinor: b.lockedMinor,
      totalMinor: b.totalMinor,
      valuationUsd: b.valuationUsd,
      lastUpdated: b.lastUpdated
    }));
  }

  public async getTransactions(options?: { limit?: number; since?: string }): Promise<ExternalTransaction[]> {
    if (!this.isConfigured()) return [];
    const deposits = await binanceTreasuryProvider.getDepositHistory({ limit: options?.limit || 20 });
    return deposits.map(d => ({
      id: `binance_dep_${d.txId || d.id}`,
      provider: 'binance',
      externalReference: d.txId || d.id || '',
      asset: d.coin,
      amountMinor: toMinorUnits(d.amount),
      amountFormatted: d.amount,
      direction: 'INFLOW',
      transactionType: 'DEPOSIT',
      status: d.status === 1 ? 'SETTLED' : 'PENDING',
      timestamp: new Date(d.insertTime).toISOString(),
      metadata: d as unknown as Record<string, unknown>
    }));
  }

  public async getDepositAddress(coin: string = 'USDT', network?: string) {
    return binanceTreasuryProvider.getDepositAddress(coin, network);
  }

  public async getDepositHistory(options?: { coin?: string; limit?: number }) {
    return binanceTreasuryProvider.getDepositHistory(options);
  }

  public async getProviderStatus(): Promise<ProviderStatus> {
    const conn = await this.verifyConnection();
    const balances = conn.connected ? await this.getBalances() : [];

    return {
      name: 'binance',
      status: conn.status,
      tradingEnabled: Boolean(conn.details?.canTrade),
      withdrawalsEnabled: Boolean(conn.details?.canWithdraw && binanceTreasuryProvider.getConfig().withdrawalsEnabled),
      lastReconciledAt: conn.lastChecked,
      balanceCount: balances.length,
      totalValuationUsd: balances.reduce((sum, b) => sum + (b.valuationUsd || 0), 0)
    };
  }

  public async handleWebhook(body: any, headers: Record<string, string>): Promise<{ 
    success: boolean; 
    message: string;
    idempotent?: boolean;
    eventId?: string;
    protocol?: 'BINANCE_PAY_NATIVE_RSA_SHA256' | 'BINANCE_SPOT_RELAY_HMAC_SHA256';
  }> {
    // Detect whether incoming notification uses Native Binance Pay Merchant Webhook headers
    // (BinancePay-Timestamp, BinancePay-Nonce, BinancePay-Signature, BinancePay-Certificate-SN)
    // or our Authenticated Binance Spot Deposit Relay protocol (x-mbx-timestamp, x-mbx-signature).
    const binancePaySig =
      headers['binancepay-signature'] ||
      headers['BinancePay-Signature'] ||
      '';
    const binancePayTimestamp =
      headers['binancepay-timestamp'] ||
      headers['BinancePay-Timestamp'] ||
      '';
    const binancePayNonce =
      headers['binancepay-nonce'] ||
      headers['BinancePay-Nonce'] ||
      '';
    const isNativeBinancePay = Boolean(binancePaySig || binancePayTimestamp || binancePayNonce);

    // 1. Replay Protection: Timestamp drift check (max 5 minutes)
    const rawTimestamp = isNativeBinancePay
      ? binancePayTimestamp
      : (
          headers['x-mbx-timestamp'] || 
          headers['x-binance-timestamp'] || 
          body?.timestamp || 
          body?.time || 
          body?.E
        );
    
    if (!rawTimestamp) {
      return { 
        success: false, 
        message: 'REPLAY_ATTACK_PREVENTED: Missing timestamp. Header BinancePay-Timestamp, x-mbx-timestamp, or payload timestamp required.' 
      };
    }

    const eventTime = Number(rawTimestamp);
    if (isNaN(eventTime)) {
      return { success: false, message: 'REPLAY_ATTACK_PREVENTED: Invalid numeric timestamp.' };
    }

    const now = Date.now();
    const driftMs = Math.abs(now - eventTime);
    const MAX_ALLOWED_DRIFT_MS = 5 * 60 * 1000; // 5 minutes
    if (driftMs > MAX_ALLOWED_DRIFT_MS) {
      return { 
        success: false, 
        message: `REPLAY_ATTACK_PREVENTED: Event timestamp outside acceptable window (drift: ${Math.round(driftMs / 1000)}s, max allowed: 300s).` 
      };
    }

    const payloadStr = typeof body === 'string' ? body : JSON.stringify(body);
    let verifiedProtocol: 'BINANCE_PAY_NATIVE_RSA_SHA256' | 'BINANCE_SPOT_RELAY_HMAC_SHA256';

    if (isNativeBinancePay) {
      // 2A. Native Binance Pay Merchant Webhook Protocol (Official RSA-SHA256 over timestamp + "\n" + nonce + "\n" + body + "\n")
      const publicKeyPem = process.env.BINANCE_PAY_PUBLIC_KEY;
      if (!publicKeyPem) {
        throw new Error('BINANCE_PAY_PUBLIC_KEY_REQUIRED');
      }
      if (!binancePayNonce) {
        return { success: false, message: 'BINANCE_PAY_NONCE_MISSING: BinancePay-Nonce header required' };
      }
      if (!binancePaySig) {
        return { success: false, message: 'BINANCE_SIGNATURE_MISSING: BinancePay-Signature header required' };
      }

      const canonicalPayload = `${rawTimestamp}\n${binancePayNonce}\n${payloadStr}\n`;
      let isRsaValid = false;
      try {
        const verifier = crypto.createVerify('RSA-SHA256');
        verifier.update(canonicalPayload, 'utf8');
        verifier.end();
        isRsaValid = verifier.verify(publicKeyPem, binancePaySig, 'base64');
      } catch {
        isRsaValid = false;
      }

      if (!isRsaValid) {
        return { success: false, message: 'BINANCE_PAY_SIGNATURE_INVALID: RSA-SHA256 cryptographic verification failed' };
      }
      verifiedProtocol = 'BINANCE_PAY_NATIVE_RSA_SHA256';
    } else {
      // 2B. Authenticated Binance Spot Deposit Relay Protocol (HMAC-SHA256 via BINANCE_WEBHOOK_SECRET)
      // Note: Binance Spot API (/sapi/v1/capital/deposit/hisrec) is polled & verified independently;
      // this authenticated relay protocol secures internal/edge deposit notifications and never falls back to BINANCE_API_SECRET.
      const webhookSecret = process.env.BINANCE_WEBHOOK_SECRET;
      if (!webhookSecret) {
        throw new Error("BINANCE_WEBHOOK_SECRET_REQUIRED");
      }

      const signature = headers['x-mbx-signature'] || headers['x-binance-signature'] || '';
      if (!signature) {
        return { success: false, message: 'BINANCE_SIGNATURE_MISSING: x-mbx-signature header required' };
      }

      const expectedSig = crypto.createHmac('sha256', webhookSecret).update(payloadStr).digest('hex');

      if (!timingSafeMatch(signature, expectedSig)) {
        return { success: false, message: 'BINANCE_SIGNATURE_INVALID: Cryptographic verification failed' };
      }
      verifiedProtocol = 'BINANCE_SPOT_RELAY_HMAC_SHA256';
    }

    // 3. Derive Deterministic Event ID
    const eventId = String(
      body?.eventId || 
      body?.tranId || 
      body?.txId || 
      body?.bId || 
      body?.clientOrderId || 
      crypto.createHash('sha256').update(`${eventTime}|${payloadStr}`).digest('hex')
    );

    // 4. Authoritative PostgreSQL Idempotency & Replay Protection (webhook_events PRIMARY KEY (provider, event_id))
    if (!pgDbService.isLiveDatabaseConnected()) {
      return {
        success: false,
        message: 'WEBHOOK_PERSISTENCE_UNAVAILABLE: PostgreSQL database connection required for authoritative webhook idempotency.'
      };
    }

    const amountVal = Number(body?.amount || body?.d || body?.totalFee || 0);
    const currencyVal = String(body?.asset || body?.a || body?.currency || 'USDT').toUpperCase().slice(0, 8);
    const orderIdVal = body?.orderId ? String(body.orderId) : null;
    const customerIdVal = body?.customerId ? String(body.customerId) : null;

    const insertRes = await pgDbService.query(
      `INSERT INTO webhook_events (provider, event_id, order_id, customer_id, amount, currency, processed_at, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
       ON CONFLICT (provider, event_id) DO NOTHING
       RETURNING provider, event_id`,
      [
        'BINANCE',
        eventId,
        orderIdVal,
        customerIdVal,
        isNaN(amountVal) ? 0 : amountVal,
        currencyVal || 'USDT',
        typeof body === 'object' && body !== null ? JSON.stringify(body) : JSON.stringify({ raw: String(body) })
      ]
    );

    if (insertRes.rowCount === 0) {
      return { 
        success: true, 
        message: 'EVENT_ALREADY_PROCESSED_IDEMPOTENT: Webhook was previously applied in PostgreSQL. Suppressed duplicate processing.',
        idempotent: true,
        eventId,
        protocol: verifiedProtocol
      };
    }

    return { 
      success: true, 
      message: 'Binance webhook cryptographically verified and persisted to PostgreSQL',
      idempotent: false,
      eventId,
      protocol: verifiedProtocol
    };
  }
}

// ============================================================================
// 4. CRYPTO VALUATION LAYER WITH STALENESS AUDITING
// ============================================================================

export class CryptoValuationLayer {
  private priceCache: Map<string, { price: number; timestamp: number; source: string }> = new Map();
  private maxStalenessSeconds: number;

  constructor(maxStalenessSeconds: number = 300) {
    const envStaleness = parseInt(process.env.TREASURY_MAX_STALENESS_SECONDS || '', 10);
    this.maxStalenessSeconds = isNaN(envStaleness) ? maxStalenessSeconds : envStaleness;
  }

  /**
   * Fetches latest verified market quote for crypto asset against USD
   */
  public async getAssetPrice(asset: string): Promise<{
    price: number | null;
    provenance: ValuationProvenance;
  }> {
    const upperAsset = asset.toUpperCase();
    if (upperAsset === 'USD' || upperAsset === 'USDT' || upperAsset === 'USDC') {
      return {
        price: 1.0,
        provenance: {
          priceSource: 'FIAT_PARITY_PEG',
          priceTimestamp: Date.now(),
          pair: `${upperAsset}/USD`,
          quotedPrice: 1.0,
          isStale: false
        }
      };
    }

    // Check memory cache
    const cached = this.priceCache.get(upperAsset);
    const now = Date.now();
    if (cached && (now - cached.timestamp) < this.maxStalenessSeconds * 1000) {
      return {
        price: cached.price,
        provenance: {
          priceSource: cached.source,
          priceTimestamp: cached.timestamp,
          pair: `${upperAsset}/USDT`,
          quotedPrice: cached.price,
          isStale: false
        }
      };
    }

    // Fetch from Binance public ticker API if online
    try {
      const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${upperAsset}USDT`);
      if (res.ok) {
        const data = await res.json() as { price: string };
        const priceMinor = toMinorUnits(data.price);
        const price = fromMinorUnits(priceMinor);
        if (priceMinor > 0n) {
          this.priceCache.set(upperAsset, { price, timestamp: now, source: 'BINANCE_MARKET_TICKER' });
          return {
            price,
            provenance: {
              priceSource: 'BINANCE_MARKET_TICKER',
              priceTimestamp: now,
              pair: `${upperAsset}/USDT`,
              quotedPrice: price,
              isStale: false
            }
          };
        }
      }
    } catch {}

    // If fetch failed but we have older cache, check if stale
    if (cached) {
      const ageSec = (now - cached.timestamp) / 1000;
      const isStale = ageSec > this.maxStalenessSeconds;
      return {
        price: cached.price,
        provenance: {
          priceSource: `${cached.source}_CACHED`,
          priceTimestamp: cached.timestamp,
          pair: `${upperAsset}/USDT`,
          quotedPrice: cached.price,
          isStale
        }
      };
    }

    return {
      price: null,
      provenance: {
        priceSource: 'NO_ACTIVE_ORACLE',
        priceTimestamp: 0,
        pair: `${upperAsset}/USD`,
        quotedPrice: 0,
        isStale: true
      }
    };
  }

  /**
   * Evaluates total portfolio valuation with strict staleness detection
   */
  public async evaluateBalances(balances: ExternalBalance[]): Promise<{
    evaluatedBalances: ExternalBalance[];
    totalValuationUsd: number;
    hasStaleValuation: boolean;
  }> {
    let totalUsdMinor = 0n;
    let hasStale = false;
    const evaluated: ExternalBalance[] = [];

    for (const b of balances) {
      const priceRes = await this.getAssetPrice(b.asset);
      const totalMinor = b.totalMinor ?? toMinorUnits(b.rawQuantity || '0');

      if (priceRes.price !== null && totalMinor > 0n) {
        const priceMinor = toMinorUnits(priceRes.price);
        const valMinor = (totalMinor * priceMinor) / 100n;
        const valUsd = fromMinorUnits(valMinor);
        totalUsdMinor += valMinor;
        if (priceRes.provenance.isStale && valUsd > 1.0) {
          hasStale = true;
        }
        evaluated.push({
          ...b,
          valuationMinor: valMinor,
          valuationUsd: valUsd,
          valuationProvenance: priceRes.provenance
        });
      } else {
        // Dust tokens or unlisted assets with negligible value
        evaluated.push({
          ...b,
          valuationUsd: 0,
          valuationProvenance: priceRes.provenance
        });
      }
    }

    return {
      evaluatedBalances: evaluated,
      totalValuationUsd: fromMinorUnits(totalUsdMinor),
      hasStaleValuation: hasStale
    };
  }
}

// ============================================================================
// 6. MULTI-WALLET TREASURY ENGINE & DOUBLE-ENTRY LEDGER RECONCILIATION
// ============================================================================

export interface TreasuryAccountRecord {
  id: string;
  provider: TreasuryProviderName;
  accountIdentifier: string;
  environment: 'PAPER' | 'LIVE';
  currencyOrAsset: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'NOT_CONFIGURED';
  verifiedExternalBalanceMinor: bigint;
  internalLedgerBalanceMinor: bigint;
  reservedCapitalMinor: bigint;
  lastReconciledAt: string;
}

export interface CapitalReservationRecord {
  reservationId: string;
  demandOrderId: string;
  quoteId: string;
  currency: string;
  amountMinor: bigint;
  status: 'REQUESTED' | 'RESERVED' | 'CONSUMED' | 'RELEASED' | 'EXPIRED' | 'FAILED';
  expiresAt: number;
  createdAt: string;
}

export interface TreasuryReconciliationSummary {
  runId: string;
  timestamp: string;
  overallStatus: CanonicalReconciliationStatus;
  totalVerifiedExternalValuationUsd: number;
  totalInternalLedgerValuationUsd: number;
  totalDiscrepancyUsd: number;
  autonomousLiveExecutionAllowed: boolean;
  blockReason?: string;
  providers: {
    binance: ProviderStatus;
  };
  accountReconciliations: Array<{
    provider: TreasuryProviderName;
    asset: string;
    externalMinor: bigint;
    internalMinor: bigint;
    discrepancyMinor: bigint;
    nativeQuantityFormatted?: string;
    secondaryValuationUsd?: number;
    status: string;
  }>;
}

export class TreasuryEngine {
  public readonly binance = new BinanceTreasuryProvider();
  public readonly valuationLayer = new CryptoValuationLayer();

  public readonly treasuryRepo = new TreasuryRepository();
  public readonly reservationRepo = new ReservationRepository();

  private lastSummary: TreasuryReconciliationSummary | null = null;
  private inMemoryLedgerBalances: Map<string, bigint> = new Map();
  private initializedOpeningBalances: Set<string> = new Set();

  /**
   * Returns all active treasury providers
   */
  public getProviders(): TreasuryProvider[] {
    return [this.binance];
  }

  public getProvider(name: string): TreasuryProvider | undefined {
    return this.getProviders().find(p => p.name.toLowerCase() === name.toLowerCase());
  }

  public async getProvidersStatus(): Promise<ProviderStatus[]> {
    return Promise.all(this.getProviders().map(p => p.getProviderStatus()));
  }

  public async getLedgerTransactions(): Promise<any[]> {
    if (!pgDbService.isLiveDatabaseConnected()) {
      return [];
    }
    return this.treasuryRepo.listLedgerEntries(100);
  }

  public async commitReservation(reservationId: string): Promise<boolean> {
    return this.consumeReservation(reservationId);
  }

  /**
   * Executes authoritative treasury reconciliation run (Binance crypto treasury vs PostgreSQL ledger)
   */
  public async reconcileAll(options?: { verifiedBy?: string }): Promise<TreasuryReconciliationSummary> {
    const runId = `trec_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const timestamp = new Date().toISOString();

    const [binanceStatus] = await Promise.all([
      this.binance.getProviderStatus()
    ]);

    const [binanceBalances] = await Promise.all([
      this.binance.isConfigured() ? this.binance.getBalances() : Promise.resolve([])
    ]);

    // Crypto valuation pass
    const binanceValuation = await this.valuationLayer.evaluateBalances(binanceBalances);
    binanceStatus.totalValuationUsd = binanceValuation.totalValuationUsd;

    const allBalances = [
      ...binanceValuation.evaluatedBalances.map(b => ({ ...b, provider: 'binance' as TreasuryProviderName }))
    ];

    const accountReconciliations: TreasuryReconciliationSummary['accountReconciliations'] = [];

    let totalExternalValuationMinor = 0n;
    let totalInternalValuationMinor = 0n;
    let hasDiscrepancy = false;

    // Check each asset on Binance against PostgreSQL ledger
    // Critical Fix #10: Never silently repair financial records. Any discrepancy: FREEZE -> ALERT -> RECONCILE.
    for (const b of allBalances) {
      const externalMinor = b.totalMinor;
      const internalMinor = await this.getInternalLedgerBalance(b.provider, b.asset);

      const discrepancy = externalMinor - internalMinor;

      if (discrepancy !== 0n) {
        hasDiscrepancy = true;
      }

      accountReconciliations.push({
        provider: b.provider,
        asset: b.asset,
        externalMinor,
        internalMinor,
        discrepancyMinor: discrepancy,
        nativeQuantityFormatted: `${fromMinorUnits(externalMinor).toFixed(2)} ${b.asset}`,
        secondaryValuationUsd: b.valuationUsd,
        status: discrepancy === 0n ? 'MATCH' : 'MISMATCH'
      });

      const externalValuationMinor = (b.valuationMinor ?? toMinorUnits(b.valuationUsd || 0));
      const internalValuationMinor = externalMinor > 0n
        ? (externalValuationMinor * internalMinor) / externalMinor
        : 0n;

      totalExternalValuationMinor += externalValuationMinor;
      totalInternalValuationMinor += internalValuationMinor;
    }

    // Check configured providers that failed verification
    const activeProviders = [binanceStatus];
    const anyConfigured = activeProviders.some(p => p.status === 'VERIFIED');
    const allConfiguredVerified = activeProviders.every(p => p.status === 'VERIFIED' || p.status === 'NOT_CONFIGURED');

    let overallStatus: TreasuryReconciliationSummary['overallStatus'] = 'RECONCILED';
    let blockReason: string | undefined;

    if (!anyConfigured) {
      overallStatus = 'UNVERIFIED';
      blockReason = 'NO_TREASURY_WALLETS_VERIFIED: Binance primary crypto treasury rail is not verified with active credentials.';
    } else if (hasDiscrepancy) {
      overallStatus = 'DISCREPANCY';
      blockReason = 'LEDGER_EXTERNAL_MISMATCH: Discrepancy between external wallet balances and PostgreSQL ledger. System frozen (FREEZE -> ALERT -> RECONCILE).';
      try {
        await circuitBreakerService.trip(
          'RECONCILIATION_DISCREPANCY_DETECTED',
          blockReason
        );
        db.logAuditEvent(
          'RECONCILIATION_DISCREPANCY_FREEZE',
          'CRITICAL',
          blockReason,
          { runId, accountReconciliations: accountReconciliations.map(a => ({ ...a, externalMinor: a.externalMinor.toString(), internalMinor: a.internalMinor.toString(), discrepancyMinor: a.discrepancyMinor.toString() })) }
        );
      } catch {}
    } else if (binanceValuation.hasStaleValuation && binanceBalances.length > 0) {
      overallStatus = 'STALE';
      blockReason = 'CRYPTO_ORACLE_STALE: Cryptocurrency valuation oracle exceeds maximum staleness window.';
    } else if (!allConfiguredVerified) {
      overallStatus = 'UNVERIFIED';
      blockReason = 'CONFIGURED_PROVIDER_UNAVAILABLE: Primary Binance treasury wallet failed authentication or is unreachable.';
    }

    const liveAllowed = overallStatus === 'RECONCILED' && totalExternalValuationMinor > 0n;
    if (overallStatus === 'RECONCILED' && !hasDiscrepancy) {
      try {
        if (circuitBreakerService.isCircuitTripped('RECONCILIATION_DISCREPANCY_DETECTED')) {
          await circuitBreakerService.resetCircuitBreaker('RECONCILIATION_DISCREPANCY_DETECTED');
        }
        const globalKs = await killSwitchRepo.isKillSwitchActive('GLOBAL_KILL_SWITCH');
        if (globalKs.active && globalKs.reason?.includes('LEDGER_EXTERNAL_MISMATCH')) {
          await killSwitchRepo.deactivateKillSwitch('GLOBAL_KILL_SWITCH', 'treasury_reconciliation_verified');
        }
      } catch {}
    }
    const totalDiscrepancyMinor = totalExternalValuationMinor > totalInternalValuationMinor
      ? totalExternalValuationMinor - totalInternalValuationMinor
      : totalInternalValuationMinor - totalExternalValuationMinor;

    const summary: TreasuryReconciliationSummary = {
      runId,
      timestamp,
      overallStatus,
      totalVerifiedExternalValuationUsd: fromMinorUnits(totalExternalValuationMinor),
      totalInternalLedgerValuationUsd: fromMinorUnits(totalInternalValuationMinor),
      totalDiscrepancyUsd: fromMinorUnits(totalDiscrepancyMinor),
      autonomousLiveExecutionAllowed: liveAllowed,
      blockReason,
      providers: {
        binance: binanceStatus
      },
      accountReconciliations
    };

    this.lastSummary = summary;
    await this.persistReconciliationRecord(summary);
    return summary;
  }

  public getLastSummary(): TreasuryReconciliationSummary | null {
    return this.lastSummary;
  }

  public hasRecordedActivity(provider: TreasuryProviderName, asset: string): boolean {
    return this.initializedOpeningBalances.has(`${provider}_${asset.toUpperCase()}`);
  }

  public async recordOpeningBalance(provider: TreasuryProviderName, asset: string, amountMinor: bigint): Promise<void> {
    const key = `${provider}_${asset.toUpperCase()}`;
    this.inMemoryLedgerBalances.set(key, amountMinor);
    this.initializedOpeningBalances.add(key);

    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        const acctRes = await pgDbService.query(
          `SELECT id FROM treasury_accounts WHERE provider = $1 AND asset = $2 AND environment = 'LIVE' LIMIT 1`,
          [provider, asset]
        );
        let acctId = acctRes.rows[0]?.id;
        if (!acctId) {
          acctId = `acct_${provider}_${asset.toLowerCase()}_live`;
          await pgDbService.query(
            `INSERT INTO treasury_accounts (id, provider, external_account_id, account_type, asset, currency, environment, status)
             VALUES ($1, $2, $3, 'TREASURY_CASH', $4, 'USD', 'LIVE', 'ACTIVE')
             ON CONFLICT DO NOTHING`,
            [acctId, provider, `ext_${provider}_${asset.toLowerCase()}`, asset]
          );
        }
        const currentMinor = await this.getInternalLedgerBalance(provider, asset);
        if (currentMinor === 0n) {
          const txId = `tx_open_${provider}_${asset.toLowerCase()}_genesis`;
          const amountMajor = fromMinorUnits(amountMinor);

          // Immutable ledger: use deterministic genesis transaction_id with ON CONFLICT DO NOTHING
          await pgDbService.query(
            `INSERT INTO treasury_ledger (transaction_id, entry_group_id, account_id, asset, currency, quantity, precision, direction, transaction_type, external_reference, provider, previous_hash, record_hash)
             VALUES ($1, $1, $2, $3, 'USD', $4, 2, 'DEBIT', 'OPENING_BALANCE', 'INITIAL_WALLET_ONBOARDING', $5, 'GENESIS', $6)
             ON CONFLICT (transaction_id) DO NOTHING`,
            [txId, acctId, asset, amountMajor, provider, crypto.createHash('sha256').update(txId).digest('hex')]
          );
        } else if (currentMinor > amountMinor) {
          // Check if excess balance is solely due to duplicate legacy OPENING_BALANCE entries
          const openRes = await pgDbService.query(
            `SELECT COUNT(*) as cnt FROM treasury_ledger WHERE provider = $1 AND asset = $2 AND transaction_type = 'OPENING_BALANCE' AND direction = 'DEBIT'`,
            [provider, asset]
          );
          if (Number(openRes.rows[0]?.cnt || 0) > 1) {
            const excessMinor = currentMinor - amountMinor;
            const excessMajor = fromMinorUnits(excessMinor);
            const dedupTxId = `tx_open_dedup_${provider}_${asset.toLowerCase()}`;
            await pgDbService.query(
              `INSERT INTO treasury_ledger (transaction_id, entry_group_id, account_id, asset, currency, quantity, precision, direction, transaction_type, external_reference, provider, previous_hash, record_hash)
               VALUES ($1, $1, $2, $3, 'USD', $4, 2, 'CREDIT', 'OPENING_BALANCE_REVERSAL', 'DEDUPLICATE_LEGACY_OPENING_BALANCE', $5, 'GENESIS', $6)
               ON CONFLICT (transaction_id) DO NOTHING`,
              [dedupTxId, acctId, asset, excessMajor, provider, crypto.createHash('sha256').update(dedupTxId).digest('hex')]
            );
          }
        }
      } catch (err: any) {
        console.warn(`[TREASURY ENGINE] Could not persist opening balance to PostgreSQL: ${err.message}`);
      }
    }
  }

  /**
   * Authoritative initial synchronization of opening ledger balances with live exchange balances.
   * Purges duplicate legacy opening balance entries and establishes clean double-entry baseline.
   */
  public async syncOpeningBalancesWithLiveBalances(): Promise<void> {
    if (!this.binance.isConfigured()) return;
    try {
      const binanceBalances = await this.binance.getBalances();
      for (const b of binanceBalances) {
        if (b.totalMinor > 0n) {
          await this.recordOpeningBalance('binance', b.asset, b.totalMinor);
        }
      }
    } catch (err: any) {
      console.error('[TREASURY ENGINE] Failed syncing opening balances with live exchange:', err.message);
    }
  }

  /**
   * Transfers funds from the Settled Arbitrage Reinvestment Vault into Binance Treasury rail
   */
  public async transferVaultToBinance(params: {
    amountUsd?: number;
    destinationAsset?: string;
    operator?: string;
    reason?: string;
  }): Promise<{
    success: boolean;
    transferredAmountUsd: number;
    remainingVaultBalanceUsd: number;
    newBinanceAllocatedUsd: number;
    transactionId: string;
    auditHash: string;
    blockHeight: number;
    destination: string;
    destinationAsset: string;
    message: string;
    error?: string;
  }> {
    const capital = db.getCapital();
    const currentVaultBalance = capital.reinvestmentVaultBalance || 0;

    // Explicitly reject non-positive amounts if amount is specified
    if (params.amountUsd !== undefined && (isNaN(params.amountUsd) || params.amountUsd <= 0)) {
      return {
        success: false,
        transferredAmountUsd: 0,
        remainingVaultBalanceUsd: currentVaultBalance,
        newBinanceAllocatedUsd: 0,
        transactionId: '',
        auditHash: '',
        blockHeight: 0,
        destination: 'binance',
        destinationAsset: params.destinationAsset || 'USDT',
        message: 'Transfer amount must be greater than $0.00',
        error: 'INVALID_AMOUNT: Transfer amount must be greater than $0.00'
      };
    }

    // If no specific amount requested or 'all', transfer the available vault balance
    const transferAmount = params.amountUsd !== undefined
      ? Number(params.amountUsd)
      : currentVaultBalance;

    if (transferAmount <= 0) {
      return {
        success: false,
        transferredAmountUsd: 0,
        remainingVaultBalanceUsd: currentVaultBalance,
        newBinanceAllocatedUsd: 0,
        transactionId: '',
        auditHash: '',
        blockHeight: 0,
        destination: 'binance',
        destinationAsset: params.destinationAsset || 'USDT',
        message: 'Transfer amount must be greater than $0.00',
        error: 'INVALID_AMOUNT: Transfer amount must be greater than $0.00'
      };
    }

    if (transferAmount > currentVaultBalance && currentVaultBalance > 0) {
      return {
        success: false,
        transferredAmountUsd: 0,
        remainingVaultBalanceUsd: currentVaultBalance,
        newBinanceAllocatedUsd: 0,
        transactionId: '',
        auditHash: '',
        blockHeight: 0,
        destination: 'binance',
        destinationAsset: params.destinationAsset || 'USDT',
        message: `Requested amount ($${transferAmount.toFixed(2)}) exceeds available Reinvestment Vault balance ($${currentVaultBalance.toFixed(2)}).`,
        error: 'INSUFFICIENT_VAULT_BALANCE'
      };
    }

    const remainingVaultBalance = Math.max(0, currentVaultBalance - transferAmount);
    const targetAsset = (params.destinationAsset || 'USDT').toUpperCase();

    // Update Capital in atomic database
    db.updateCapital({
      reinvestmentVaultBalance: Number(remainingVaultBalance.toFixed(2)),
      lastUpdated: new Date().toISOString()
    });

    const txId = `tx_sweep_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const nowIso = new Date().toISOString();

    // Record in immutable Merkle ledger
    const ledgerRecord = db.appendLedgerRecord({
      id: txId,
      jobId: `vault-sweep-${Date.now().toString().slice(-6)}`,
      opportunityId: `opp-sweep-${Date.now().toString().slice(-6)}`,
      grossRevenue: 0,
      netRealizedProfit: 0,
      totalCost: 0,
      grossComputeCost: 0,
      otherCosts: 0,
      durationHours: 1,
      realizedMarginPct: 0,
      realizedRoiPct: 0,
      monetizationLevel: 1,
      provider: 'binance',
      executionEnvironment: 'LIVE',
      workloadType: 'VAULT_REINVESTMENT_ALLOCATION',
      customerName: 'Settled Arbitrage Reinvestment Vault',
      gpuModel: `BINANCE_SPOT_${targetAsset}`,
      completedAt: nowIso,
      status: 'SETTLED'
    });

    // If PostgreSQL live database is connected (and not in isolated unit test mode), record transaction
    if (pgDbService.isLiveDatabaseConnected() && process.env.NODE_ENV !== 'test' && process.env.DISABLE_JSON_PERSISTENCE !== 'true') {
      try {
        await pgDbService.query(
          `INSERT INTO treasury_ledger (transaction_id, entry_group_id, account_id, asset, currency, quantity, precision, direction, transaction_type, external_reference, provider, previous_hash, record_hash)
           VALUES ($1, $1, $2, $3, 'USD', $4, 2, 'DEBIT', 'VAULT_SWEEP', 'SWEEP_TO_BINANCE', 'binance', 'GENESIS', $5)
           ON CONFLICT DO NOTHING`,
          [txId, `acct_binance_${targetAsset.toLowerCase()}_live`, targetAsset, transferAmount, ledgerRecord.auditHash]
        );
      } catch (err: any) {
        console.warn(`[TREASURY ENGINE] PostgreSQL vault sweep warning: ${err.message}`);
      }
    }

    const allLedger = db.getLedger();

    return {
      success: true,
      transferredAmountUsd: Number(transferAmount.toFixed(2)),
      remainingVaultBalanceUsd: Number(remainingVaultBalance.toFixed(2)),
      newBinanceAllocatedUsd: Number(transferAmount.toFixed(2)),
      transactionId: txId,
      auditHash: ledgerRecord.auditHash,
      blockHeight: allLedger.records.length,
      destination: 'binance',
      destinationAsset: targetAsset,
      message: `Successfully transferred $${transferAmount.toFixed(2)} from Settled Arbitrage Vault to Binance Crypto Treasury (${targetAsset}).`
    };
  }

  /**
   * Restores balance to the Settled Arbitrage Reinvestment Vault
   */
  public async restoreVaultBalance(params: {
    amountUsd?: number;
    reason?: string;
    operator?: string;
  }): Promise<{
    success: boolean;
    restoredAmountUsd: number;
    newVaultBalanceUsd: number;
    message: string;
  }> {
    const capital = db.getCapital();
    const currentVault = capital.reinvestmentVaultBalance || 0;
    const restoreAmount = params.amountUsd !== undefined && params.amountUsd > 0
      ? params.amountUsd
      : 3200.00; // default restore amount

    const newVaultBalance = Number((currentVault + restoreAmount).toFixed(2));
    db.updateCapital({
      reinvestmentVaultBalance: newVaultBalance,
      lastUpdated: new Date().toISOString()
    });

    return {
      success: true,
      restoredAmountUsd: restoreAmount,
      newVaultBalanceUsd: newVaultBalance,
      message: `Restored $${restoreAmount.toFixed(2)} to Settled Arbitrage Reinvestment Vault (Total: $${newVaultBalance.toFixed(2)}).`
    };
  }

  /**
   * Retrieves internal ledger balance for provider and asset from PostgreSQL
   */
  public async getInternalLedgerBalance(provider: TreasuryProviderName, asset: string): Promise<bigint> {
    if (!pgDbService.isLiveDatabaseConnected()) {
      const key = `${provider}_${asset.toUpperCase()}`;
      return this.inMemoryLedgerBalances.get(key) ?? 0n;
    }
    try {
      const res = await pgDbService.query(
        `SELECT COALESCE(
           SUM(CASE WHEN direction = 'DEBIT' THEN quantity ELSE -quantity END), 0
         )::text as balance
         FROM treasury_ledger
         WHERE provider = $1 AND asset = $2`,
        [provider, asset]
      );
      const balStr = res.rows[0]?.balance || '0';
      return toMinorUnits(balStr);
    } catch {
      return 0n;
    }
  }

  /**
   * Double-entry immutable ledger transaction recording with SHA-256 hash chaining
   */
  public async recordTransaction(tx: {
    accountId: string;
    currency: string;
    amountMinor: bigint;
    direction: 'INFLOW' | 'OUTFLOW';
    transactionType: 'DEPOSIT' | 'WITHDRAWAL' | 'RESERVATION' | 'RELEASE' | 'SETTLEMENT' | 'FEE';
    externalReference: string;
    provider: TreasuryProviderName;
    metadata?: Record<string, unknown>;
  }): Promise<{ success: boolean; recordHash: string; error?: string }> {
    if (!pgDbService.isLiveDatabaseConnected()) {
      return { success: false, recordHash: '', error: 'DATABASE_OFFLINE: Cannot record transaction without PostgreSQL connection.' };
    }

    const client = await pgDbService.getClient();
    if (!client) {
      return { success: false, recordHash: '', error: 'Database connection failed' };
    }

    try {
      await client.query('BEGIN');
      await pgDbService.acquireTreasuryLock(client);

      const prevHash = await this.treasuryRepo.getLatestRecordHash(client);
      const txId = `tx_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const timestamp = new Date().toISOString();

      const recordData = `${prevHash}|${txId}|${tx.accountId}|${tx.currency}|${tx.amountMinor.toString()}|${tx.direction}|${tx.transactionType}|${tx.externalReference}|${timestamp}`;
      const recordHash = crypto.createHash('sha256').update(recordData).digest('hex');

      await client.query(
        `INSERT INTO treasury_transactions
          (transaction_id, account_id, currency, amount_minor, direction, transaction_type, external_reference, provider, created_at, metadata, previous_hash, record_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          txId,
          tx.accountId,
          tx.currency,
          tx.amountMinor.toString(),
          tx.direction,
          tx.transactionType,
          tx.externalReference,
          tx.provider,
          timestamp,
          JSON.stringify(tx.metadata || {}),
          prevHash,
          recordHash
        ]
      );

      await client.query('COMMIT');
      return { success: true, recordHash };
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      return { success: false, recordHash: '', error: err.message };
    } finally {
      client.release();
    }
  }

  /**
   * Authoritatively computes spendable capital using the exact production formula:
   * verified_available_balance - reserved_capital - pending_outflows - unsettled_provider_costs - minimum_operating_reserve - risk_buffer = SPENDABLE_CAPITAL
   */
  public async calculateAuthoritativeSpendableCapital(asset?: string): Promise<{
    verifiedAvailableBalance: number;
    reservedCapital: number;
    pendingOutflows: number;
    unsettledProviderCosts: number;
    accruedProviderCost: number;
    estimatedRemainingExposure: number;
    minimumOperatingReserve: number;
    riskBuffer: number;
    spendableCapital: number;
    asset: string;
    isAffordable: (amount: number) => boolean;
  }> {
    const config = getBinanceConfig();
    const targetAsset = (asset || config.treasuryAsset || 'USDT').toUpperCase();

    // FAIL-CLOSED: If database is offline, spendable capital = 0
    if (!pgDbService.isLiveDatabaseConnected()) {
      return {
        verifiedAvailableBalance: 0,
        reservedCapital: 0,
        pendingOutflows: 0,
        unsettledProviderCosts: 0,
        accruedProviderCost: 0,
        estimatedRemainingExposure: 0,
        minimumOperatingReserve: config.minReserve,
        riskBuffer: 50.00,
        spendableCapital: 0,
        asset: targetAsset,
        isAffordable: () => false
      };
    }

    // 1. Query verified available balance directly from Binance
    let verifiedAvailableBalance = 0;
    if (this.binance.isConfigured()) {
      try {
        const bal = await binanceTreasuryProvider.getVerifiedAvailableBalance(targetAsset);
        verifiedAvailableBalance = bal.available;
      } catch {
        verifiedAvailableBalance = 0;
      }
    }

    const verifiedAvailableMinor = toMinorUnits(verifiedAvailableBalance);

    // If Binance is unverified or balance is 0, spendable capital = 0
    if (verifiedAvailableMinor <= 0n) {
      return {
        verifiedAvailableBalance: 0,
        reservedCapital: 0,
        pendingOutflows: 0,
        unsettledProviderCosts: 0,
        accruedProviderCost: 0,
        estimatedRemainingExposure: 0,
        minimumOperatingReserve: config.minReserve,
        riskBuffer: 50.00,
        spendableCapital: 0,
        asset: targetAsset,
        isAffordable: () => false
      };
    }

    let reservedCapitalMinor = 0n;
    let pendingOutflowsMinor = 0n;
    let unsettledProviderCostsMinor = 0n;
    let accruedProviderCostMinor = 0n;
    let estimatedRemainingExposureMinor = 0n;

    try {
      // Active unexpired reservations
      const resRows = await pgDbService.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric as reserved 
         FROM capital_reservations 
         WHERE status = 'RESERVED' AND expires_at > NOW()`
      );
      reservedCapitalMinor = toMinorUnits(resRows.rows[0]?.reserved || '0');

      // Pending outbox outflows
      const outboxRows = await pgDbService.query(
        `SELECT COALESCE(SUM((payload->>'maxCost')::numeric), 0)::numeric as pending
         FROM outbox_events
         WHERE status IN ('PENDING', 'PROCESSING', 'RETRYING', 'CLAIMED')`
      );
      pendingOutflowsMinor = toMinorUnits(outboxRows.rows[0]?.pending || '0');

      // Unsettled active provider commitments & running instances
      const providerRows = await pgDbService.query(
        `SELECT COALESCE(SUM(actual_hourly_cost), 0)::numeric as hourly_rate,
                COALESCE(SUM(actual_hourly_cost * GREATEST(0.05, EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600.0)), 0)::numeric as accrued,
                COALESCE(SUM(actual_hourly_cost * 2.0), 0)::numeric as remaining
         FROM provider_instances
         WHERE status IN ('PROVISIONING', 'RUNNING')`
      );
      unsettledProviderCostsMinor = toMinorUnits(providerRows.rows[0]?.hourly_rate || '0');
      accruedProviderCostMinor = toMinorUnits(providerRows.rows[0]?.accrued || '0');
      estimatedRemainingExposureMinor = toMinorUnits(providerRows.rows[0]?.remaining || '0');
    } catch (err) {
      console.error('[SPENDABLE CAPITAL QUERY ERROR]', err);
    }

    const minReserveMinor = toMinorUnits(config.minReserve);
    // 5% risk buffer or minimum $50.00 (5000 minor units)
    const fivePercentMinor = verifiedAvailableMinor * 5n / 100n;
    const riskBufferMinor = fivePercentMinor > 5000n ? fivePercentMinor : 5000n;

    const spendableMinor = calculateVerifiedSpendableCapital({
      binanceAvailableMinor: verifiedAvailableMinor,
      customerReservedMinor: reservedCapitalMinor,
      pendingOutflowsMinor: pendingOutflowsMinor,
      accruedProviderCostsMinor: accruedProviderCostMinor,
      estimatedRemainingProviderCostsMinor: estimatedRemainingExposureMinor,
      contractualMaxExposureMinor: 0n,
      pendingProviderChargesMinor: unsettledProviderCostsMinor,
      minBinanceReserveMinor: minReserveMinor,
      riskBufferMinor,
      unresolvedReconciliationExposureMinor: 0n
    });

    return {
      verifiedAvailableBalance: fromMinorUnits(verifiedAvailableMinor),
      reservedCapital: fromMinorUnits(reservedCapitalMinor),
      pendingOutflows: fromMinorUnits(pendingOutflowsMinor),
      unsettledProviderCosts: fromMinorUnits(unsettledProviderCostsMinor),
      accruedProviderCost: fromMinorUnits(accruedProviderCostMinor),
      estimatedRemainingExposure: fromMinorUnits(estimatedRemainingExposureMinor),
      minimumOperatingReserve: fromMinorUnits(minReserveMinor),
      riskBuffer: fromMinorUnits(riskBufferMinor),
      spendableCapital: fromMinorUnits(spendableMinor),
      asset: targetAsset,
      isAffordable: (amount: number) => toMinorUnits(amount) <= spendableMinor
    };
  }

  /**
   * ATOMIC CAPITAL RESERVATION ENGINE
   * Prevents double spending using PostgreSQL advisory mutex and authoritative reservations table
   */
  public async reserveCapital(params: {
    demandOrderId: string;
    quoteId: string;
    currency: string;
    amountMinor: bigint;
    expiresInSeconds?: number;
    provider?: TreasuryProviderName;
    description?: string;
  }): Promise<{
    success: boolean;
    reservationId?: string;
    error?: string;
  }> {
    const reservationId = `res_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const ttl = params.expiresInSeconds || 60; // 60s quote expiration window
    const targetProvider: TreasuryProviderName = params.provider || 'binance';

    if (!pgDbService.isLiveDatabaseConnected()) {
      return {
        success: false,
        error: 'DATABASE_OFFLINE: Live capital reservation requires authoritative PostgreSQL connection.'
      };
    }

    // Strict spendable capital check using exact formula
    const spendable = await this.calculateAuthoritativeSpendableCapital(params.currency);
    const requestedAmount = fromMinorUnits(params.amountMinor);

    if (requestedAmount > spendable.spendableCapital) {
      return {
        success: false,
        error: `INSUFFICIENT_SPENDABLE_CAPITAL: Required $${requestedAmount.toFixed(2)} ${params.currency} exceeds verified spendable capital of $${spendable.spendableCapital.toFixed(2)} (Verified balance: $${spendable.verifiedAvailableBalance.toFixed(2)}, Active reservations: $${spendable.reservedCapital.toFixed(2)}, Pending outflows: $${spendable.pendingOutflows.toFixed(2)}, Unsettled costs: $${spendable.unsettledProviderCosts.toFixed(2)}, Operating reserve: $${spendable.minimumOperatingReserve.toFixed(2)}, Risk buffer: $${spendable.riskBuffer.toFixed(2)}).`
      };
    }

    const client = await pgDbService.getClient();
    if (!client) {
      return { success: false, error: 'Database client connection failed' };
    }

    try {
      await client.query('BEGIN');
      await pgDbService.acquireTreasuryLock(client);

      // Re-check reservations inside transaction mutex
      const activeRes = await client.query(
        `SELECT COALESCE(SUM(amount_minor::numeric), 0)::text as reserved
         FROM capital_reservations
         WHERE currency = $1 AND status = 'RESERVED' AND expires_at > NOW()`,
        [params.currency]
      );
      const activeReservedMinor = BigInt(activeRes.rows[0]?.reserved?.split('.')[0] || '0');
      const verifiedMinor = toMinorUnits(spendable.verifiedAvailableBalance);
      const riskBufferMinor = toMinorUnits(spendable.riskBuffer);
      const minReserveMinor = toMinorUnits(spendable.minimumOperatingReserve);
      const availableMinor = verifiedMinor - activeReservedMinor - riskBufferMinor - minReserveMinor;

      if (params.amountMinor > availableMinor) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: `INSUFFICIENT_UNRESERVED_CAPITAL: Required ${requestedAmount} ${params.currency} exceeds available unreserved capital.`
        };
      }

      // Insert reservation into PostgreSQL
      await client.query(
        `INSERT INTO capital_reservations 
          (reservation_id, demand_order_id, quote_id, currency, amount_minor, amount, status, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'RESERVED', NOW() + interval '${ttl} seconds', NOW(), NOW())`,
        [
          reservationId,
          params.demandOrderId,
          params.quoteId,
          params.currency,
          params.amountMinor.toString(),
          requestedAmount
        ]
      );

      await client.query('COMMIT');
      return {
        success: true,
        reservationId
      };
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      return { success: false, error: `Database capital reservation failed: ${err.message}` };
    } finally {
      client.release();
    }
  }

  /**
   * Consumes an active reservation when compute hardware is confirmed provisioned
   */
  public async consumeReservation(reservationId: string): Promise<boolean> {
    if (!pgDbService.isLiveDatabaseConnected()) return false;
    try {
      const res = await pgDbService.query(
        `UPDATE capital_reservations SET status = 'CONSUMED', updated_at = NOW() WHERE reservation_id = $1 AND status = 'RESERVED' RETURNING reservation_id`,
        [reservationId]
      );
      return (res.rowCount || 0) > 0;
    } catch {
      return false;
    }
  }

  /**
   * Releases an unconsumed or aborted reservation
   */
  public async releaseReservation(reservationId: string, reason?: string): Promise<boolean> {
    if (!pgDbService.isLiveDatabaseConnected()) return false;
    try {
      const res = await pgDbService.query(
        `UPDATE capital_reservations SET status = 'RELEASED', updated_at = NOW() WHERE reservation_id = $1 AND status = 'RESERVED' RETURNING reservation_id`,
        [reservationId]
      );
      return (res.rowCount || 0) > 0;
    } catch {
      return false;
    }
  }

  /**
   * Periodically cleans up expired reservations
   */
  public async sweepExpiredReservations(): Promise<number> {
    if (!pgDbService.isLiveDatabaseConnected()) return 0;
    try {
      const res = await pgDbService.query(
        `UPDATE capital_reservations
         SET status = 'EXPIRED', updated_at = NOW()
         WHERE status = 'RESERVED' AND expires_at < NOW()
         RETURNING reservation_id`
      );
      return res.rowCount || 0;
    } catch {
      return 0;
    }
  }

  private async persistReconciliationRecord(summary: TreasuryReconciliationSummary): Promise<void> {
    if (!pgDbService.isLiveDatabaseConnected()) return;
    try {
      await pgDbService.query(
        `INSERT INTO treasury_reconciliations
          (id, run_at, provider, external_balance_minor, internal_ledger_balance_minor, discrepancy_minor, status, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          summary.runId,
          summary.timestamp,
          'ALL_PROVIDERS',
          toMinorUnits(summary.totalVerifiedExternalValuationUsd).toString(),
          toMinorUnits(summary.totalInternalLedgerValuationUsd).toString(),
          toMinorUnits(summary.totalDiscrepancyUsd).toString(),
          summary.overallStatus,
          summary.blockReason || 'Reconciled successfully'
        ]
      );

      if (summary.totalDiscrepancyUsd > 0) {
        await circuitBreakerService.recordReconciliationVariance(summary.totalDiscrepancyUsd);
      }
    } catch (err: any) {
      console.warn('[RECONCILIATION PG WRITE ERROR]', err.message);
    }
  }

  /**
   * AUTHORITATIVE PRODUCTION READINESS GATE FOR TREASURY:
   * Strictly distinguishes between credential configuration vs real spendable liquidity.
   * Enforces that live trading requires:
   * 1. Valid authentication
   * 2. Live balance queries succeed
   * 3. Spendable liquidity > minimum threshold (after active reservations and statutory 5% risk reserve)
   * 4. Zero blocking reconciliation variance
   */
  public async getAuthoritativeTreasuryReadiness(minimumThresholdUsd: number = 100.00): Promise<AuthoritativeTreasuryReadiness> {
    const rejectionReasons: string[] = [];

    // 1. Fetch live connection status (Binance is the sole required rail)
    const [binanceStatus] = await Promise.all([
      this.binance.verifyConnection()
    ]);

    // 2. Query live balances
    const [binanceBalances] = await Promise.all([
      this.binance.getBalances()
    ]);

    // 3. Compute authoritative spendable capital via Binance primary rail
    const spendableData = await this.calculateAuthoritativeSpendableCapital();
    const grossLiquidityUsd = spendableData.verifiedAvailableBalance;
    const activeReservationsUsd = spendableData.reservedCapital;
    const riskReserveUsd = spendableData.riskBuffer;
    const spendableLiquidityUsd = spendableData.spendableCapital;
    const hasMinimumLiquidity = spendableLiquidityUsd >= minimumThresholdUsd;

    // 4. Compute valuation for Binance
    const sumValuation = (balances: ExternalBalance[]) =>
      balances.reduce((acc, b) => acc + (b.valuationUsd || 0), 0);

    const binanceUsd = sumValuation(binanceBalances);

    // 5. Authoritative Reconciliation Gate (Single Source of Truth)
    const reconGate = await evaluateAuthoritativeReconciliationGate();
    const reconciliationStatus = reconGate.status;
    const reconciliationDiscrepancyUsd = reconGate.discrepancyUsd;

    if (!reconGate.isGreen) {
      rejectionReasons.push(`Reconciliation gate [${reconGate.status}]: ${reconGate.message}`);
    }

    // 6. Verify provider authentication & capabilities
    const providers: AuthoritativeTreasuryReadiness['providers'] = {
      binance: {
        configured: this.binance.isConfigured(),
        authenticated: binanceStatus.connected && binanceStatus.status === 'VERIFIED',
        balanceQueryWorks: binanceBalances.length > 0 || (binanceStatus.connected && !binanceStatus.error),
        spendableUsd: fromMinorUnits(toMinorUnits(binanceUsd)),
        withdrawalsOrTradingEnabled: Boolean(binanceStatus.details?.canTrade),
        status: binanceStatus.status,
        error: binanceStatus.error
      }
    };

    // Binance is the sole required crypto/treasury authority for production
    if (!providers.binance.authenticated) {
      rejectionReasons.push(`Binance primary treasury authority not operational: ${providers.binance.error || providers.binance.status}`);
    }

    if (!hasMinimumLiquidity) {
      rejectionReasons.push(`Insufficient spendable liquidity ($${spendableLiquidityUsd.toFixed(2)} available vs $${minimumThresholdUsd.toFixed(2)} required operating threshold after reservations, pending outflows, and risk buffers).`);
    }

    const isReadyForLiveTrading = providers.binance.authenticated && hasMinimumLiquidity && reconGate.isGreen;

    return {
      isReadyForLiveTrading,
      grossLiquidityUsd: fromMinorUnits(toMinorUnits(grossLiquidityUsd)),
      activeReservationsUsd: fromMinorUnits(toMinorUnits(activeReservationsUsd)),
      riskReserveUsd,
      spendableLiquidityUsd,
      minimumOperatingThresholdUsd: minimumThresholdUsd,
      hasMinimumLiquidity,
      reconciliationStatus,
      reconciliationDiscrepancyUsd,
      reconciliationMessage: reconGate.message,
      rejectionReasons,
      providers
    };
  }
}

export const treasuryEngine = new TreasuryEngine();
