import crypto from 'crypto';
import { getBinanceConfig, validateBinanceConfig, maskSecret, BinanceConfig } from './binanceConfig.js';
import { toMinorUnits, fromMinorUnits } from './moneyUtils.js';

export interface BinanceBalance {
  asset: string;
  free: string;
  locked: string;
  total: number;
  availableMinor: bigint;
  lockedMinor: bigint;
  totalMinor: bigint;
}

export interface BinanceAccountInfo {
  makerCommission: number;
  takerCommission: number;
  buyerCommission: number;
  sellerCommission: number;
  canTrade: boolean;
  canWithdraw: boolean;
  canDeposit: boolean;
  updateTime: number;
  accountType: string;
  balances: BinanceBalance[];
  permissions: string[];
}

export interface BinanceDepositRecord {
  id?: string;
  txId?: string;
  coin: string;
  amount: number;
  network: string;
  status: number; // 0: pending, 6: credited but cannot withdraw, 1: success
  address: string;
  insertTime: number;
}

export interface BinanceWithdrawRecord {
  id: string;
  txId?: string;
  coin: string;
  amount: number;
  transactionFee: number;
  network: string;
  status: number; // 0: Email Sent, 1: Cancelled, 2: Awaiting Approval, 3: Rejected, 4: Processing, 5: Failure, 6: Completed
  address: string;
  applyTime: string;
}

export interface BinancePreflightResult {
  connected: boolean;
  authenticated: boolean;
  status: 'VERIFIED' | 'AUTH_FAILED' | 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'RATE_LIMITED';
  latencyMs: number;
  serverTimeDriftMs: number;
  accountType?: string;
  canTrade?: boolean;
  canWithdraw?: boolean;
  canDeposit?: boolean;
  usedWeight1m?: number;
  error?: string;
  verifiedAt: string;
  treasuryAssetBalance?: {
    asset: string;
    free: number;
    locked: number;
    total: number;
  };
}

export class BinanceTreasuryProvider {
  readonly name = 'binance' as const;
  private serverTimeOffsetMs = 0;
  private lastTimeSync = 0;
  private lastUsedWeight1m = 0;

  /**
   * Returns current Binance configuration
   */
  public getConfig(): BinanceConfig {
    return getBinanceConfig();
  }

  public isConfigured(): boolean {
    const { apiKey, apiSecret } = this.getConfig();
    return Boolean(apiKey && apiSecret && apiKey.length >= 16 && apiSecret.length >= 16);
  }

  /**
   * Generates HMAC-SHA256 signature for Binance REST API query string
   */
  private signQuery(queryString: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
  }

  /**
   * Synchronize local system time with Binance server time to eliminate error -1021
   */
  public async syncServerTime(): Promise<number> {
    const config = this.getConfig();
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);

      const res = await fetch(`${config.baseUrl}/api/v3/time`, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) {
        const data = (await res.json()) as { serverTime: number };
        const roundTripLatency = Math.floor((Date.now() - start) / 2);
        this.serverTimeOffsetMs = data.serverTime - (Date.now() - roundTripLatency);
        this.lastTimeSync = Date.now();
        return this.serverTimeOffsetMs;
      }
    } catch {
      // Fall back to 0 drift if unreachable
    }
    return this.serverTimeOffsetMs;
  }

  /**
   * Get timestamp calibrated with Binance server time
   */
  private async getCalibratedTimestamp(): Promise<number> {
    // Re-sync clock drift every 15 minutes or on demand
    if (Date.now() - this.lastTimeSync > 900000 || this.lastTimeSync === 0) {
      await this.syncServerTime().catch(() => {});
    }
    return Date.now() + this.serverTimeOffsetMs;
  }

  /**
   * Low-level authenticated request handler with:
   * - Clock drift compensation (re-syncs and retries once on -1021)
   * - Rate-limit header parsing (x-mbx-used-weight-1m)
   * - Exponential backoff retry with jitter on network / 5xx
   * - Zero credential leakage in errors
   */
  public async request<T = unknown>(
    endpoint: string,
    options: {
      method?: 'GET' | 'POST' | 'DELETE';
      params?: Record<string, string | number | boolean | undefined>;
      signed?: boolean;
      body?: Record<string, unknown>;
      retries?: number;
    } = {}
  ): Promise<{ data: T; status: number; headers: Headers }> {
    const config = this.getConfig();
    const method = options.method || 'GET';
    const maxRetries = options.retries !== undefined ? options.retries : 2;

    if (options.signed && !this.isConfigured()) {
      throw new Error('BINANCE_CREDENTIALS_MISSING: Cannot make signed request without valid BINANCE_API_KEY and BINANCE_API_SECRET.');
    }

    let attempt = 0;
    let lastError: any = null;

    while (attempt <= maxRetries) {
      attempt++;
      try {
        const queryParams = new URLSearchParams();
        if (options.params) {
          for (const [k, v] of Object.entries(options.params)) {
            if (v !== undefined) {
              queryParams.append(k, String(v));
            }
          }
        }

        if (options.signed) {
          const timestamp = await this.getCalibratedTimestamp();
          queryParams.set('timestamp', String(timestamp));
          queryParams.set('recvWindow', String(config.recvWindow));
          const queryString = queryParams.toString();
          const signature = this.signQuery(queryString, config.apiSecret);
          queryParams.set('signature', signature);
        }

        const url = `${config.baseUrl}${endpoint}${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
        const headers: Record<string, string> = {
          'User-Agent': 'GPU-Arbitrage-OS/1.0'
        };

        if (options.signed || config.apiKey) {
          headers['X-MBX-APIKEY'] = config.apiKey;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const fetchOptions: RequestInit = {
          method,
          headers,
          signal: controller.signal
        };

        if (options.body && method !== 'GET') {
          headers['Content-Type'] = 'application/json';
          fetchOptions.body = JSON.stringify(options.body);
        }

        const res = await fetch(url, fetchOptions);
        clearTimeout(timeoutId);

        // Track Binance rate limit weight from response header
        const weightHeader = res.headers.get('x-mbx-used-weight-1m');
        if (weightHeader) {
          this.lastUsedWeight1m = parseInt(weightHeader, 10) || 0;
        }

        if (res.ok) {
          const data = (await res.json()) as T;
          return { data, status: res.status, headers: res.headers };
        }

        // Parse Binance error response
        const errPayload = await res.json().catch(() => ({ msg: res.statusText, code: 0 }));
        const binanceCode = (errPayload as any).code;
        const binanceMsg = (errPayload as any).msg || res.statusText;

        // Special handling for timestamp drift error -1021: re-sync time and retry
        if (binanceCode === -1021 && attempt <= maxRetries) {
          console.warn('[BINANCE TIME DRIFT] Detected -1021 timestamp drift. Recalibrating server clock offset...');
          await this.syncServerTime();
          continue;
        }

        // Rate limit 429
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('Retry-After')) || 2;
          if (attempt <= maxRetries) {
            await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
            continue;
          }
          throw new Error(`BINANCE_RATE_LIMITED: Binance API rate limit reached (status 429, weight: ${this.lastUsedWeight1m}).`);
        }

        // Permanent auth / permissions failures (do not retry)
        if (res.status === 401 || res.status === 403 || binanceCode === -2014 || binanceCode === -2015) {
          throw new Error(`BINANCE_AUTH_FAILED: Authentication or permission verification failed [${binanceCode || res.status}]: ${binanceMsg}`);
        }

        // 5xx Server errors - retry with exponential backoff and jitter
        if (res.status >= 500 && attempt <= maxRetries) {
          const jitter = Math.floor(Math.random() * 200);
          const backoff = Math.pow(2, attempt) * 300 + jitter;
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }

        throw new Error(`BINANCE_API_ERROR [${res.status} | code: ${binanceCode}]: ${binanceMsg}`);
      } catch (err: any) {
        lastError = err;
        if (err.message?.includes('BINANCE_AUTH_FAILED') || err.message?.includes('BINANCE_CREDENTIALS_MISSING')) {
          throw err;
        }
        if (attempt <= maxRetries) {
          const jitter = Math.floor(Math.random() * 200);
          await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 200 + jitter));
          continue;
        }
      }
    }

    throw lastError || new Error('BINANCE_REQUEST_FAILED: Request failed after retries.');
  }

  /**
   * Safe, non-billable preflight verification of Binance connectivity and authentication
   */
  public async verifyConnection(): Promise<BinancePreflightResult> {
    const config = this.getConfig();
    const verifiedAt = new Date().toISOString();

    if (!config.enabled) {
      return {
        connected: false,
        authenticated: false,
        status: 'NOT_CONFIGURED',
        latencyMs: 0,
        serverTimeDriftMs: 0,
        error: 'Binance treasury provider is disabled via BINANCE_ENABLED=false.',
        verifiedAt
      };
    }

    if (!this.isConfigured()) {
      return {
        connected: false,
        authenticated: false,
        status: 'NOT_CONFIGURED',
        latencyMs: 0,
        serverTimeDriftMs: 0,
        error: 'BINANCE_API_KEY or BINANCE_API_SECRET missing or insufficient entropy.',
        verifiedAt
      };
    }

    const start = Date.now();
    try {
      // 1. Sync server time
      const drift = await this.syncServerTime();

      // 2. Query authenticated Spot account information
      const res = await this.request<any>('/api/v3/account', { signed: true, retries: 1 });
      const latencyMs = Date.now() - start;
      const accountData = res.data;

      // Extract target treasury asset balance
      const rawBalances: Array<{ asset: string; free: string; locked: string }> = accountData.balances || [];
      const treasuryAssetObj = rawBalances.find(b => b.asset.toUpperCase() === config.treasuryAsset.toUpperCase());

      let treasuryAssetBalance: { asset: string; free: number; locked: number; total: number } | undefined;
      if (treasuryAssetObj) {
        const freeMinor = toMinorUnits(treasuryAssetObj.free);
        const lockedMinor = toMinorUnits(treasuryAssetObj.locked);
        const totalMinor = freeMinor + lockedMinor;
        treasuryAssetBalance = {
          asset: config.treasuryAsset,
          free: fromMinorUnits(freeMinor),
          locked: fromMinorUnits(lockedMinor),
          total: fromMinorUnits(totalMinor)
        };
      }

      return {
        connected: true,
        authenticated: true,
        status: 'VERIFIED',
        latencyMs,
        serverTimeDriftMs: drift,
        accountType: accountData.accountType || 'SPOT',
        canTrade: accountData.canTrade,
        canWithdraw: accountData.canWithdraw,
        canDeposit: accountData.canDeposit,
        usedWeight1m: this.lastUsedWeight1m,
        treasuryAssetBalance,
        verifiedAt
      };
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      const isAuthErr = err.message?.includes('BINANCE_AUTH_FAILED') || err.message?.includes('401') || err.message?.includes('403');
      const isRateLimit = err.message?.includes('RATE_LIMITED') || err.message?.includes('429');

      return {
        connected: false,
        authenticated: false,
        status: isAuthErr ? 'AUTH_FAILED' : isRateLimit ? 'RATE_LIMITED' : 'UNAVAILABLE',
        latencyMs,
        serverTimeDriftMs: this.serverTimeOffsetMs,
        error: err.message || 'Unknown Binance preflight failure',
        verifiedAt
      };
    }
  }

  /**
   * Retrieve real asset balances from Binance Spot account
   */
  public async getBalances(): Promise<Array<{
    asset: string;
    rawQuantity: string;
    availableMinor: bigint;
    lockedMinor: bigint;
    totalMinor: bigint;
    lastUpdated: string;
    valuationUsd?: number;
  }>> {
    if (!this.isConfigured()) return [];

    try {
      const res = await this.request<any>('/api/v3/account', { signed: true });
      const accountData = res.data;
      const balances: Array<any> = [];

      if (accountData.balances && Array.isArray(accountData.balances)) {
        const now = new Date().toISOString();
        for (const b of accountData.balances) {
          const freeMinor = toMinorUnits(b.free);
          const lockedMinor = toMinorUnits(b.locked);
          const totalMinor = freeMinor + lockedMinor;

          if (totalMinor > 0n) {
            // Value USDT/USDC directly 1:1, or treat as unit balance
            const isStable = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'USD'].includes(b.asset.toUpperCase());
            const valuationUsd = isStable ? fromMinorUnits(totalMinor) : undefined;

            balances.push({
              asset: b.asset,
              rawQuantity: b.free,
              availableMinor: freeMinor,
              lockedMinor: lockedMinor,
              totalMinor: totalMinor,
              lastUpdated: now,
              valuationUsd
            });
          }
        }
      }

      return balances;
    } catch (err: any) {
      console.error('[BINANCE BALANCES ERROR]', err.message);
      return [];
    }
  }

  /**
   * Retrieve verified free/available balance of target treasury asset
   */
  public async getVerifiedAvailableBalance(asset?: string): Promise<{
    asset: string;
    available: number;
    locked: number;
    total: number;
    availableMinor: bigint;
  }> {
    const targetAsset = (asset || this.getConfig().treasuryAsset).toUpperCase();
    const allBalances = await this.getBalances();
    const match = allBalances.find(b => b.asset.toUpperCase() === targetAsset);

    if (!match) {
      return {
        asset: targetAsset,
        available: 0,
        locked: 0,
        total: 0,
        availableMinor: 0n
      };
    }

    const available = fromMinorUnits(match.availableMinor);
    const locked = fromMinorUnits(match.lockedMinor);
    const total = fromMinorUnits(match.totalMinor);

    return {
      asset: targetAsset,
      available,
      locked,
      total,
      availableMinor: match.availableMinor
    };
  }

  /**
   * Helper alias returning balance format with free/locked/total
   */
  public async getTreasuryAssetBalance(asset?: string): Promise<{
    asset: string;
    free: number;
    locked: number;
    total: number;
  }> {
    const bal = await this.getVerifiedAvailableBalance(asset);
    return {
      asset: bal.asset,
      free: bal.available,
      locked: bal.locked,
      total: bal.total
    };
  }

  /**
   * Fetch deposit history for treasury reconciliation
   */
  public async getDepositHistory(options?: {
    coin?: string;
    limit?: number;
    startTime?: number;
    endTime?: number;
  }): Promise<BinanceDepositRecord[]> {
    if (!this.isConfigured()) return [];

    try {
      const params: Record<string, any> = {
        limit: options?.limit || 50
      };
      if (options?.coin) params.coin = options.coin;
      if (options?.startTime) params.startTime = options.startTime;
      if (options?.endTime) params.endTime = options.endTime;

      const res = await this.request<any>('/sapi/v1/capital/deposit/hisrec', {
        signed: true,
        params
      });

      if (Array.isArray(res.data)) {
        return res.data.map(d => ({
          id: d.id || d.txId,
          txId: d.txId,
          coin: d.coin,
          amount: fromMinorUnits(toMinorUnits(d.amount || '0')),
          network: d.network || 'MAINNET',
          status: d.status,
          address: d.address,
          insertTime: d.insertTime
        }));
      }
      return [];
    } catch (err: any) {
      console.error('[BINANCE DEPOSIT HISTORY ERROR]', err.message);
      return [];
    }
  }

  /**
   * Fetch official deposit address for Treasury replenishment
   */
  public async getDepositAddress(coin: string = 'USDT', network?: string): Promise<{
    coin: string;
    address: string;
    tag: string;
    url: string;
    network?: string;
  } | null> {
    if (!this.isConfigured()) return null;
    try {
      const params: Record<string, any> = { coin };
      if (network) params.network = network;
      const res = await this.request<any>('/sapi/v1/capital/deposit/address', {
        signed: true,
        params
      });
      if (res.data && res.data.address) {
        return {
          coin: res.data.coin || coin,
          address: res.data.address,
          tag: res.data.tag || '',
          url: res.data.url || '',
          network: res.data.network || network || 'BSC'
        };
      }
      return null;
    } catch (err: any) {
      console.warn('[BINANCE DEPOSIT ADDRESS WARNING]', err.message);
      return null;
    }
  }

  /**
   * Fetch withdrawal history for audit and reconciliation
   */
  public async getWithdrawalHistory(options?: {
    coin?: string;
    limit?: number;
    startTime?: number;
    endTime?: number;
  }): Promise<BinanceWithdrawRecord[]> {
    if (!this.isConfigured()) return [];

    try {
      const params: Record<string, any> = {
        limit: options?.limit || 50
      };
      if (options?.coin) params.coin = options.coin;
      if (options?.startTime) params.startTime = options.startTime;
      if (options?.endTime) params.endTime = options.endTime;

      const res = await this.request<any>('/sapi/v1/capital/withdraw/history', {
        signed: true,
        params
      });

      if (Array.isArray(res.data)) {
        return res.data.map(w => ({
          id: w.id,
          txId: w.txId,
          coin: w.coin,
          amount: fromMinorUnits(toMinorUnits(w.amount || '0')),
          transactionFee: fromMinorUnits(toMinorUnits(w.transactionFee || '0')),
          network: w.network || 'MAINNET',
          status: w.status,
          address: w.address,
          applyTime: w.applyTime
        }));
      }
      return [];
    } catch (err: any) {
      console.error('[BINANCE WITHDRAWAL HISTORY ERROR]', err.message);
      return [];
    }
  }

  /**
   * Outbound withdrawal - STRICT FAIL-CLOSED POLICY
   * Disabled by default. Only enabled when BINANCE_WITHDRAWALS_ENABLED=true.
   */
  public async withdrawCapital(params: {
    coin: string;
    address: string;
    amount: number;
    network?: string;
    clientWithdrawId?: string;
  }): Promise<{ success: boolean; id?: string; error?: string }> {
    const config = this.getConfig();

    if (!config.withdrawalsEnabled) {
      return {
        success: false,
        error: 'WITHDRAWALS_DISABLED_BY_POLICY: Outbound crypto withdrawals from Binance treasury wallet are disabled by strict policy (BINANCE_WITHDRAWALS_ENABLED=false).'
      };
    }

    if (!this.isConfigured()) {
      return {
        success: false,
        error: 'BINANCE_NOT_CONFIGURED: Valid API credentials required to authorize treasury withdrawal.'
      };
    }

    try {
      const bodyParams: Record<string, any> = {
        coin: params.coin,
        address: params.address,
        amount: params.amount
      };
      if (params.network) bodyParams.network = params.network;
      if (params.clientWithdrawId) bodyParams.withdrawOrderId = params.clientWithdrawId;

      const res = await this.request<any>('/sapi/v1/capital/withdraw/apply', {
        method: 'POST',
        signed: true,
        params: bodyParams
      });

      return {
        success: true,
        id: res.data.id
      };
    } catch (err: any) {
      return {
        success: false,
        error: `WITHDRAWAL_FAILED: ${err.message}`
      };
    }
  }
}

export const binanceTreasuryProvider = new BinanceTreasuryProvider();
export const binanceProvider = binanceTreasuryProvider;
