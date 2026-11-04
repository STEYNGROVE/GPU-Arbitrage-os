import crypto from 'crypto';
import { ethers, JsonRpcProvider, Contract, formatUnits, parseUnits } from 'ethers';
import { db } from './databaseEngine.js';
import { binanceTreasuryProvider } from './binanceProvider.js';
import { verifiedProfitWithdrawalService } from './verifiedProfitWithdrawalService.js';
import { killSwitchRepo } from './repositories/index.js';
import { pgDbService } from './pgDatabase.js';

export const OFFICIAL_BSC_CHAIN_ID = 56;
export const OFFICIAL_BSC_USDT_CONTRACT = '0x55d398326f99059fF775485246999027B3197955';
export const OFFICIAL_BSC_USDT_DECIMALS = 18;

export interface NetworkConfig {
  id: string;
  name: string;
  chainId: number;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  usdtAddress: string;
  usdtDecimals: number;
  explorerUrl: string;
  txExplorerUrl: string;
  addressExplorerUrl: string;
}

/**
 * Strict Authorized Network Configuration.
 * PRODUCTION STANDARD: BNB Smart Chain (BSC / BEP-20)
 * Chain ID: 56
 * NOTE: Hardcoded public RPC URLs have been removed. RPC endpoints are resolved
 * dynamically from BSC_RPC_URL (primary) and BSC_RPC_FALLBACK_URLS (optional comma-separated list).
 */
export const SUPPORTED_NETWORKS: Record<string, NetworkConfig> = {
  BSC: {
    id: 'BSC',
    name: 'BNB Smart Chain (BEP20)',
    chainId: OFFICIAL_BSC_CHAIN_ID,
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: [],
    usdtAddress: OFFICIAL_BSC_USDT_CONTRACT,
    usdtDecimals: OFFICIAL_BSC_USDT_DECIMALS,
    explorerUrl: 'https://bscscan.com',
    txExplorerUrl: 'https://bscscan.com/tx/',
    addressExplorerUrl: 'https://bscscan.com/address/'
  }
};

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)'
];

export type HotWalletTxState =
  | 'REQUESTED'
  | 'VALIDATING'
  | 'RISK_CHECK'
  | 'SIGNING'
  | 'BROADCAST'
  | 'PENDING_CONFIRMATION'
  | 'CONFIRMED'
  | 'INTERNAL_CREDIT'
  | 'REJECTED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED';

export interface HotWalletTransaction {
  id: string;
  idempotencyKey: string;
  txHash: string | null;
  chainId: number;
  network: 'BSC';
  token: 'USDT';
  tokenContract: string;
  amount: number;
  destination: string;
  destinationLabel?: string;
  gasPrice?: string;
  gasLimit?: string;
  gasUsed?: string;
  effectiveGasPrice?: string;
  nonce?: number;
  blockNumber?: number;
  confirmationCount: number;
  status: HotWalletTxState;
  operator: string;
  rejectionReason?: string;
  requestedAt: string;
  validatingAt?: string;
  riskCheckedAt?: string;
  signedAt?: string;
  broadcastAt?: string;
  confirmedAt?: string;
  failedAt?: string;
  explorerUrl?: string;
  activeRpcEndpoint?: string;
  rpcSwitched?: boolean;
  reconciledAfterTx?: boolean;
}

export interface HotWalletBalances {
  address: string | null;
  network: NetworkConfig;
  gasBalance: string;
  gasBalanceWei: string;
  gasSymbol: string;
  usdtBalance: string;
  usdtBalanceRaw: string;
  usdtAddress: string;
  hasGas: boolean;
  hasUsdt: boolean;
  canWithdraw: boolean;
  isConfigured: boolean;
  rpcAvailable?: boolean;
  balanceVerified?: boolean;
  error?: string;
  lastChecked: string;
}

export interface RpcEndpointHealth {
  endpoint: string;
  role: 'PRIMARY' | 'FALLBACK';
  chainId: number | null;
  latestBlock: number | null;
  blockAge: number | null;
  latency: number | null;
  consecutiveFailures: number;
  lastSuccessfulCheck: string | null;
  lastError: string | null;
  healthStatus: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';
}

export interface TreasuryRpcHealthState {
  endpoint: string | null;
  chainId: number | null;
  latestBlock: number | null;
  blockAge: number | null;
  latency: number | null;
  consecutiveFailures: number;
  lastSuccessfulCheck: string | null;
  currentActiveEndpoint: string | null;
  healthStatus: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';
  endpoints: RpcEndpointHealth[];
  checkedAt: string;
}

export interface TreasuryReadinessCheck {
  ready: boolean;
  network: 'BSC';
  chainId: number;
  checks: {
    privateKeyConfigured: boolean;
    privateKeyServerSideOnly: boolean;
    addressDerived: string | null;
    bscRpcConfigured: boolean;
    bscRpcReachable: boolean;
    chainIdVerified: boolean;
    blockFreshnessVerified: boolean;
    usdtContractVerified: boolean;
    bnbGasBalanceReadable: boolean;
    usdtBalanceReadable: boolean;
    emergencyStopHealthy: boolean;
    databaseAvailable: boolean;
    auditLoggingAvailable: boolean;
    authorizationAvailable: boolean;
    destinationAllowlistConfigured: boolean;
    withdrawalLimitsConfigured: boolean;
  };
  balances: {
    bnbGasBalance: string;
    usdtBalance: string;
    hasMinimumGas: boolean;
  };
  limits: {
    minWithdrawal: number;
    maxPerTx: number;
    hourlyLimit: number;
    dailyLimit: number;
    targetBalance: number;
    maxBalance: number;
    minGasReserveBnb: number;
  };
  rpcHealth: TreasuryRpcHealthState;
  blockReasons: string[];
}

export class HotWalletService {
  private activeWallet: ethers.Wallet | null = null;
  private currentRawKeyHash: string | null = null;
  private walletVersion: number = 1;
  private readonly defaultNetwork: string = 'BSC';

  // Transaction history in memory (synced to persistent PostgreSQL table)
  private transactions: Map<string, HotWalletTransaction> = new Map();
  private idempotencyMap: Map<string, string> = new Map(); // idempotencyKey -> txId

  // Concurrency Mutex and Safe Nonce Management
  private executionLock: Promise<void> = Promise.resolve();
  private lastAssignedNonce: number = -1;

  // Emergency stop flag (in-memory + persistent PostgreSQL table)
  private emergencyHalted: boolean = false;
  private emergencyHaltReason: string = '';
  private emergencyHaltedBy: string = '';

  // RPC Health State Monitoring
  private endpointHealthMap: Map<string, RpcEndpointHealth> = new Map();
  private currentActiveRawEndpoint: string | null = null;
  private currentActiveRedactedEndpoint: string | null = null;
  private overallRpcHealthStatus: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' = 'UNAVAILABLE';

  // Configurable Treasury Operational Limits
  private readonly MIN_WITHDRAWAL_USD: number;
  private readonly MAX_WITHDRAWAL_PER_TX_USD: number;
  private readonly HOURLY_LIMIT_USD: number;
  private readonly DAILY_LIMIT_USD: number;
  private readonly TARGET_HOT_WALLET_BALANCE_USD: number;
  private readonly MAX_HOT_WALLET_BALANCE_USD: number;
  private readonly MAX_AUTO_PAYOUT_USD: number;

  constructor() {
    this.MIN_WITHDRAWAL_USD = parseFloat(process.env.TREASURY_MIN_WITHDRAWAL_USD || '10.00');
    this.MAX_WITHDRAWAL_PER_TX_USD = parseFloat(process.env.TREASURY_MAX_WITHDRAWAL_PER_TX_USD || '2500.00');
    this.HOURLY_LIMIT_USD = parseFloat(process.env.TREASURY_HOURLY_LIMIT_USD || '5000.00');
    this.DAILY_LIMIT_USD = parseFloat(process.env.TREASURY_DAILY_LIMIT_USD || '15000.00');
    this.TARGET_HOT_WALLET_BALANCE_USD = parseFloat(process.env.TREASURY_TARGET_HOT_WALLET_BALANCE_USD || process.env.TARGET_HOT_WALLET_BALANCE_USD || '2500.00');
    this.MAX_HOT_WALLET_BALANCE_USD = parseFloat(process.env.TREASURY_MAX_HOT_WALLET_BALANCE_USD || process.env.MAX_HOT_WALLET_BALANCE_USD || '20000.00');
    this.MAX_AUTO_PAYOUT_USD = parseFloat(process.env.TREASURY_MAX_AUTO_PAYOUT_USD || '500.00');

    this.initWallet();
    this.initEmergencyState().catch(() => {});
  }

  /**
   * Returns the required minimum BNB gas reserve (Requirement 9: defaults to 0.005 BNB, minimum floor 0.005 BNB).
   */
  public getMinGasReserveBnb(): number {
    const raw = process.env.TREASURY_MIN_GAS_RESERVE_BNB || process.env.TREASURY_MIN_GAS_BNB || '0.005';
    const parsed = parseFloat(raw);
    return !isNaN(parsed) && parsed >= 0.005 ? parsed : 0.005;
  }

  /**
   * Redacts credentials, query parameters, and private API tokens from RPC URLs
   * so private infrastructure secrets are never exposed to the frontend or logs.
   */
  public redactRpcUrl(rawUrl: string): string {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
      const parsed = new URL(rawUrl.trim());
      const pathSegments = parsed.pathname.split('/').filter(Boolean);
      const maskedPath = pathSegments.length > 0
        ? '/' + pathSegments.map(seg => (seg.length > 12 ? `${seg.slice(0, 4)}***` : seg)).join('/')
        : '';
      const searchSuffix = parsed.search ? '?***' : '';
      return `${parsed.protocol}//${parsed.host}${maskedPath}${searchSuffix}`;
    } catch {
      return 'REDACTED_INVALID_URL';
    }
  }

  /**
   * Verifies that no RPC configuration, treasury secrets, private keys, or API secrets
   * are placed in VITE_* frontend-exposed environment variables (Requirement 9).
   */
  public assertNoFrontendSecretExposure(): { safe: boolean; exposedVars: string[] } {
    const forbiddenPrefixes = [
      'VITE_BSC_RPC',
      'VITE_RPC_URL',
      'VITE_TREASURY',
      'VITE_HOT_WALLET',
      'VITE_PRIVATE_KEY',
      'VITE_BINANCE_API_SECRET',
      'VITE_OWNER_API_KEY',
      'NEXT_PUBLIC_TREASURY',
      'NEXT_PUBLIC_BSC_RPC'
    ];
    const exposedVars = Object.keys(process.env).filter(key =>
      forbiddenPrefixes.some(prefix => key.toUpperCase().startsWith(prefix)) &&
      Boolean(process.env[key]?.trim())
    );
    return {
      safe: exposedVars.length === 0,
      exposedVars
    };
  }

  /**
   * Resolves ordered list of BSC RPC endpoints from environment configuration (Requirement 1 & 8):
   * 1. Primary: BSC_RPC_URL
   * 2. Fallbacks: BSC_RPC_FALLBACK_URLS (optional comma-separated list)
   * Never uses hardcoded production endpoints.
   */
  public getConfiguredRpcEndpoints(): Array<{ rawUrl: string; redactedUrl: string; role: 'PRIMARY' | 'FALLBACK' }> {
    const endpoints: Array<{ rawUrl: string; redactedUrl: string; role: 'PRIMARY' | 'FALLBACK' }> = [];
    const seen = new Set<string>();

    const primary = process.env.BSC_RPC_URL?.trim();
    if (primary) {
      seen.add(primary);
      endpoints.push({
        rawUrl: primary,
        redactedUrl: this.redactRpcUrl(primary),
        role: 'PRIMARY'
      });
    }

    const fallbackRaw = process.env.BSC_RPC_FALLBACK_URLS?.trim();
    if (fallbackRaw) {
      const parts = fallbackRaw
        .split(',')
        .map(u => u.trim())
        .filter(Boolean);
      for (const fb of parts) {
        if (!seen.has(fb)) {
          seen.add(fb);
          endpoints.push({
            rawUrl: fb,
            redactedUrl: this.redactRpcUrl(fb),
            role: 'FALLBACK'
          });
        }
      }
    }

    return endpoints;
  }

  /**
   * Resets internal state for testing.
   */
  public resetRpcAndNonceStateForTesting(): void {
    this.endpointHealthMap.clear();
    this.currentActiveRawEndpoint = null;
    this.currentActiveRedactedEndpoint = null;
    this.overallRpcHealthStatus = 'UNAVAILABLE';
    this.lastAssignedNonce = -1;
    this.transactions.clear();
    this.idempotencyMap.clear();
  }

  /**
   * Executes a single JSON-RPC 2.0 POST call with strict timeout enforcement.
   */
  private async jsonRpcCall(url: string, method: string, params: any[], timeoutMs: number): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method,
          params
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP_${response.status}: RPC endpoint returned HTTP ${response.status}`);
      }

      const payload = await response.json();
      if (payload.error) {
        throw new Error(`JSON_RPC_ERROR: ${payload.error.message || JSON.stringify(payload.error)}`);
      }
      if (payload.result === undefined) {
        throw new Error(`INVALID_JSON_RPC_RESPONSE: Missing result field for ${method}`);
      }
      return payload.result;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`RPC_TIMEOUT: ${method} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Validates a single BSC RPC endpoint before use (Requirement 2):
   * - HTTPS only in production.
   * - JSON-RPC connectivity required.
   * - eth_chainId must equal BNB Smart Chain Mainnet chain ID 56 (0x38).
   * - Rejects Ethereum (1), BSC Testnet (97), Polygon (137), or any other chain.
   * - Verifies a valid current block number (> 0).
   * - Rejects stale/unresponsive endpoints based on block timestamp age.
   * - Applies connection and request timeouts.
   */
  public async validateRpcEndpoint(
    rawUrl: string,
    role: 'PRIMARY' | 'FALLBACK' = 'PRIMARY'
  ): Promise<{
    valid: boolean;
    chainId: number | null;
    latestBlock: number | null;
    blockAge: number | null;
    latencyMs: number;
    error?: string;
  }> {
    const redacted = this.redactRpcUrl(rawUrl);
    const existingHealth = this.endpointHealthMap.get(rawUrl) || {
      endpoint: redacted,
      role,
      chainId: null,
      latestBlock: null,
      blockAge: null,
      latency: null,
      consecutiveFailures: 0,
      lastSuccessfulCheck: null,
      lastError: null,
      healthStatus: 'UNAVAILABLE' as const
    };

    const startTime = Date.now();
    const timeoutMs = Math.max(200, parseInt(process.env.BSC_RPC_TIMEOUT_MS || '4000', 10));
    const maxBlockAgeSec = Math.max(5, parseInt(process.env.BSC_RPC_MAX_BLOCK_AGE_SECONDS || '60', 10));
    const isProduction = process.env.NODE_ENV === 'production';

    try {
      // 1. Validate URL syntax and HTTPS requirement in production
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(rawUrl);
      } catch {
        throw new Error(`INVALID_RPC_URL: '${redacted}' is not a valid URL.`);
      }

      if (isProduction && parsedUrl.protocol !== 'https:') {
        throw new Error(`INSECURE_RPC_PROTOCOL: Production requires HTTPS RPC endpoints (rejected '${parsedUrl.protocol}' on ${redacted}).`);
      }
      if (!isProduction && parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        throw new Error(`UNSUPPORTED_RPC_PROTOCOL: Protocol '${parsedUrl.protocol}' is not supported.`);
      }

      // 2. Probe eth_chainId
      const chainIdHex = await this.jsonRpcCall(rawUrl, 'eth_chainId', [], timeoutMs);
      const chainId = typeof chainIdHex === 'string' ? parseInt(chainIdHex, 16) : Number(chainIdHex);

      if (isNaN(chainId)) {
        throw new Error(`INVALID_CHAIN_ID: RPC returned non-numeric eth_chainId (${String(chainIdHex)}).`);
      }
      if (chainId === 97) {
        throw new Error(`BSC_TESTNET_REJECTED: RPC returned BSC Testnet Chain ID 97. Only BNB Smart Chain Mainnet (Chain ID 56) is authorized.`);
      }
      if (chainId === 1) {
        throw new Error(`WRONG_CHAIN_ID: RPC returned Ethereum Mainnet Chain ID 1. Expected BNB Smart Chain Mainnet (Chain ID 56).`);
      }
      if (chainId === 137) {
        throw new Error(`WRONG_CHAIN_ID: RPC returned Polygon Chain ID 137. Expected BNB Smart Chain Mainnet (Chain ID 56).`);
      }
      if (chainId !== OFFICIAL_BSC_CHAIN_ID) {
        throw new Error(`WRONG_CHAIN_ID: RPC returned Chain ID ${chainId}. Expected BNB Smart Chain Mainnet (Chain ID 56).`);
      }

      // 3. Probe eth_blockNumber & latest block header for timestamp freshness
      const blockNumHex = await this.jsonRpcCall(rawUrl, 'eth_blockNumber', [], timeoutMs);
      const latestBlock = typeof blockNumHex === 'string' ? parseInt(blockNumHex, 16) : Number(blockNumHex);
      if (isNaN(latestBlock) || latestBlock <= 0) {
        throw new Error(`INVALID_BLOCK_NUMBER: RPC returned invalid block number (${String(blockNumHex)}).`);
      }

      const latestBlockObj = await this.jsonRpcCall(rawUrl, 'eth_getBlockByNumber', ['latest', false], timeoutMs);
      if (!latestBlockObj || !latestBlockObj.timestamp) {
        throw new Error(`INVALID_BLOCK_HEADER: RPC failed to return latest block header with timestamp.`);
      }

      const blockTimestampSec = typeof latestBlockObj.timestamp === 'string'
        ? parseInt(latestBlockObj.timestamp, 16)
        : Number(latestBlockObj.timestamp);

      if (isNaN(blockTimestampSec) || blockTimestampSec <= 0) {
        throw new Error(`INVALID_BLOCK_TIMESTAMP: Latest block has invalid timestamp (${String(latestBlockObj.timestamp)}).`);
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const blockAge = Math.max(0, nowSec - blockTimestampSec);

      if (blockAge > maxBlockAgeSec) {
        throw new Error(
          `STALE_BLOCK_REJECTED: RPC endpoint ${redacted} returned stale block #${latestBlock} (block age ${blockAge}s exceeds maximum allowed ${maxBlockAgeSec}s).`
        );
      }

      const latencyMs = Date.now() - startTime;
      const updatedHealth: RpcEndpointHealth = {
        endpoint: redacted,
        role,
        chainId,
        latestBlock,
        blockAge,
        latency: latencyMs,
        consecutiveFailures: 0,
        lastSuccessfulCheck: new Date().toISOString(),
        lastError: null,
        healthStatus: 'HEALTHY'
      };
      this.endpointHealthMap.set(rawUrl, updatedHealth);

      return {
        valid: true,
        chainId,
        latestBlock,
        blockAge,
        latencyMs
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      const errMsg = err.message || 'Unknown RPC validation failure';
      const updatedHealth: RpcEndpointHealth = {
        ...existingHealth,
        endpoint: redacted,
        role,
        latency: latencyMs,
        consecutiveFailures: existingHealth.consecutiveFailures + 1,
        lastError: errMsg,
        healthStatus: 'UNAVAILABLE'
      };
      this.endpointHealthMap.set(rawUrl, updatedHealth);

      return {
        valid: false,
        chainId: updatedHealth.chainId,
        latestBlock: updatedHealth.latestBlock,
        blockAge: updatedHealth.blockAge,
        latencyMs,
        error: errMsg
      };
    }
  }

  /**
   * Validates that the configured and on-chain USDT contract is strictly the official
   * BNB Smart Chain USDT contract (0x55d398326f99059fF775485246999027B3197955) (Requirement 7).
   */
  public async validateUsdtContract(
    provider: JsonRpcProvider,
    candidateContractAddress?: string
  ): Promise<{
    valid: boolean;
    contractAddress: string;
    decimals: number;
    symbol: string;
  }> {
    const envContract = process.env.BSC_USDT_CONTRACT_ADDRESS?.trim() || process.env.TREASURY_USDT_CONTRACT?.trim();
    const addressToVerify = candidateContractAddress?.trim() || envContract || OFFICIAL_BSC_USDT_CONTRACT;

    if (addressToVerify.toLowerCase() !== OFFICIAL_BSC_USDT_CONTRACT.toLowerCase()) {
      throw new Error(
        `UNAUTHORIZED_USDT_CONTRACT: Configured token contract '${addressToVerify}' is forbidden. Treasury operations are strictly locked to official BSC USDT contract ${OFFICIAL_BSC_USDT_CONTRACT}.`
      );
    }

    const code = await provider.send('eth_getCode', [OFFICIAL_BSC_USDT_CONTRACT, 'latest']);
    if (!code || code === '0x' || code === '0x0' || code.length <= 4) {
      throw new Error(
        `USDT_CONTRACT_NOT_DEPLOYED: Official BSC USDT contract ${OFFICIAL_BSC_USDT_CONTRACT} has no deployed bytecode on the connected RPC.`
      );
    }

    const usdtContract = new Contract(OFFICIAL_BSC_USDT_CONTRACT, ERC20_ABI, provider);
    const [decimalsRaw, symbolRaw] = await Promise.all([
      usdtContract.decimals(),
      usdtContract.symbol()
    ]);

    const decimals = Number(decimalsRaw);
    const symbol = String(symbolRaw || '').trim().toUpperCase();

    if (decimals !== OFFICIAL_BSC_USDT_DECIMALS) {
      throw new Error(
        `USDT_CONTRACT_DECIMALS_MISMATCH: Expected ${OFFICIAL_BSC_USDT_DECIMALS} decimals on ${OFFICIAL_BSC_USDT_CONTRACT}, observed ${decimals}.`
      );
    }

    if (symbol !== 'USDT' && symbol !== 'BSC-USD') {
      throw new Error(
        `USDT_CONTRACT_SYMBOL_MISMATCH: Expected symbol USDT (or BSC-USD) on ${OFFICIAL_BSC_USDT_CONTRACT}, observed '${symbolRaw}'.`
      );
    }

    return {
      valid: true,
      contractAddress: OFFICIAL_BSC_USDT_CONTRACT,
      decimals,
      symbol
    };
  }

  /**
   * Initializes emergency halt state from persistent database.
   */
  private async initEmergencyState(): Promise<void> {
    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        const res = await pgDbService.query(
          `SELECT is_halted, reason, halted_by FROM hot_wallet_emergency_state WHERE id = 'MAIN'`
        );
        if (res.rows.length > 0) {
          this.emergencyHalted = Boolean(res.rows[0].is_halted);
          this.emergencyHaltReason = res.rows[0].reason || '';
          this.emergencyHaltedBy = res.rows[0].halted_by || '';
        }
      } catch (err: any) {
        console.warn('[HOT WALLET] Note loading emergency state from DB:', err.message);
      }
    }
  }

  public static readonly COMPROMISED_HOT_WALLET_ADDRESS = '0xBaDa29E5725f7F8F750e41B8724d9c4c77646bA5'.toLowerCase();

  /**
   * Unwraps raw or AWS Secrets Manager JSON-encoded private key strings
   * (e.g. {"TREASURY_HOT_WALLET_PRIVATE_KEY":"<32_BYTE_HEX_KEY>"}) and validates
   * that the inner value is an authentic 32-byte (64 hex chars) private key,
   * rejecting placeholders like <YOUR_32_BYTE_HEX_KEY> or 20-byte addresses.
   */
  public static extractNormalizedPrivateKey(rawInput?: string): string | null {
    if (!rawInput) return null;
    let candidate = rawInput.trim();
    if (!candidate) return null;

    if (candidate.startsWith('{') && candidate.endsWith('}')) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object') {
          const extracted =
            parsed.TREASURY_HOT_WALLET_PRIVATE_KEY ??
            parsed.privateKey ??
            parsed.private_key;
          if (typeof extracted === 'string') {
            candidate = extracted.trim();
          } else {
            return null;
          }
        }
      } catch {
        return null;
      }
    }

    if (
      !candidate ||
      candidate.includes('<') ||
      candidate.includes('>') ||
      candidate.toUpperCase().includes('YOUR_32_BYTE_HEX_KEY') ||
      candidate.toUpperCase().includes('PRIVATE_KEY')
    ) {
      return null;
    }

    const cleanHex = candidate.startsWith('0x') ? candidate.slice(2) : candidate;
    if (cleanHex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(cleanHex)) {
      return null;
    }

    return `0x${cleanHex}`;
  }

  /**
   * Initializes the authoritative treasury hot wallet.
   */
  public initWallet(): ethers.Wallet | null {
    const envKey = process.env.TREASURY_HOT_WALLET_PRIVATE_KEY?.trim();

    if (!envKey) {
      this.activeWallet = null;
      this.currentRawKeyHash = null;
      return null;
    }

    const keyHash = crypto.createHash('sha256').update(envKey).digest('hex');

    if (this.activeWallet && this.currentRawKeyHash === keyHash) {
      return this.activeWallet;
    }

    try {
      const formattedKey = HotWalletService.extractNormalizedPrivateKey(envKey);
      if (!formattedKey) {
        console.error('[HOT WALLET] TREASURY_HOT_WALLET_PRIVATE_KEY is missing, a placeholder, or not a valid 32-byte hex string. Halting (fail-closed).');
        this.activeWallet = null;
        this.currentRawKeyHash = null;
        return null;
      }

      const newWallet = new ethers.Wallet(formattedKey);
      if (newWallet.address.toLowerCase() === HotWalletService.COMPROMISED_HOT_WALLET_ADDRESS) {
        console.error('[HOT WALLET] CRITICAL: Compromised hot wallet address detected. Halting (fail-closed).');
        this.activeWallet = null;
        this.currentRawKeyHash = null;
        return null;
      }

      if (this.activeWallet && this.activeWallet.address !== newWallet.address) {
        console.log(`[HOT WALLET] Secret rotation detected. Old address: ${this.activeWallet.address}, New address: ${newWallet.address}`);
        this.walletVersion++;
        this.lastAssignedNonce = -1;

        try {
          db.logAuditEvent(
            'TREASURY_KEY_ROTATED',
            'INFO',
            `Treasury hot wallet key rotated. Active address: ${newWallet.address} (v${this.walletVersion})`,
            { address: newWallet.address, version: this.walletVersion }
          );
        } catch {}
      } else {
        console.log(`[HOT WALLET] Initialized authoritative treasury hot wallet: ${newWallet.address}`);
      }

      this.activeWallet = newWallet;
      this.currentRawKeyHash = keyHash;
      return this.activeWallet;
    } catch (err: any) {
      console.error(`[HOT WALLET] Failed to initialize wallet: ${err.message}. Halting hot wallet operations (fail-closed).`);
      this.activeWallet = null;
      this.currentRawKeyHash = null;
      return null;
    }
  }

  public static readonly AUTHORITATIVE_HOT_WALLET_ADDRESS = '0x19FaF16d0a8fb7EdBf31b4AbeC06bc4Bfbf9467B';

  public getConfiguredPublicAddress(): string | null {
    const wallet = this.initWallet();
    if (wallet) {
      return wallet.address;
    }

    const explicitAddr =
      process.env.TREASURY_HOT_WALLET_ADDRESS?.trim() ||
      process.env.TREASURY_WALLET_ADDRESS?.trim();
    if (explicitAddr && ethers.isAddress(explicitAddr)) {
      return ethers.getAddress(explicitAddr);
    }

    return HotWalletService.AUTHORITATIVE_HOT_WALLET_ADDRESS;
  }

  public getAddress(): string | null {
    return this.getConfiguredPublicAddress();
  }

  /**
   * Safely sets the public BNB Smart Chain (BEP-20) wallet address for balance monitoring
   * and approved profit withdrawal allowlisting. Strictly rejects seed phrases or private keys.
   */
  public async setPublicWalletAddress(params: {
    address: string;
    label?: string;
    operator?: string;
  }): Promise<{
    success: boolean;
    address?: string;
    allowlistRegistered?: boolean;
    error?: string;
  }> {
    const raw = (params.address || '').trim();
    if (!raw) {
      return {
        success: false,
        error: 'MISSING_ADDRESS: Please provide a public 42-character 0x... BNB Smart Chain wallet address.'
      };
    }

    // Security guard: strictly block seed phrases or 32-byte private keys
    const cleanHexCandidate = raw.startsWith('0x') ? raw.slice(2) : raw;
    if (raw.includes(' ') || cleanHexCandidate.length === 64) {
      return {
        success: false,
        error: 'SEED_PHRASE_OR_PRIVATE_KEY_REJECTED: Never enter a secret recovery phrase or private key. Enter only your public 42-character 0x... wallet address.'
      };
    }

    if (!ethers.isAddress(raw)) {
      return {
        success: false,
        error: 'INVALID_EVM_ADDRESS: Provided value is not a valid 42-character 0x... BNB Smart Chain address.'
      };
    }

    const checksummed = ethers.getAddress(raw);
    if (checksummed.toLowerCase() === HotWalletService.COMPROMISED_HOT_WALLET_ADDRESS) {
      return {
        success: false,
        error: 'COMPROMISED_ADDRESS_FORBIDDEN: This address is permanently blocklisted.'
      };
    }

    process.env.TREASURY_HOT_WALLET_ADDRESS = checksummed;

    let allowlistRegistered = false;
    try {
      const allowlistRes = await verifiedProfitWithdrawalService.addAllowlistAddress({
        destinationAddress: checksummed,
        network: 'BSC',
        coin: 'USDT',
        label: (params.label || 'Owner Public BSC Wallet (BEP-20)').trim(),
        approvedBy: params.operator || 'owner_operator'
      });
      allowlistRegistered = allowlistRes.success;
    } catch {}

    try {
      db.logAuditEvent(
        'TREASURY_PUBLIC_ADDRESS_UPDATED',
        'INFO',
        `Public treasury wallet address updated to ${checksummed} by ${params.operator || 'owner_operator'}`,
        { address: checksummed, allowlistRegistered }
      );
    } catch {}

    return {
      success: true,
      address: checksummed,
      allowlistRegistered
    };
  }

  public isConfigured(): boolean {
    return Boolean(this.initWallet());
  }

  /**
   * Resolves target network configuration.
   * Only BNB Smart Chain (BSC, Chain ID 56) is authorized.
   */
  public getNetwork(networkId?: string): NetworkConfig {
    const raw = networkId || process.env.TREASURY_HOT_WALLET_NETWORK || this.defaultNetwork;
    if (!raw || typeof raw !== 'string') {
      throw new Error('MISSING_TREASURY_NETWORK: No treasury network specified or configured.');
    }
    const key = raw.toUpperCase().trim();
    if (key.includes('TESTNET') || key === '97' || key === 'BSC_TESTNET') {
      throw new Error(`BSC_TESTNET_REJECTED: Network '${raw}' is BSC Testnet (97). Only BNB Smart Chain Mainnet (Chain ID 56) is authorized.`);
    }
    if (key === 'BSC' || key.includes('BNB') || key.includes('BEP20') || key.includes('BINANCE') || key === '56') {
      const configuredRedacted = this.getConfiguredRpcEndpoints().map(e => e.redactedUrl);
      return {
        ...SUPPORTED_NETWORKS.BSC,
        rpcUrls: configuredRedacted
      };
    }
    throw new Error(`INVALID_TREASURY_NETWORK: Network '${raw}' is not authorized. Supported production network: BSC (Chain ID 56)`);
  }

  /**
   * Deterministic RPC Failover (Requirement 3):
   * PRIMARY RPC (BSC_RPC_URL) -> FALLBACK #1 -> FALLBACK #2 -> TREASURY_RPC_UNAVAILABLE.
   * Validates every endpoint before use. Never silently falls back to an incorrect network.
   */
  public async getProvider(
    networkId?: string,
    options?: { excludeRawEndpoints?: string[] }
  ): Promise<{
    provider: JsonRpcProvider;
    network: NetworkConfig;
    rawRpcUrl: string;
    redactedRpcUrl: string;
    chainId: number;
    latestBlock: number;
    blockAge: number;
    latencyMs: number;
    role: 'PRIMARY' | 'FALLBACK';
  }> {
    const net = this.getNetwork(networkId);
    const exposureCheck = this.assertNoFrontendSecretExposure();
    if (!exposureCheck.safe) {
      this.currentActiveRawEndpoint = null;
      this.currentActiveRedactedEndpoint = null;
      this.overallRpcHealthStatus = 'UNAVAILABLE';
      throw new Error(
        `CLIENT_ENV_EXPOSURE_FORBIDDEN: Sensitive RPC or treasury configuration detected in frontend VITE_*/NEXT_PUBLIC_* variables: [${exposureCheck.exposedVars.join(', ')}]. Halting (fail-closed).`
      );
    }

    const configured = this.getConfiguredRpcEndpoints();
    if (configured.length === 0) {
      this.currentActiveRawEndpoint = null;
      this.currentActiveRedactedEndpoint = null;
      this.overallRpcHealthStatus = 'UNAVAILABLE';
      throw new Error(
        'TREASURY_RPC_UNAVAILABLE: BSC_RPC_URL is not configured. Configure BSC_RPC_URL (and optional BSC_RPC_FALLBACK_URLS) in environment variables.'
      );
    }

    const excludeSet = new Set(options?.excludeRawEndpoints || []);
    const errors: string[] = [];

    for (const candidate of configured) {
      if (excludeSet.has(candidate.rawUrl)) {
        continue;
      }

      const validation = await this.validateRpcEndpoint(candidate.rawUrl, candidate.role);
      if (!validation.valid) {
        errors.push(`[${candidate.role} ${candidate.redactedUrl}]: ${validation.error}`);
        continue;
      }

      const prov = new JsonRpcProvider(
        candidate.rawUrl,
        {
          chainId: OFFICIAL_BSC_CHAIN_ID,
          name: 'bsc'
        },
        { staticNetwork: true }
      );

      this.currentActiveRawEndpoint = candidate.rawUrl;
      this.currentActiveRedactedEndpoint = candidate.redactedUrl;
      this.overallRpcHealthStatus = candidate.role === 'PRIMARY' && errors.length === 0 ? 'HEALTHY' : 'DEGRADED';

      return {
        provider: prov,
        network: net,
        rawRpcUrl: candidate.rawUrl,
        redactedRpcUrl: candidate.redactedUrl,
        chainId: OFFICIAL_BSC_CHAIN_ID,
        latestBlock: validation.latestBlock!,
        blockAge: validation.blockAge!,
        latencyMs: validation.latencyMs,
        role: candidate.role
      };
    }

    this.currentActiveRawEndpoint = null;
    this.currentActiveRedactedEndpoint = null;
    this.overallRpcHealthStatus = 'UNAVAILABLE';

    throw new Error(
      `TREASURY_RPC_UNAVAILABLE: All configured BSC RPC endpoints failed validation (fail-closed). ${errors.join(' | ')}`
    );
  }

  /**
   * Returns current RPC health monitoring state (Requirement 4).
   * Never exposes unredacted RPC credentials.
   */
  public getRpcHealthState(): TreasuryRpcHealthState {
    const configured = this.getConfiguredRpcEndpoints();
    const endpoints: RpcEndpointHealth[] = configured.map(c => {
      const existing = this.endpointHealthMap.get(c.rawUrl);
      if (existing) return existing;
      return {
        endpoint: c.redactedUrl,
        role: c.role,
        chainId: null,
        latestBlock: null,
        blockAge: null,
        latency: null,
        consecutiveFailures: 0,
        lastSuccessfulCheck: null,
        lastError: null,
        healthStatus: 'UNAVAILABLE'
      };
    });

    const activeEntry = this.currentActiveRawEndpoint
      ? this.endpointHealthMap.get(this.currentActiveRawEndpoint) || null
      : null;

    return {
      endpoint: this.currentActiveRedactedEndpoint,
      chainId: activeEntry?.chainId ?? null,
      latestBlock: activeEntry?.latestBlock ?? null,
      blockAge: activeEntry?.blockAge ?? null,
      latency: activeEntry?.latency ?? null,
      consecutiveFailures: activeEntry
        ? activeEntry.consecutiveFailures
        : endpoints.reduce((max, e) => Math.max(max, e.consecutiveFailures), 0),
      lastSuccessfulCheck: activeEntry?.lastSuccessfulCheck ?? null,
      currentActiveEndpoint: this.currentActiveRedactedEndpoint,
      healthStatus: this.overallRpcHealthStatus,
      endpoints,
      checkedAt: new Date().toISOString()
    };
  }

  /**
   * Probes all configured RPC endpoints and returns updated health report (Requirement 4).
   */
  public async probeAllRpcEndpoints(): Promise<TreasuryRpcHealthState> {
    const configured = this.getConfiguredRpcEndpoints();
    if (configured.length === 0) {
      this.currentActiveRawEndpoint = null;
      this.currentActiveRedactedEndpoint = null;
      this.overallRpcHealthStatus = 'UNAVAILABLE';
      return this.getRpcHealthState();
    }

    let chosenRaw: string | null = null;
    let chosenRedacted: string | null = null;
    let chosenRole: 'PRIMARY' | 'FALLBACK' | null = null;
    let anyFailed = false;

    for (const c of configured) {
      const res = await this.validateRpcEndpoint(c.rawUrl, c.role);
      if (res.valid && !chosenRaw) {
        chosenRaw = c.rawUrl;
        chosenRedacted = c.redactedUrl;
        chosenRole = c.role;
      }
      if (!res.valid) {
        anyFailed = true;
      }
    }

    this.currentActiveRawEndpoint = chosenRaw;
    this.currentActiveRedactedEndpoint = chosenRedacted;
    if (!chosenRaw) {
      this.overallRpcHealthStatus = 'UNAVAILABLE';
    } else if (chosenRole === 'PRIMARY' && !anyFailed) {
      this.overallRpcHealthStatus = 'HEALTHY';
    } else {
      this.overallRpcHealthStatus = 'DEGRADED';
    }

    return this.getRpcHealthState();
  }

  /**
   * Fetches real live on-chain balances (Native BNB Gas + BEP-20 USDT) for the hot wallet.
   * When all RPCs fail: FAIL CLOSED — NO BALANCE CLAIM, NO WITHDRAWAL.
   */
  public async getLiveBalances(networkId?: string): Promise<HotWalletBalances> {
    const network = this.getNetwork(networkId);
    const wallet = this.initWallet();
    const targetAddress = wallet ? wallet.address : this.getConfiguredPublicAddress();

    if (!targetAddress) {
      return {
        address: null,
        network,
        gasBalance: '0.0000',
        gasBalanceWei: '0',
        gasSymbol: network.nativeCurrency.symbol,
        usdtBalance: '0.00',
        usdtBalanceRaw: '0',
        usdtAddress: network.usdtAddress,
        hasGas: false,
        hasUsdt: false,
        canWithdraw: false,
        isConfigured: false,
        rpcAvailable: false,
        balanceVerified: false,
        error: 'TREASURY_HOT_WALLET_UNCONFIGURED: Hot wallet private key not configured. Treasury operations are halted in fail-closed state.',
        lastChecked: new Date().toISOString()
      };
    }

    try {
      const { provider } = await this.getProvider(network.id);

      // Validate official BSC USDT contract before reading balance
      const contractValidation = await this.validateUsdtContract(provider, network.usdtAddress);

      // 1. Fetch live native gas balance (BNB on BSC)
      const gasBalanceWei = await provider.getBalance(targetAddress);
      const gasBalanceBnb = formatUnits(gasBalanceWei, network.nativeCurrency.decimals);

      // 2. Fetch live BEP-20 USDT token balance directly from validated smart contract
      const usdtContract = new Contract(contractValidation.contractAddress, ERC20_ABI, provider);
      const rawUsdtBalance = await usdtContract.balanceOf(targetAddress);

      const parsedUsdt = formatUnits(rawUsdtBalance, contractValidation.decimals);
      const gasNum = parseFloat(gasBalanceBnb);
      const usdtNum = parseFloat(parsedUsdt);

      const minGas = this.getMinGasReserveBnb();
      const hasGas = gasNum >= minGas;
      const hasUsdt = usdtNum >= this.MIN_WITHDRAWAL_USD;

      return {
        address: targetAddress,
        network,
        gasBalance: gasNum.toFixed(4),
        gasBalanceWei: gasBalanceWei.toString(),
        gasSymbol: network.nativeCurrency.symbol,
        usdtBalance: usdtNum.toFixed(2),
        usdtBalanceRaw: rawUsdtBalance.toString(),
        usdtAddress: contractValidation.contractAddress,
        hasGas,
        hasUsdt,
        canWithdraw: Boolean(wallet) && hasGas && hasUsdt && !this.isEmergencyHalted(),
        isConfigured: Boolean(wallet),
        rpcAvailable: true,
        balanceVerified: true,
        lastChecked: new Date().toISOString()
      };
    } catch (err: any) {
      // FAIL CLOSED: No balance claim, no withdrawal
      return {
        address: targetAddress,
        network,
        gasBalance: '0.0000',
        gasBalanceWei: '0',
        gasSymbol: network.nativeCurrency.symbol,
        usdtBalance: '0.00',
        usdtBalanceRaw: '0',
        usdtAddress: network.usdtAddress,
        hasGas: false,
        hasUsdt: false,
        canWithdraw: false,
        isConfigured: Boolean(wallet),
        rpcAvailable: false,
        balanceVerified: false,
        error: `TREASURY_RPC_UNAVAILABLE: ${err.message}`,
        lastChecked: new Date().toISOString()
      };
    }
  }

  /**
   * Returns comprehensive system status for the hot wallet UI and audit monitors.
   * Redacts any private RPC URLs.
   */
  public async getFullStatus(networkId?: string): Promise<{
    status: 'ACTIVE' | 'UNCONFIGURED' | 'ERROR';
    isConfigured: boolean;
    address: string | null;
    activeNetwork: string;
    networkDetails: NetworkConfig;
    balances: HotWalletBalances;
    availableNetworks: Array<{
      id: string;
      name: string;
      chainId: number;
      symbol: string;
      usdtAddress: string;
      explorerUrl: string;
      addressUrl: string;
    }>;
    isAutoGenerated: boolean;
    hasPrivateKeyConfigured: boolean;
    binanceDepositTarget: string | null;
    emergencyStopActive: boolean;
    limits: {
      minWithdrawal: number;
      maxPerTx: number;
      hourlyLimit: number;
      dailyLimit: number;
      targetBalance: number;
      maxBalance: number;
      minGasBnb: number;
    };
    message: string;
  }> {
    const activeNetwork = this.getNetwork(networkId);
    // Strip RPC URLs from public/client-facing networkDetails so private infrastructure URLs are never exposed
    const safeNetworkDetails: NetworkConfig = {
      ...activeNetwork,
      rpcUrls: []
    };
    const wallet = this.initWallet();
    const targetAddress = wallet ? wallet.address : this.getConfiguredPublicAddress();
    const liveBal = await this.getLiveBalances(activeNetwork.id);

    let binanceDepositTarget: string | null = null;
    try {
      const dep = await binanceTreasuryProvider.getDepositAddress('USDT', activeNetwork.id);
      if (dep && dep.address) {
        binanceDepositTarget = dep.address;
      }
    } catch {
      // Non-fatal if Binance API is unconfigured
    }

    const minGasBnb = this.getMinGasReserveBnb();

    return {
      status: !wallet ? 'UNCONFIGURED' : liveBal.rpcAvailable === false ? 'ERROR' : 'ACTIVE',
      isConfigured: Boolean(wallet),
      address: targetAddress,
      activeNetwork: activeNetwork.id,
      networkDetails: safeNetworkDetails,
      balances: {
        ...liveBal,
        network: safeNetworkDetails
      },
      availableNetworks: Object.values(SUPPORTED_NETWORKS).map(n => ({
        id: n.id,
        name: n.name,
        chainId: n.chainId,
        symbol: n.nativeCurrency.symbol,
        usdtAddress: n.usdtAddress,
        explorerUrl: n.explorerUrl,
        addressUrl: targetAddress ? `${n.addressExplorerUrl}${targetAddress}` : ''
      })),
      isAutoGenerated: false,
      hasPrivateKeyConfigured: Boolean(wallet),
      binanceDepositTarget,
      emergencyStopActive: this.isEmergencyHalted(),
      limits: {
        minWithdrawal: this.MIN_WITHDRAWAL_USD,
        maxPerTx: this.MAX_WITHDRAWAL_PER_TX_USD,
        hourlyLimit: this.HOURLY_LIMIT_USD,
        dailyLimit: this.DAILY_LIMIT_USD,
        targetBalance: this.TARGET_HOT_WALLET_BALANCE_USD,
        maxBalance: this.MAX_HOT_WALLET_BALANCE_USD,
        minGasBnb
      },
      message: !wallet && targetAddress
        ? `Hot wallet address ${targetAddress} is registered on BSC Mainnet (Watch/Deposit Verification Mode). Provide the 66-character 32-byte hex private key in TREASURY_HOT_WALLET_PRIVATE_KEY to enable outbound signing.`
        : !wallet
        ? 'TREASURY_HOT_WALLET_UNCONFIGURED: Hot wallet is not configured. Provide TREASURY_HOT_WALLET_PRIVATE_KEY in production secret manager.'
        : liveBal.rpcAvailable === false
        ? `TREASURY_RPC_UNAVAILABLE: ${liveBal.error}`
        : 'Authoritative BSC hot wallet active with verified Chain ID 56 RPC and official USDT contract.'
    };
  }

  /**
   * Comprehensive Treasury Readiness Check.
   */
  public async checkTreasuryReadiness(): Promise<TreasuryReadinessCheck> {
    const blockReasons: string[] = [];
    const wallet = this.initWallet();
    const envKey = process.env.TREASURY_HOT_WALLET_PRIVATE_KEY?.trim();
    const targetAddress = wallet ? wallet.address : this.getConfiguredPublicAddress();

    const privateKeyConfigured = Boolean(wallet);
    const exposureCheck = this.assertNoFrontendSecretExposure();
    const privateKeyServerSideOnly = exposureCheck.safe;
    const addressDerived = targetAddress;

    if (!envKey) {
      blockReasons.push('TREASURY_HOT_WALLET_PRIVATE_KEY is missing from environment/secret manager.');
    } else if (!wallet) {
      if (/^0x[0-9a-fA-F]{40}$/.test(envKey)) {
        blockReasons.push(
          `Hot wallet address ${targetAddress} is registered and monitored on BSC Mainnet (Watch/Deposit mode), but TREASURY_HOT_WALLET_PRIVATE_KEY contains a 42-character public address instead of the 66-character 32-byte private key required to sign outbound withdrawals.`
        );
      } else {
        blockReasons.push('Unable to derive valid EVM wallet signing key from configured TREASURY_HOT_WALLET_PRIVATE_KEY.');
      }
    }
    if (!privateKeyServerSideOnly) {
      blockReasons.push(`Sensitive configuration exposed in client variables: ${exposureCheck.exposedVars.join(', ')}`);
    }

    const configuredRpcs = this.getConfiguredRpcEndpoints();
    const bscRpcConfigured = configuredRpcs.length > 0 && Boolean(process.env.BSC_RPC_URL?.trim());
    if (!bscRpcConfigured) {
      blockReasons.push('BSC_RPC_URL is not configured.');
    }

    let bscRpcReachable = false;
    let chainIdVerified = false;
    let blockFreshnessVerified = false;
    let usdtContractVerified = false;
    let bnbGasBalanceReadable = false;
    let usdtBalanceReadable = false;
    let bnbGasBalance = '0.0000';
    let usdtBalance = '0.00';

    if (bscRpcConfigured) {
      try {
        const { provider, network, chainId, blockAge } = await this.getProvider('BSC');
        bscRpcReachable = true;
        chainIdVerified = chainId === OFFICIAL_BSC_CHAIN_ID;
        blockFreshnessVerified = blockAge !== null && blockAge <= (parseInt(process.env.BSC_RPC_MAX_BLOCK_AGE_SECONDS || '60', 10));

        const contractCheck = await this.validateUsdtContract(provider, network.usdtAddress);
        usdtContractVerified = contractCheck.valid;

        if (addressDerived) {
          const gasWei = await provider.getBalance(addressDerived);
          bnbGasBalance = Number(formatUnits(gasWei, 18)).toFixed(4);
          bnbGasBalanceReadable = true;

          const usdtContract = new Contract(contractCheck.contractAddress, ERC20_ABI, provider);
          const rawUsdt = await usdtContract.balanceOf(addressDerived);
          usdtBalance = Number(formatUnits(rawUsdt, contractCheck.decimals)).toFixed(2);
          usdtBalanceReadable = true;
        }
      } catch (err: any) {
        blockReasons.push(`BSC RPC / Contract verification failed: ${err.message}`);
      }
    }

    const emergencyStopHealthy = !this.isEmergencyHalted();
    if (!emergencyStopHealthy) {
      blockReasons.push('Emergency treasury stop is currently ACTIVE. Outflows are halted.');
    }

    const databaseAvailable = pgDbService.isLiveDatabaseConnected();
    const auditLoggingAvailable = true;
    const authorizationAvailable = true;

    let destinationAllowlistConfigured = false;
    try {
      const allowlist = await verifiedProfitWithdrawalService.getAllowlist();
      destinationAllowlistConfigured = allowlist.length > 0;
      if (!destinationAllowlistConfigured) {
        blockReasons.push('ALLOWLIST_EMPTY: No destination addresses are registered in withdrawal allowlist.');
      }
    } catch (err: any) {
      blockReasons.push(`Failed to verify allowlist configuration: ${err.message}`);
    }

    const minGasReserveBnb = this.getMinGasReserveBnb();
    const withdrawalLimitsConfigured =
      this.MIN_WITHDRAWAL_USD > 0 &&
      this.MAX_WITHDRAWAL_PER_TX_USD >= this.MIN_WITHDRAWAL_USD &&
      this.DAILY_LIMIT_USD >= this.MAX_WITHDRAWAL_PER_TX_USD &&
      minGasReserveBnb >= 0.005;

    const ready =
      privateKeyConfigured &&
      privateKeyServerSideOnly &&
      Boolean(addressDerived) &&
      bscRpcConfigured &&
      bscRpcReachable &&
      chainIdVerified &&
      blockFreshnessVerified &&
      usdtContractVerified &&
      bnbGasBalanceReadable &&
      usdtBalanceReadable &&
      emergencyStopHealthy &&
      destinationAllowlistConfigured &&
      withdrawalLimitsConfigured;

    return {
      ready,
      network: 'BSC',
      chainId: OFFICIAL_BSC_CHAIN_ID,
      checks: {
        privateKeyConfigured,
        privateKeyServerSideOnly,
        addressDerived,
        bscRpcConfigured,
        bscRpcReachable,
        chainIdVerified,
        blockFreshnessVerified,
        usdtContractVerified,
        bnbGasBalanceReadable,
        usdtBalanceReadable,
        emergencyStopHealthy,
        databaseAvailable,
        auditLoggingAvailable,
        authorizationAvailable,
        destinationAllowlistConfigured,
        withdrawalLimitsConfigured
      },
      balances: {
        bnbGasBalance,
        usdtBalance,
        hasMinimumGas: parseFloat(bnbGasBalance) >= minGasReserveBnb
      },
      limits: {
        minWithdrawal: this.MIN_WITHDRAWAL_USD,
        maxPerTx: this.MAX_WITHDRAWAL_PER_TX_USD,
        hourlyLimit: this.HOURLY_LIMIT_USD,
        dailyLimit: this.DAILY_LIMIT_USD,
        targetBalance: this.TARGET_HOT_WALLET_BALANCE_USD,
        maxBalance: this.MAX_HOT_WALLET_BALANCE_USD,
        minGasReserveBnb
      },
      rpcHealth: this.getRpcHealthState(),
      blockReasons
    };
  }

  /**
   * Check whether emergency stop is active.
   */
  public isEmergencyHalted(): boolean {
    return this.emergencyHalted;
  }

  /**
   * Activate or deactivate emergency treasury kill switch.
   */
  public async setEmergencyStop(params: {
    active: boolean;
    operator: string;
    reason?: string;
  }): Promise<{ success: boolean; active: boolean; message: string }> {
    const { active, operator, reason = 'Operator triggered emergency treasury kill switch' } = params;
    if (!operator) {
      throw new Error('OPERATOR_REQUIRED: Authenticated operator is required to toggle emergency stop.');
    }

    this.emergencyHalted = active;
    this.emergencyHaltReason = active ? reason : '';
    this.emergencyHaltedBy = active ? operator : '';

    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        await pgDbService.query(
          `INSERT INTO hot_wallet_emergency_state (id, is_halted, reason, halted_by, halted_at, updated_at)
           VALUES ('MAIN', $1, $2, $3, NOW(), NOW())
           ON CONFLICT (id) DO UPDATE SET
             is_halted = EXCLUDED.is_halted,
             reason = EXCLUDED.reason,
             halted_by = EXCLUDED.halted_by,
             halted_at = EXCLUDED.halted_at,
             updated_at = NOW()`,
          [active, active ? reason : null, active ? operator : null]
        );
      } catch (e: any) {
        console.warn('[HOT WALLET] Emergency state DB write error:', e.message);
      }
    }

    try {
      await killSwitchRepo.setKillSwitch('BINANCE_OUTFLOW_KILL_SWITCH', active, reason, operator);
    } catch {}

    db.logAuditEvent(
      active ? 'TREASURY_EMERGENCY_HALT_ACTIVATED' : 'TREASURY_EMERGENCY_HALT_DEACTIVATED',
      active ? 'CRITICAL' : 'INFO',
      active
        ? `Emergency treasury halt activated by ${operator}: ${reason}`
        : `Emergency treasury halt deactivated by ${operator}`,
      { active, operator, reason }
    );

    return {
      success: true,
      active: this.isEmergencyHalted(),
      message: active
        ? `Treasury emergency stop ACTIVATED by ${operator}. All withdrawals and settlements halted.`
        : `Treasury emergency stop DEACTIVATED by ${operator}. Normal operations restored.`
    };
  }

  private mapDbRowToTransaction(row: any): HotWalletTransaction {
    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      txHash: row.tx_hash,
      chainId: row.chain_id || OFFICIAL_BSC_CHAIN_ID,
      network: row.network || 'BSC',
      token: row.token || 'USDT',
      tokenContract: row.token_contract,
      amount: Number(row.amount),
      destination: row.destination,
      destinationLabel: row.destination_label,
      gasPrice: row.gas_price,
      gasLimit: row.gas_limit,
      gasUsed: row.gas_used,
      effectiveGasPrice: row.effective_gas_price,
      nonce: row.nonce,
      blockNumber: row.block_number ? Number(row.block_number) : undefined,
      confirmationCount: Number(row.confirmation_count || 0),
      status: row.status as HotWalletTxState,
      operator: row.operator,
      rejectionReason: row.rejection_reason,
      requestedAt: new Date(row.requested_at).toISOString(),
      confirmedAt: row.confirmed_at ? new Date(row.confirmed_at).toISOString() : undefined,
      failedAt: row.failed_at ? new Date(row.failed_at).toISOString() : undefined,
      explorerUrl: row.explorer_url
    };
  }

  public async persistTransaction(record: HotWalletTransaction): Promise<void> {
    this.transactions.set(record.id, record);
    if (record.idempotencyKey) {
      this.idempotencyMap.set(record.idempotencyKey, record.id);
    }

    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        await pgDbService.query(
          `INSERT INTO hot_wallet_transactions (
            id, idempotency_key, tx_hash, chain_id, network, token, token_contract,
            amount, destination, destination_label, gas_price, gas_limit, gas_used,
            effective_gas_price, nonce, block_number, confirmation_count, status,
            operator, rejection_reason, requested_at, confirmed_at, failed_at,
            explorer_url, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
            $16, $17, $18, $19, $20, $21, $22, $23, $24, NOW()
          ) ON CONFLICT (id) DO UPDATE SET
            tx_hash = COALESCE(EXCLUDED.tx_hash, hot_wallet_transactions.tx_hash),
            status = EXCLUDED.status,
            block_number = COALESCE(EXCLUDED.block_number, hot_wallet_transactions.block_number),
            confirmation_count = EXCLUDED.confirmation_count,
            gas_used = COALESCE(EXCLUDED.gas_used, hot_wallet_transactions.gas_used),
            rejection_reason = COALESCE(EXCLUDED.rejection_reason, hot_wallet_transactions.rejection_reason),
            confirmed_at = COALESCE(EXCLUDED.confirmed_at, hot_wallet_transactions.confirmed_at),
            failed_at = COALESCE(EXCLUDED.failed_at, hot_wallet_transactions.failed_at),
            explorer_url = COALESCE(EXCLUDED.explorer_url, hot_wallet_transactions.explorer_url),
            updated_at = NOW()`,
          [
            record.id,
            record.idempotencyKey,
            record.txHash,
            record.chainId,
            record.network,
            record.token,
            record.tokenContract,
            record.amount,
            record.destination,
            record.destinationLabel || null,
            record.gasPrice || null,
            record.gasLimit || null,
            record.gasUsed || null,
            record.effectiveGasPrice || null,
            record.nonce ?? null,
            record.blockNumber ?? null,
            record.confirmationCount,
            record.status,
            record.operator,
            record.rejectionReason || null,
            record.requestedAt,
            record.confirmedAt || null,
            record.failedAt || null,
            record.explorerUrl || null
          ]
        );
      } catch (err: any) {
        console.warn('[HOT WALLET] Transaction DB persistence error:', err.message);
      }
    }
  }

  public async checkPersistentIdempotency(key: string): Promise<HotWalletTransaction | null> {
    if (this.idempotencyMap.has(key)) {
      const txId = this.idempotencyMap.get(key)!;
      const mem = this.transactions.get(txId);
      if (mem) return mem;
    }

    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        const res = await pgDbService.query(
          `SELECT t.* FROM hot_wallet_idempotency i
           JOIN hot_wallet_transactions t ON i.tx_id = t.id
           WHERE i.idempotency_key = $1`,
          [key]
        );
        if (res.rows.length > 0) {
          const r = this.mapDbRowToTransaction(res.rows[0]);
          this.transactions.set(r.id, r);
          this.idempotencyMap.set(key, r.id);
          return r;
        }
      } catch (err: any) {
        console.warn('[HOT WALLET] Idempotency DB query warning:', err.message);
      }
    }
    return null;
  }

  public async recordPersistentIdempotency(key: string, txId: string, status: string, response?: any): Promise<void> {
    this.idempotencyMap.set(key, txId);
    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        await pgDbService.query(
          `INSERT INTO hot_wallet_idempotency (idempotency_key, tx_id, status, response_payload, created_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (idempotency_key) DO UPDATE SET status = EXCLUDED.status, response_payload = EXCLUDED.response_payload`,
          [key, txId, status, response ? JSON.stringify(response) : null]
        );
      } catch (err: any) {
        console.warn('[HOT WALLET] Idempotency DB insert warning:', err.message);
      }
    }
  }

  public async getPersistentVelocityUsage(): Promise<{ hourlySum: number; dailySum: number }> {
    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        const res = await pgDbService.query(`
          SELECT 
            COALESCE(SUM(CASE WHEN requested_at > NOW() - INTERVAL '1 hour' THEN amount ELSE 0 END), 0)::float as hourly_sum,
            COALESCE(SUM(CASE WHEN requested_at > NOW() - INTERVAL '24 hours' THEN amount ELSE 0 END), 0)::float as daily_sum
          FROM hot_wallet_transactions
          WHERE status IN ('CONFIRMED', 'BROADCAST', 'PENDING_CONFIRMATION', 'SIGNING')
        `);
        return {
          hourlySum: Number(res.rows[0]?.hourly_sum || 0),
          dailySum: Number(res.rows[0]?.daily_sum || 0)
        };
      } catch (err: any) {
        console.warn('[HOT WALLET] Persistent velocity query error:', err.message);
        if (process.env.NODE_ENV === 'production') {
          throw new Error(`PRODUCTION_FAIL_CLOSED: Cannot verify persistent treasury velocity limits: ${err.message}`);
        }
      }
    } else if (process.env.NODE_ENV === 'production') {
      throw new Error('PRODUCTION_FAIL_CLOSED: PostgreSQL database is required in production for persistent treasury velocity limits.');
    }

    const now = Date.now();
    let hourlySum = 0;
    let dailySum = 0;
    for (const tx of this.transactions.values()) {
      if (tx.status === 'CONFIRMED' || tx.status === 'BROADCAST' || tx.status === 'PENDING_CONFIRMATION' || tx.status === 'SIGNING') {
        const txTime = new Date(tx.requestedAt).getTime();
        if (now - txTime < 3600 * 1000) hourlySum += tx.amount;
        if (now - txTime < 24 * 3600 * 1000) dailySum += tx.amount;
      }
    }
    return { hourlySum, dailySum };
  }

  public async authorizeAndReserveWithdrawalVelocity(
    record: HotWalletTransaction,
    requestedAmount: number
  ): Promise<{ authorized: boolean; hourlySum: number; dailySum: number; rejectionReason?: string }> {
    if (pgDbService.isLiveDatabaseConnected()) {
      const client = await pgDbService.getClient();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(56005601)');

        const velRes = await client.query(`
          SELECT 
            COALESCE(SUM(CASE WHEN requested_at > NOW() - INTERVAL '1 hour' THEN amount ELSE 0 END), 0)::float as hourly_sum,
            COALESCE(SUM(CASE WHEN requested_at > NOW() - INTERVAL '24 hours' THEN amount ELSE 0 END), 0)::float as daily_sum
          FROM hot_wallet_transactions
          WHERE status IN ('CONFIRMED', 'BROADCAST', 'PENDING_CONFIRMATION', 'SIGNING')
            AND id <> $1
        `, [record.id]);

        const hourlySum = Number(velRes.rows[0]?.hourly_sum || 0);
        const dailySum = Number(velRes.rows[0]?.daily_sum || 0);

        if (hourlySum + requestedAmount > this.HOURLY_LIMIT_USD) {
          await client.query('ROLLBACK');
          return {
            authorized: false,
            hourlySum,
            dailySum,
            rejectionReason: `HOURLY_LIMIT_EXCEEDED: Request would push 1-hour outflow to $${(hourlySum + requestedAmount).toFixed(2)}, exceeding limit of $${this.HOURLY_LIMIT_USD.toFixed(2)}.`
          };
        }

        if (dailySum + requestedAmount > this.DAILY_LIMIT_USD) {
          await client.query('ROLLBACK');
          return {
            authorized: false,
            hourlySum,
            dailySum,
            rejectionReason: `DAILY_LIMIT_EXCEEDED: Request would push 24-hour outflow to $${(dailySum + requestedAmount).toFixed(2)}, exceeding limit of $${this.DAILY_LIMIT_USD.toFixed(2)}.`
          };
        }

        record.status = 'SIGNING';
        record.signedAt = new Date().toISOString();
        await client.query(
          `INSERT INTO hot_wallet_transactions (
            id, idempotency_key, tx_hash, chain_id, network, token, token_contract,
            amount, destination, destination_label, confirmation_count, status,
            operator, requested_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'SIGNING', $12, $13, NOW())
          ON CONFLICT (id) DO UPDATE SET
            amount = EXCLUDED.amount,
            destination = EXCLUDED.destination,
            destination_label = EXCLUDED.destination_label,
            status = 'SIGNING',
            updated_at = NOW()`,
          [
            record.id,
            record.idempotencyKey,
            record.txHash,
            record.chainId,
            record.network,
            record.token,
            record.tokenContract,
            requestedAmount,
            record.destination,
            record.destinationLabel || null,
            record.confirmationCount,
            record.operator,
            record.requestedAt
          ]
        );

        await client.query(
          `INSERT INTO hot_wallet_idempotency (idempotency_key, tx_id, status, created_at)
           VALUES ($1, $2, 'SIGNING', NOW())
           ON CONFLICT (idempotency_key) DO UPDATE SET status = 'SIGNING'`,
          [record.idempotencyKey, record.id]
        );

        await client.query('COMMIT');
        this.transactions.set(record.id, record);
        this.idempotencyMap.set(record.idempotencyKey, record.id);
        return { authorized: true, hourlySum, dailySum };
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        if (process.env.NODE_ENV === 'production') {
          return {
            authorized: false,
            hourlySum: 0,
            dailySum: 0,
            rejectionReason: `PRODUCTION_DB_TRANSACTION_ERROR: Atomic velocity reservation failed: ${err.message}`
          };
        }
      } finally {
        client.release();
      }
    } else if (process.env.NODE_ENV === 'production') {
      return {
        authorized: false,
        hourlySum: 0,
        dailySum: 0,
        rejectionReason: 'PRODUCTION_FAIL_CLOSED: PostgreSQL database is unavailable for atomic withdrawal authorization.'
      };
    }

    const { hourlySum, dailySum } = await this.getPersistentVelocityUsage();
    if (hourlySum + requestedAmount > this.HOURLY_LIMIT_USD) {
      return {
        authorized: false,
        hourlySum,
        dailySum,
        rejectionReason: `HOURLY_LIMIT_EXCEEDED: Request would push 1-hour outflow to $${(hourlySum + requestedAmount).toFixed(2)}, exceeding limit of $${this.HOURLY_LIMIT_USD.toFixed(2)}.`
      };
    }
    if (dailySum + requestedAmount > this.DAILY_LIMIT_USD) {
      return {
        authorized: false,
        hourlySum,
        dailySum,
        rejectionReason: `DAILY_LIMIT_EXCEEDED: Request would push 24-hour outflow to $${(dailySum + requestedAmount).toFixed(2)}, exceeding limit of $${this.DAILY_LIMIT_USD.toFixed(2)}.`
      };
    }
    return { authorized: true, hourlySum, dailySum };
  }

  /**
   * Persistent Nonce Coordination & Collision Verification (Requirement 5 & 6):
   * Verifies both latest (mined) and pending (mempool) transaction counts on-chain.
   * Rejects with NONCE_COLLISION if a conflicting pending transaction is detected on-chain
   * or if the local nonce state is out of sync with unverified pending nonces.
   */
  public async acquirePersistentNonce(
    address: string,
    network: string,
    provider: JsonRpcProvider
  ): Promise<number> {
    const [latestOnchainNonce, pendingOnchainNonce] = await Promise.all([
      provider.getTransactionCount(address, 'latest'),
      provider.getTransactionCount(address, 'pending')
    ]);

    // Check if there is an unexplained gap between pending and latest on-chain nonces
    if (pendingOnchainNonce > latestOnchainNonce) {
      const hasKnownInFlightTx = Array.from(this.transactions.values()).some(
        tx =>
          (tx.status === 'BROADCAST' || tx.status === 'PENDING_CONFIRMATION' || tx.status === 'SIGNING') &&
          tx.nonce !== undefined &&
          tx.nonce >= latestOnchainNonce &&
          tx.nonce < pendingOnchainNonce
      );
      if (!hasKnownInFlightTx) {
        throw new Error(
          `NONCE_COLLISION: On-chain pending nonce (${pendingOnchainNonce}) exceeds mined nonce (${latestOnchainNonce}) due to an unknown external pending transaction. Halting to prevent nonce collision or duplicate withdrawal.`
        );
      }
    }

    if (pgDbService.isLiveDatabaseConnected()) {
      const client = await pgDbService.getClient();
      try {
        await client.query('BEGIN');
        const res = await client.query(
          `SELECT last_assigned_nonce FROM hot_wallet_nonce_state 
           WHERE network = $1 AND address = $2 FOR UPDATE`,
          [network, address]
        );

        let lastDbNonce = -1;
        if (res.rows.length > 0) {
          lastDbNonce = Number(res.rows[0].last_assigned_nonce);
        }

        const nextNonce = Math.max(lastDbNonce + 1, pendingOnchainNonce, this.lastAssignedNonce + 1);

        await client.query(
          `INSERT INTO hot_wallet_nonce_state (network, address, last_assigned_nonce, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (network, address) DO UPDATE SET
             last_assigned_nonce = EXCLUDED.last_assigned_nonce,
             updated_at = NOW()`,
          [network, address, nextNonce]
        );
        await client.query('COMMIT');

        this.lastAssignedNonce = nextNonce;
        return nextNonce;
      } catch (err: any) {
        await client.query('ROLLBACK');
        console.warn('[HOT WALLET] Nonce DB transaction error, falling back:', err.message);
      } finally {
        client.release();
      }
    }

    const safeNonce = Math.max(pendingOnchainNonce, this.lastAssignedNonce + 1);
    this.lastAssignedNonce = safeNonce;
    return safeNonce;
  }

  /**
   * Records an internal treasury deposit ONLY after verifying an actual BSC on-chain transaction.
   */
  public async recordInternalDeposit(params: {
    txId: string;
    txHash?: string;
    amountUsd: number;
    source: string;
    operator: string;
  }): Promise<HotWalletTransaction> {
    const candidateHash = String(params.txHash || params.txId || '').trim();
    if (!/^0x[a-fA-F0-9]{64}$/.test(candidateHash)) {
      throw new Error(
        'SYNTHETIC_DEPOSIT_FORBIDDEN: An internal treasury deposit can only be recorded after an actual BSC transaction (0x + 64 hex chars) is found and verified on-chain. Synthetic or unverified deposits are forbidden.'
      );
    }

    const verified = await this.verifyAndRecordOnchainDeposit({
      txHash: candidateHash,
      expectedAmount: params.amountUsd,
      operator: params.operator
    });

    if (!verified.success || !verified.transactionRecord) {
      throw new Error(
        `SYNTHETIC_DEPOSIT_FORBIDDEN: On-chain BSC verification failed for ${candidateHash}: ${verified.error || 'Transaction not verified on BSC mainnet'}`
      );
    }

    return verified.transactionRecord;
  }

  /**
   * Verifies an actual on-chain BEP-20 USDT deposit on the BSC blockchain.
   */
  public async verifyAndRecordOnchainDeposit(params: {
    txHash: string;
    expectedAmount?: number;
    operator?: string;
  }): Promise<{
    success: boolean;
    txHash?: string;
    blockNumber?: number;
    confirmationCount?: number;
    amount?: number;
    sender?: string;
    recipient?: string;
    error?: string;
    transactionRecord?: HotWalletTransaction;
  }> {
    const { txHash, expectedAmount, operator = 'system' } = params;
    const wallet = this.initWallet();
    const targetAddress = wallet ? wallet.address : this.getConfiguredPublicAddress();
    if (!targetAddress) {
      return { success: false, error: 'Treasury hot wallet is unconfigured.' };
    }

    try {
      const { provider, network } = await this.getProvider('BSC');
      await this.validateUsdtContract(provider, network.usdtAddress);

      const receipt = await provider.getTransactionReceipt(txHash);

      if (!receipt) {
        return { success: false, error: `TRANSACTION_NOT_FOUND: No receipt found on BSC mainnet for hash ${txHash}` };
      }

      if (receipt.status !== 1) {
        return { success: false, error: 'TRANSACTION_REVERTED: The transaction failed on the blockchain.' };
      }

      const currentBlock = await provider.getBlockNumber();
      const confirmations = Math.max(1, currentBlock - receipt.blockNumber + 1);

      const iface = new ethers.Interface(ERC20_ABI);
      let foundTransfer = false;
      let transferFrom = '';
      let transferTo = '';
      let transferAmount = 0;

      for (const log of receipt.logs) {
        if (log.address.toLowerCase() === OFFICIAL_BSC_USDT_CONTRACT.toLowerCase()) {
          try {
            const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
            if (parsed && parsed.name === 'Transfer') {
              transferFrom = parsed.args[0];
              transferTo = parsed.args[1];
              transferAmount = Number(formatUnits(parsed.args[2], OFFICIAL_BSC_USDT_DECIMALS));
              if (transferTo.toLowerCase() === targetAddress.toLowerCase()) {
                foundTransfer = true;
                break;
              }
            }
          } catch {}
        }
      }

      if (!foundTransfer) {
        return {
          success: false,
          error: `NO_VALID_TRANSFER: Transaction is not a valid BEP-20 USDT transfer to hot wallet (${targetAddress}).`
        };
      }

      if (expectedAmount && Math.abs(transferAmount - expectedAmount) > 0.01) {
        return {
          success: false,
          error: `AMOUNT_MISMATCH: On-chain transfer was ${transferAmount} USDT, expected ${expectedAmount} USDT.`
        };
      }

      const isSufficientlyConfirmed = confirmations >= 15;
      const status: HotWalletTxState = isSufficientlyConfirmed ? 'CONFIRMED' : 'PENDING_CONFIRMATION';

      const txId = `dep_${Date.now()}_${txHash.slice(2, 10)}`;
      const record: HotWalletTransaction = {
        id: txId,
        idempotencyKey: `idemp_dep_${txHash}`,
        txHash,
        chainId: OFFICIAL_BSC_CHAIN_ID,
        network: 'BSC',
        token: 'USDT',
        tokenContract: OFFICIAL_BSC_USDT_CONTRACT,
        amount: transferAmount,
        destination: targetAddress,
        destinationLabel: `On-chain BEP-20 Deposit from ${transferFrom}`,
        gasUsed: receipt.gasUsed.toString(),
        blockNumber: receipt.blockNumber,
        confirmationCount: confirmations,
        status,
        operator,
        requestedAt: new Date().toISOString(),
        confirmedAt: isSufficientlyConfirmed ? new Date().toISOString() : undefined,
        explorerUrl: `${network.txExplorerUrl}${txHash}`
      };

      await this.persistTransaction(record);
      await this.recordPersistentIdempotency(record.idempotencyKey, record.id, record.status, record);

      return {
        success: true,
        txHash,
        blockNumber: receipt.blockNumber,
        confirmationCount: confirmations,
        amount: transferAmount,
        sender: transferFrom,
        recipient: transferTo,
        transactionRecord: record
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Executes a real on-chain BEP-20 USDT transfer from the internal hot wallet to a verified destination.
   * Strictly implements all 16 mandatory transaction safety steps (Requirement 5)
   * and safe mid-transaction RPC switching (Requirement 6):
   *
   * 1. Verify active RPC
   * 2. Verify Chain ID = 56
   * 3. Verify latest block is fresh
   * 4. Verify treasury wallet address
   * 5. Verify BNB gas balance (>= TREASURY_MIN_GAS_RESERVE_BNB)
   * 6. Verify USDT balance & official USDT contract (0x55d398326f99059fF775485246999027B3197955)
   * 7. Verify destination allowlist
   * 8. Verify transaction limits
   * 9. Verify persistent nonce & collision safety
   * 10. Sign transaction offline & compute deterministic txHash
   * 11. Broadcast through validated RPC (with safe RPC switching on mid-tx RPC failure)
   * 12. Record transaction hash
   * 13. Verify transaction receipt (never treat broadcast alone as settlement)
   * 14. Verify confirmations
   * 15. Persist final transaction state
   * 16. Reconcile treasury after completion
   */
  public async withdrawToBinance(params: {
    amountUsd?: number;
    networkId?: string;
    destinationAddress?: string;
    operator?: string;
    idempotencyKey?: string;
    tokenContractOverride?: string;
  }): Promise<{
    success: boolean;
    txHash?: string;
    blockNumber?: number;
    confirmationCount?: number;
    amountSent?: number;
    tokenSymbol: string;
    destinationAddress: string;
    network: string;
    explorerLink?: string;
    gasUsed?: string;
    rpcSwitched?: boolean;
    reconciledAfterTx?: boolean;
    reconciliationReport?: {
      reconciledCount: number;
      pendingCount: number;
      discrepancyDetected: boolean;
      onChainUsdtBalance: string;
      onChainBnbBalance: string;
    };
    message: string;
    errorDetails?: string;
    state?: HotWalletTxState;
    transactionRecord?: HotWalletTransaction;
  }> {
    const operator = params.operator || 'owner_operator';
    const idempotencyKey = params.idempotencyKey || `tx_idemp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const txId = `tx_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    // Concurrency Lock: Serialize all treasury withdrawals & idempotency checks under mutex
    let releaseLock: () => void;
    const nextLock = new Promise<void>(resolve => { releaseLock = resolve; });
    const currentLock = this.executionLock;
    this.executionLock = currentLock.then(() => nextLock);

    await currentLock;
    const record: HotWalletTransaction = {
      id: txId,
      idempotencyKey,
      txHash: null,
      chainId: OFFICIAL_BSC_CHAIN_ID,
      network: 'BSC',
      token: 'USDT',
      tokenContract: OFFICIAL_BSC_USDT_CONTRACT,
      amount: params.amountUsd || 0,
      destination: params.destinationAddress || '',
      confirmationCount: 0,
      status: 'REQUESTED',
      operator,
      requestedAt: new Date().toISOString()
    };

    try {
      // 0. Persistent Idempotency Replay Protection (Requirement 6 & 10)
      const existing = await this.checkPersistentIdempotency(idempotencyKey);
      if (existing) {
        return {
          success: existing.status === 'CONFIRMED',
          txHash: existing.txHash || undefined,
          blockNumber: existing.blockNumber,
          confirmationCount: existing.confirmationCount,
          amountSent: existing.amount,
          tokenSymbol: 'USDT',
          destinationAddress: existing.destination,
          network: existing.network,
          explorerLink: existing.explorerUrl,
          gasUsed: existing.gasUsed,
          state: existing.status,
          transactionRecord: existing,
          message: `Idempotent request returning existing transaction ${existing.id} with status ${existing.status}.`
        };
      }

      await this.persistTransaction(record);

      // -------------------------------------------------------------
      // VALIDATING PHASE (Steps 1 - 4 & Emergency Stop)
      // -------------------------------------------------------------
      record.status = 'VALIDATING';
      record.validatingAt = new Date().toISOString();
      await this.persistTransaction(record);

      if (this.isEmergencyHalted()) {
        record.status = 'REJECTED';
        record.failedAt = new Date().toISOString();
        record.rejectionReason = 'EMERGENCY_STOP_ACTIVE: Outflows are halted by emergency treasury kill switch.';
        await this.persistTransaction(record);
        await this.recordPersistentIdempotency(idempotencyKey, txId, 'REJECTED', record);
        return {
          success: false,
          tokenSymbol: 'USDT',
          destinationAddress: record.destination,
          network: 'BSC',
          state: 'REJECTED',
          message: record.rejectionReason,
          errorDetails: 'EMERGENCY_STOP_ACTIVE',
          transactionRecord: record
        };
      }

      // STEP 4: Verify treasury wallet address
      const wallet = this.initWallet();
      if (!wallet || !ethers.isAddress(wallet.address)) {
        record.status = 'REJECTED';
        record.failedAt = new Date().toISOString();
        record.rejectionReason = 'FAIL_CLOSED: Treasury hot wallet is unconfigured or invalid. Set TREASURY_HOT_WALLET_PRIVATE_KEY in production secret manager.';
        await this.persistTransaction(record);
        await this.recordPersistentIdempotency(idempotencyKey, txId, 'REJECTED', record);
        return {
          success: false,
          tokenSymbol: 'USDT',
          destinationAddress: record.destination,
          network: 'BSC',
          state: 'REJECTED',
          message: record.rejectionReason,
          errorDetails: 'UNCONFIGURED_HOT_WALLET',
          transactionRecord: record
        };
      }

      let network: NetworkConfig;
      try {
        network = this.getNetwork(params.networkId);
      } catch (err: any) {
        record.status = 'REJECTED';
        record.failedAt = new Date().toISOString();
        record.rejectionReason = err.message;
        await this.persistTransaction(record);
        await this.recordPersistentIdempotency(idempotencyKey, txId, 'REJECTED', record);
        return {
          success: false,
          tokenSymbol: 'USDT',
          destinationAddress: record.destination,
          network: params.networkId || 'UNKNOWN',
          state: 'REJECTED',
          message: err.message,
          errorDetails: 'INVALID_TREASURY_NETWORK',
          transactionRecord: record
        };
      }

      // Resolve destination address
      let destination = params.destinationAddress?.trim();
      if (!destination) {
        try {
          const binanceDep = await binanceTreasuryProvider.getDepositAddress('USDT', network.id);
          if (binanceDep?.address) {
            destination = binanceDep.address.trim();
          }
        } catch (err: any) {
          console.warn(`[HOT WALLET] Could not fetch Binance deposit target: ${err.message}`);
        }
      }

      if (!destination) {
        record.status = 'REJECTED';
        record.failedAt = new Date().toISOString();
        record.rejectionReason = 'DESTINATION_REQUIRED: No destination address provided and no Binance deposit address could be retrieved.';
        await this.persistTransaction(record);
        await this.recordPersistentIdempotency(idempotencyKey, txId, 'REJECTED', record);
        return {
          success: false,
          tokenSymbol: 'USDT',
          destinationAddress: '',
          network: network.id,
          state: 'REJECTED',
          message: record.rejectionReason,
          errorDetails: 'MISSING_DESTINATION',
          transactionRecord: record
        };
      }

      if (!ethers.isAddress(destination)) {
        record.status = 'REJECTED';
        record.failedAt = new Date().toISOString();
        record.rejectionReason = 'INVALID_DESTINATION: Destination address must be a valid EVM address format.';
        await this.persistTransaction(record);
        await this.recordPersistentIdempotency(idempotencyKey, txId, 'REJECTED', record);
        return {
          success: false,
          tokenSymbol: 'USDT',
          destinationAddress: destination,
          network: network.id,
          state: 'REJECTED',
          message: record.rejectionReason,
          errorDetails: 'INVALID_ADDRESS_FORMAT',
          transactionRecord: record
        };
      }
      record.destination = destination;

      // -------------------------------------------------------------
      // RISK CHECK PHASE (Steps 7, 8, 1, 2, 3, 5, 6)
      // -------------------------------------------------------------
      record.status = 'RISK_CHECK';
      record.riskCheckedAt = new Date().toISOString();
      await this.persistTransaction(record);

      // STEP 7: Verify destination allowlist (Fail-closed)
      const allowCheck = await verifiedProfitWithdrawalService.isAddressAllowlisted(destination, network.id, 'USDT');
      if (!allowCheck.allowed) {
        record.status = 'REJECTED';
        record.failedAt = new Date().toISOString();
        record.rejectionReason = allowCheck.error || 'Destination address is not approved in the withdrawal allowlist.';
        await this.persistTransaction(record);
        await this.recordPersistentIdempotency(idempotencyKey, txId, 'REJECTED', record);
        return {
          success: false,
          tokenSymbol: 'USDT',
          destinationAddress: destination,
          network: network.id,
          state: 'REJECTED',
          message: record.rejectionReason,
          errorDetails: 'DESTINATION_NOT_ALLOWLISTED',
          transactionRecord: record
        };
      }
      record.destinationLabel = allowCheck.label;

      // STEP 8 (Part A): Verify per-transaction minimum and maximum limits
      if (params.amountUsd !== undefined && params.amountUsd > 0) {
        if (params.amountUsd < this.MIN_WITHDRAWAL_USD) {
          record.status = 'REJECTED';
          record.failedAt = new Date().toISOString();
          record.rejectionReason = `INVALID_AMOUNT: Minimum withdrawal is $${this.MIN_WITHDRAWAL_USD.toFixed(2)} USDT (requested $${params.amountUsd.toFixed(2)}).`;
          await this.persistTransaction(record);
          await this.recordPersistentIdempotency(idempotencyKey, txId, 'REJECTED', record);
          return {
            success: false,
            tokenSymbol: 'USDT',
            destinationAddress: destination,
            network: network.id,
            state: 'REJECTED',
            message: record.rejectionReason,
            errorDetails: 'BELOW_MIN_WITHDRAWAL',
            transactionRecord: record
          };
        }

        if (params.amountUsd > this.MAX_WITHDRAWAL_PER_TX_USD) {
          record.status = 'REJECTED';
          record.failedAt = new Date().toISOString();
          record.rejectionReason = `LIMIT_EXCEEDED: Requested $${params.amountUsd.toFixed(2)} exceeds maximum per-transaction limit of $${this.MAX_WITHDRAWAL_PER_TX_USD.toFixed(2)}.`;
          await this.persistTransaction(record);
          await this.recordPersistentIdempotency(idempotencyKey, txId, 'REJECTED', record);
          return {
            success: false,
            tokenSymbol: 'USDT',
            destinationAddress: destination,
            network: network.id,
            state: 'REJECTED',
            message: record.rejectionReason,
            errorDetails: 'LIMIT_EXCEEDED',
            transactionRecord: record
          };
        }
      }

      // STEPS 1, 2, 3: Verify active RPC, Chain ID = 56, and fresh latest block
      let activeRpc = await this.getProvider(network.id);
      let provider = activeRpc.provider;
      let activeRawUrl = activeRpc.rawRpcUrl;
      record.activeRpcEndpoint = activeRpc.redactedRpcUrl;

      // Requirement 7: Verify official BSC USDT contract (0x55d398326f99059fF775485246999027B3197955)
      const contractValidation = await this.validateUsdtContract(
        provider,
        params.tokenContractOverride || network.usdtAddress
      );
      record.tokenContract = contractValidation.contractAddress;

      // STEPS 5 & 6: Verify live BNB gas balance and USDT balance on validated RPC
      const [gasBalanceWei, rawUsdtBalance] = await Promise.all([
        provider.getBalance(wallet.address),
        new Contract(contractValidation.contractAddress, ERC20_ABI, provider).balanceOf(wallet.address)
      ]);

      const gasNum = parseFloat(formatUnits(gasBalanceWei, 18));
      const usdtNum = parseFloat(formatUnits(rawUsdtBalance, contractValidation.decimals));

      const requestedAmount = params.amountUsd !== undefined && params.amountUsd > 0
        ? params.amountUsd
        : usdtNum;
      record.amount = requestedAmount;

      if (requestedAmount < this.MIN_WITHDRAWAL_USD) {
        record.status = 'REJECTED';
        record.failedAt = new Date().toISOString();
        record.rejectionReason = `INVALID_AMOUNT: Minimum withdrawal is $${this.MIN_WITHDRAWAL_USD.toFixed(2)} USDT (requested $${requestedAmount.toFixed(2)}).`;
        await this.persistTransaction(record);
        await this.recordPersistentIdempotency(idempotencyKey, txId, 'REJECTED', record);
        return {
          success: false,
          tokenSymbol: 'USDT',
          destinationAddress: destination,
          network: network.id,
          state: 'REJECTED',
          message: record.rejectionReason,
          errorDetails: 'BELOW_MIN_WITHDRAWAL',
          transactionRecord: record
        };
      }

      if (requestedAmount > this.MAX_WITHDRAWAL_PER_TX_USD) {
        record.status = 'REJECTED';
        record.failedAt = new Date().toISOString();
        record.rejectionReason = `LIMIT_EXCEEDED: Requested $${requestedAmount.toFixed(2)} exceeds maximum per-transaction limit of $${this.MAX_WITHDRAWAL_PER_TX_USD.toFixed(2)}.`;
        await this.persistTransaction(record);
        await this.recordPersistentIdempotency(idempotencyKey, txId, 'REJECTED', record);
        return {
          success: false,
          tokenSymbol: 'USDT',
          destinationAddress: destination,
          network: network.id,
          state: 'REJECTED',
          message: record.rejectionReason,
          errorDetails: 'LIMIT_EXCEEDED',
          transactionRecord: record
        };
      }

      // STEP 5: Verify BNB gas balance >= TREASURY_MIN_GAS_RESERVE_BNB (0.005 BNB)
      const minGasReserveBnb = this.getMinGasReserveBnb();
      if (gasNum < minGasReserveBnb) {
        record.status = 'REJECTED';
        record.failedAt = new Date().toISOString();
        record.rejectionReason = `INSUFFICIENT_GAS: Treasury hot wallet has ${gasNum.toFixed(4)} BNB, below minimum gas reserve (${minGasReserveBnb} BNB).`;
        await this.persistTransaction(record);
        await this.recordPersistentIdempotency(idempotencyKey, txId, 'REJECTED', record);
        return {
          success: false,
          tokenSymbol: 'USDT',
          destinationAddress: destination,
          network: network.id,
          state: 'REJECTED',
          message: record.rejectionReason,
          errorDetails: 'INSUFFICIENT_GAS',
          transactionRecord: record
        };
      }

      // STEP 6: Verify USDT balance
      if (usdtNum < requestedAmount) {
        record.status = 'REJECTED';
        record.failedAt = new Date().toISOString();
        record.rejectionReason = `INSUFFICIENT_USDT: Treasury hot wallet has ${usdtNum.toFixed(2)} USDT, below requested withdrawal of ${requestedAmount.toFixed(2)} USDT.`;
        await this.persistTransaction(record);
        await this.recordPersistentIdempotency(idempotencyKey, txId, 'REJECTED', record);
        return {
          success: false,
          tokenSymbol: 'USDT',
          destinationAddress: destination,
          network: network.id,
          state: 'REJECTED',
          message: record.rejectionReason,
          errorDetails: 'INSUFFICIENT_USDT',
          transactionRecord: record
        };
      }

      // STEP 8 (Part B): Atomic Database Transaction for Velocity-Limit Reservation
      const velocityAuth = await this.authorizeAndReserveWithdrawalVelocity(record, requestedAmount);
      if (!velocityAuth.authorized) {
        record.status = 'REJECTED';
        record.failedAt = new Date().toISOString();
        record.rejectionReason = velocityAuth.rejectionReason || 'VELOCITY_LIMIT_EXCEEDED';
        await this.persistTransaction(record);
        await this.recordPersistentIdempotency(idempotencyKey, txId, 'REJECTED', record);
        return {
          success: false,
          tokenSymbol: 'USDT',
          destinationAddress: destination,
          network: network.id,
          state: 'REJECTED',
          message: record.rejectionReason,
          errorDetails: 'VELOCITY_LIMIT_EXCEEDED',
          transactionRecord: record
        };
      }

      // -------------------------------------------------------------
      // STEP 9 & 10: VERIFY PERSISTENT NONCE & SIGN TRANSACTION
      // -------------------------------------------------------------
      record.status = 'SIGNING';
      record.signedAt = new Date().toISOString();

      const safeNonce = await this.acquirePersistentNonce(wallet.address, network.id, provider);
      record.nonce = safeNonce;

      const parsedAmount = parseUnits(requestedAmount.toString(), contractValidation.decimals);
      const iface = new ethers.Interface(ERC20_ABI);
      const callData = iface.encodeFunctionData('transfer', [destination, parsedAmount]);

      const gasPriceHex = await this.jsonRpcCall(
        activeRawUrl,
        'eth_gasPrice',
        [],
        parseInt(process.env.BSC_RPC_TIMEOUT_MS || '4000', 10)
      ).catch(() => '0xB2D05E00'); // 3 gwei fallback
      const gasPriceBigInt = BigInt(gasPriceHex || '0xB2D05E00');
      record.gasPrice = gasPriceBigInt.toString();
      record.gasLimit = '100000';

      // Sign transaction offline to obtain deterministic txHash BEFORE network broadcast
      const txRequest: ethers.TransactionRequest = {
        to: contractValidation.contractAddress,
        data: callData,
        value: 0n,
        nonce: safeNonce,
        gasLimit: 100000n,
        gasPrice: gasPriceBigInt,
        chainId: OFFICIAL_BSC_CHAIN_ID,
        type: 0
      };

      const signedRawTx = await wallet.signTransaction(txRequest);
      const preComputedTxHash = ethers.keccak256(signedRawTx);
      record.txHash = preComputedTxHash;
      record.explorerUrl = `${network.txExplorerUrl}${preComputedTxHash}`;
      await this.persistTransaction(record);

      // -------------------------------------------------------------
      // STEP 11 & 12: BROADCAST WITH SAFE RPC SWITCHING (Requirement 6)
      // -------------------------------------------------------------
      record.status = 'BROADCAST';
      record.broadcastAt = new Date().toISOString();
      await this.persistTransaction(record);

      const rpcTimeoutMs = Math.max(200, parseInt(process.env.BSC_RPC_TIMEOUT_MS || '4000', 10));
      let broadcastHash: string = preComputedTxHash;
      let rpcSwitched = false;

      try {
        const sentHash = await this.jsonRpcCall(activeRawUrl, 'eth_sendRawTransaction', [signedRawTx], rpcTimeoutMs);
        if (typeof sentHash === 'string' && sentHash.startsWith('0x')) {
          broadcastHash = sentHash;
        }
      } catch (broadcastErr: any) {
        const errMsg = String(broadcastErr.message || '');

        // Deterministic EVM / Nonce / Contract rejection -> Do NOT retry on another RPC
        if (
          errMsg.toLowerCase().includes('nonce too low') ||
          errMsg.toLowerCase().includes('nonce_expired') ||
          errMsg.toLowerCase().includes('already known') ||
          errMsg.toLowerCase().includes('replacement transaction underpriced')
        ) {
          record.status = 'FAILED';
          record.failedAt = new Date().toISOString();
          record.rejectionReason = `NONCE_COLLISION: ${errMsg}`;
          await this.persistTransaction(record);
          await this.recordPersistentIdempotency(idempotencyKey, txId, 'FAILED', record);
          return {
            success: false,
            txHash: preComputedTxHash,
            tokenSymbol: 'USDT',
            destinationAddress: destination,
            network: network.id,
            state: 'FAILED',
            message: record.rejectionReason,
            errorDetails: 'NONCE_COLLISION',
            transactionRecord: record
          };
        }

        if (
          errMsg.toLowerCase().includes('insufficient funds') ||
          errMsg.toLowerCase().includes('execution reverted') ||
          errMsg.toLowerCase().includes('gas required exceeds allowance')
        ) {
          record.status = 'FAILED';
          record.failedAt = new Date().toISOString();
          record.rejectionReason = `BROADCAST_FAILED: ${errMsg}`;
          await this.persistTransaction(record);
          await this.recordPersistentIdempotency(idempotencyKey, txId, 'FAILED', record);
          return {
            success: false,
            txHash: preComputedTxHash,
            tokenSymbol: 'USDT',
            destinationAddress: destination,
            network: network.id,
            state: 'FAILED',
            message: record.rejectionReason,
            errorDetails: 'BROADCAST_FAILED',
            transactionRecord: record
          };
        }

        // Active RPC failed or timed out during broadcast -> Execute Requirement 6 Safe RPC Switching Protocol
        let fallbackRpc: Awaited<ReturnType<typeof this.getProvider>>;
        try {
          fallbackRpc = await this.getProvider(network.id, { excludeRawEndpoints: [activeRawUrl] });
        } catch (noFallbackErr: any) {
          // Unknown broadcast result: active RPC failed mid-broadcast and no fallback RPC is available to inspect chain state
          record.status = 'PENDING_CONFIRMATION';
          record.rejectionReason = `UNKNOWN_BROADCAST_RESULT: Active RPC failed during broadcast (${errMsg}) and no fallback RPC is reachable to verify whether tx ${preComputedTxHash} landed on-chain.`;
          await this.persistTransaction(record);
          await this.recordPersistentIdempotency(idempotencyKey, txId, 'PENDING_CONFIRMATION', record);
          return {
            success: false,
            txHash: preComputedTxHash,
            tokenSymbol: 'USDT',
            destinationAddress: destination,
            network: network.id,
            state: 'PENDING_CONFIRMATION',
            message: record.rejectionReason,
            errorDetails: 'UNKNOWN_BROADCAST_RESULT',
            transactionRecord: record
          };
        }

        // Switch active RPC to validated fallback
        provider = fallbackRpc.provider;
        activeRawUrl = fallbackRpc.rawRpcUrl;
        rpcSwitched = true;
        record.rpcSwitched = true;
        record.activeRpcEndpoint = fallbackRpc.redactedRpcUrl;

        // STEP 6A: Before resending, check if the original transaction was already broadcast!
        const [existingReceipt, existingTx, fallbackLatestNonce, fallbackPendingNonce] = await Promise.all([
          provider.getTransactionReceipt(preComputedTxHash).catch(() => null),
          provider.getTransaction(preComputedTxHash).catch(() => null),
          provider.getTransactionCount(wallet.address, 'latest'),
          provider.getTransactionCount(wallet.address, 'pending')
        ]);

        if (existingReceipt || existingTx) {
          // Original broadcast DID reach the network! Do NOT resend!
          console.log(`[HOT WALLET] RPC switched to ${fallbackRpc.redactedRpcUrl}: Found tx ${preComputedTxHash} already on-chain. Skipping duplicate broadcast.`);
        } else if (fallbackLatestNonce > safeNonce || fallbackPendingNonce > safeNonce) {
          // Nonce advanced on-chain, but our txHash is not found -> Nonce collision!
          record.status = 'FAILED';
          record.failedAt = new Date().toISOString();
          record.rejectionReason = `NONCE_COLLISION: After RPC switch, on-chain nonce (${fallbackPendingNonce}) advanced past transaction nonce (${safeNonce}) without matching txHash ${preComputedTxHash}. Halting to prevent duplicate withdrawal.`;
          await this.persistTransaction(record);
          await this.recordPersistentIdempotency(idempotencyKey, txId, 'FAILED', record);
          return {
            success: false,
            txHash: preComputedTxHash,
            tokenSymbol: 'USDT',
            destinationAddress: destination,
            network: network.id,
            rpcSwitched: true,
            state: 'FAILED',
            message: record.rejectionReason,
            errorDetails: 'NONCE_COLLISION',
            transactionRecord: record
          };
        } else {
          // Reconcile wallet state and safely broadcast the exact same signedRawTx (identical nonce & txHash)
          await this.reconcileWithBlockchain();
          const retryHash = await this.jsonRpcCall(activeRawUrl, 'eth_sendRawTransaction', [signedRawTx], rpcTimeoutMs);
          if (typeof retryHash === 'string' && retryHash.startsWith('0x')) {
            broadcastHash = retryHash;
          }
        }
      }

      record.txHash = broadcastHash;
      record.explorerUrl = `${network.txExplorerUrl}${broadcastHash}`;
      record.status = 'PENDING_CONFIRMATION';
      await this.persistTransaction(record);
      await this.recordPersistentIdempotency(idempotencyKey, txId, 'PENDING_CONFIRMATION', record);

      // -------------------------------------------------------------
      // STEP 13 & 14: VERIFY RECEIPT & CONFIRMATIONS
      // Never treat successful RPC submission alone as settlement!
      // -------------------------------------------------------------
      const receiptTimeoutMs = Math.max(200, parseInt(process.env.BSC_RECEIPT_TIMEOUT_MS || '15000', 10));
      const pollIntervalMs = Math.min(250, Math.max(50, Math.floor(receiptTimeoutMs / 5)));
      const requiredConfirmations = Math.max(1, parseInt(process.env.BSC_REQUIRED_CONFIRMATIONS || '1', 10));
      const deadline = Date.now() + receiptTimeoutMs;

      let receipt: ethers.TransactionReceipt | null = null;
      let confirmations = 0;

      while (Date.now() < deadline) {
        try {
          receipt = await provider.getTransactionReceipt(broadcastHash);
          if (receipt) {
            const currentBlock = await provider.getBlockNumber();
            confirmations = Math.max(1, currentBlock - receipt.blockNumber + 1);
            if (confirmations >= requiredConfirmations) {
              break;
            }
          }
        } catch (pollErr: any) {
          // If active RPC fails during receipt polling, switch to fallback RPC without resending
          try {
            const fb = await this.getProvider(network.id, { excludeRawEndpoints: [activeRawUrl] });
            provider = fb.provider;
            activeRawUrl = fb.rawRpcUrl;
            rpcSwitched = true;
            record.rpcSwitched = true;
            record.activeRpcEndpoint = fb.redactedRpcUrl;
          } catch {}
        }
        await new Promise(r => setTimeout(r, pollIntervalMs));
      }

      if (!receipt) {
        record.status = 'PENDING_CONFIRMATION';
        record.rejectionReason = `RECEIPT_TIMEOUT: Transaction ${broadcastHash} was broadcast, but no receipt was confirmed within ${receiptTimeoutMs}ms. Settlement is NOT claimed.`;
        await this.persistTransaction(record);
        await this.recordPersistentIdempotency(idempotencyKey, txId, 'PENDING_CONFIRMATION', record);
        return {
          success: false,
          txHash: broadcastHash,
          tokenSymbol: 'USDT',
          destinationAddress: destination,
          network: network.id,
          rpcSwitched,
          state: 'PENDING_CONFIRMATION',
          message: record.rejectionReason,
          errorDetails: 'RECEIPT_TIMEOUT',
          transactionRecord: record
        };
      }

      if (receipt.status !== 1) {
        record.status = 'FAILED';
        record.failedAt = new Date().toISOString();
        record.rejectionReason = 'TRANSACTION_REVERTED_ON_CHAIN';
        await this.persistTransaction(record);
        await this.recordPersistentIdempotency(idempotencyKey, txId, 'FAILED', record);
        return {
          success: false,
          txHash: broadcastHash,
          blockNumber: receipt.blockNumber,
          tokenSymbol: 'USDT',
          destinationAddress: destination,
          network: network.id,
          rpcSwitched,
          state: 'FAILED',
          message: 'Blockchain transaction executed but was REVERTED on-chain.',
          errorDetails: 'TRANSACTION_REVERTED_ON_CHAIN',
          transactionRecord: record
        };
      }

      if (confirmations < requiredConfirmations) {
        record.status = 'PENDING_CONFIRMATION';
        record.blockNumber = receipt.blockNumber;
        record.confirmationCount = confirmations;
        record.rejectionReason = `INSUFFICIENT_CONFIRMATIONS: Observed ${confirmations} confirmations, required ${requiredConfirmations}.`;
        await this.persistTransaction(record);
        await this.recordPersistentIdempotency(idempotencyKey, txId, 'PENDING_CONFIRMATION', record);
        return {
          success: false,
          txHash: broadcastHash,
          blockNumber: receipt.blockNumber,
          confirmationCount: confirmations,
          tokenSymbol: 'USDT',
          destinationAddress: destination,
          network: network.id,
          rpcSwitched,
          state: 'PENDING_CONFIRMATION',
          message: record.rejectionReason,
          errorDetails: 'INSUFFICIENT_CONFIRMATIONS',
          transactionRecord: record
        };
      }

      // -------------------------------------------------------------
      // STEP 15: PERSIST FINAL TRANSACTION STATE
      // -------------------------------------------------------------
      record.status = 'CONFIRMED';
      record.confirmedAt = new Date().toISOString();
      record.blockNumber = receipt.blockNumber;
      record.gasUsed = receipt.gasUsed ? receipt.gasUsed.toString() : 'Unknown';
      record.confirmationCount = confirmations;
      record.rejectionReason = undefined;
      await this.persistTransaction(record);
      await this.recordPersistentIdempotency(idempotencyKey, txId, 'CONFIRMED', record);

      // -------------------------------------------------------------
      // STEP 16: RECONCILE TREASURY AFTER COMPLETION
      // -------------------------------------------------------------
      const reconciliationReport = await this.reconcileWithBlockchain();
      record.reconciledAfterTx = !reconciliationReport.discrepancyDetected;
      await this.persistTransaction(record);

      try {
        db.logAuditEvent(
          'ON_CHAIN_WITHDRAWAL',
          'INFO',
          `On-chain withdrawal of ${requestedAmount.toFixed(2)} USDT to ${destination} confirmed on ${network.name}`,
          {
            txHash: broadcastHash,
            blockNumber: receipt.blockNumber,
            confirmations,
            network: network.id,
            destination,
            gasUsed: record.gasUsed,
            amount: requestedAmount,
            rpcSwitched,
            reconciledAfterTx: record.reconciledAfterTx,
            operator
          }
        );
      } catch {}

      return {
        success: true,
        txHash: broadcastHash,
        blockNumber: receipt.blockNumber,
        confirmationCount: confirmations,
        amountSent: requestedAmount,
        tokenSymbol: 'USDT',
        destinationAddress: destination,
        network: network.id,
        explorerLink: record.explorerUrl,
        gasUsed: record.gasUsed,
        rpcSwitched,
        reconciledAfterTx: record.reconciledAfterTx,
        reconciliationReport,
        state: 'CONFIRMED',
        transactionRecord: record,
        message: `Successfully broadcast, confirmed (${confirmations} confirmations), and reconciled on-chain withdrawal of ${requestedAmount.toFixed(2)} USDT!`
      };
    } catch (err: any) {
      record.status = 'FAILED';
      record.failedAt = new Date().toISOString();
      record.rejectionReason = err.message || 'Execution failed';
      await this.persistTransaction(record);
      await this.recordPersistentIdempotency(idempotencyKey, txId, 'FAILED', record);

      const errCode = err.message?.includes('TREASURY_RPC_UNAVAILABLE')
        ? 'TREASURY_RPC_UNAVAILABLE'
        : err.message?.includes('UNAUTHORIZED_USDT_CONTRACT') || err.message?.includes('USDT_CONTRACT_')
        ? 'UNAUTHORIZED_USDT_CONTRACT'
        : err.message?.includes('NONCE_COLLISION')
        ? 'NONCE_COLLISION'
        : err.reason || err.shortMessage || err.message;

      return {
        success: false,
        tokenSymbol: 'USDT',
        destinationAddress: record.destination,
        network: 'BSC',
        state: 'FAILED',
        message: `Blockchain transaction failed: ${err.message || 'Execution reverted'}`,
        errorDetails: errCode,
        transactionRecord: record
      };
    } finally {
      releaseLock!();
    }
  }

  /**
   * Continuous / On-demand Reconciliation with Blockchain (Requirement 5.16 & 10).
   */
  public async reconcileWithBlockchain(): Promise<{
    reconciledCount: number;
    pendingCount: number;
    discrepancyDetected: boolean;
    discrepancyMessage?: string;
    onChainUsdtBalance: string;
    onChainBnbBalance: string;
  }> {
    const wallet = this.initWallet();
    if (!wallet) {
      return {
        reconciledCount: 0,
        pendingCount: 0,
        discrepancyDetected: false,
        onChainUsdtBalance: '0.00',
        onChainBnbBalance: '0.0000'
      };
    }

    let reconciledCount = 0;
    let pendingCount = 0;
    let onChainUsdtBalance = '0.00';
    let onChainBnbBalance = '0.0000';

    try {
      const { provider } = await this.getProvider('BSC');

      // Reconcile in-memory pending transactions
      for (const tx of this.transactions.values()) {
        if ((tx.status === 'BROADCAST' || tx.status === 'PENDING_CONFIRMATION') && tx.txHash) {
          pendingCount++;
          const receipt = await provider.getTransactionReceipt(tx.txHash).catch(() => null);
          if (receipt) {
            const currentBlock = await provider.getBlockNumber();
            tx.confirmationCount = Math.max(1, currentBlock - receipt.blockNumber + 1);
            tx.blockNumber = receipt.blockNumber;
            tx.gasUsed = receipt.gasUsed ? receipt.gasUsed.toString() : tx.gasUsed;
            tx.status = receipt.status === 1 ? 'CONFIRMED' : 'FAILED';
            if (tx.status === 'CONFIRMED') {
              tx.confirmedAt = new Date().toISOString();
            } else {
              tx.failedAt = new Date().toISOString();
            }
            this.transactions.set(tx.id, tx);
            reconciledCount++;
          }
        }
      }

      // Check all pending or broadcast transactions in persistent ledger
      if (pgDbService.isLiveDatabaseConnected()) {
        try {
          const pendingRes = await pgDbService.query(
            `SELECT * FROM hot_wallet_transactions WHERE status IN ('BROADCAST', 'PENDING_CONFIRMATION')`
          );

          for (const row of pendingRes.rows) {
            pendingCount++;
            if (row.tx_hash) {
              const receipt = await provider.getTransactionReceipt(row.tx_hash);
              if (receipt) {
                const currentBlock = await provider.getBlockNumber();
                const confirmations = Math.max(1, currentBlock - receipt.blockNumber + 1);
                const status = receipt.status === 1 ? 'CONFIRMED' : 'FAILED';

                await pgDbService.query(
                  `UPDATE hot_wallet_transactions SET
                     status = $1,
                     block_number = $2,
                     gas_used = $3,
                     confirmation_count = $4,
                     confirmed_at = CASE WHEN $1 = 'CONFIRMED' THEN NOW() ELSE NULL END,
                     failed_at = CASE WHEN $1 = 'FAILED' THEN NOW() ELSE NULL END,
                     updated_at = NOW()
                   WHERE id = $5`,
                  [status, receipt.blockNumber, receipt.gasUsed.toString(), confirmations, row.id]
                );
                reconciledCount++;
              }
            }
          }
        } catch (e: any) {
          console.warn('[HOT WALLET RECONCILIATION] DB query error:', e.message);
        }
      }

      const bal = await this.getLiveBalances('BSC');
      if (bal.rpcAvailable === false || bal.balanceVerified === false) {
        return {
          reconciledCount,
          pendingCount,
          discrepancyDetected: true,
          discrepancyMessage: bal.error || 'TREASURY_RPC_UNAVAILABLE',
          onChainUsdtBalance: '0.00',
          onChainBnbBalance: '0.0000'
        };
      }

      onChainUsdtBalance = bal.usdtBalance;
      onChainBnbBalance = bal.gasBalance;

      return {
        reconciledCount,
        pendingCount,
        discrepancyDetected: false,
        onChainUsdtBalance,
        onChainBnbBalance
      };
    } catch (err: any) {
      console.warn(`[HOT WALLET RECONCILIATION] Error: ${err.message}`);
      return {
        reconciledCount,
        pendingCount,
        discrepancyDetected: true,
        discrepancyMessage: err.message,
        onChainUsdtBalance,
        onChainBnbBalance
      };
    }
  }

  public async getTransactionsPersistent(limit: number = 20): Promise<HotWalletTransaction[]> {
    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        const res = await pgDbService.query(
          `SELECT * FROM hot_wallet_transactions ORDER BY requested_at DESC LIMIT $1`,
          [limit]
        );
        if (res.rows.length > 0) {
          return res.rows.map(r => this.mapDbRowToTransaction(r));
        }
      } catch (e: any) {
        console.warn('[HOT WALLET] Error querying transactions from DB:', e.message);
      }
    }
    return this.getTransactions(limit);
  }

  public getTransactions(limit: number = 20): HotWalletTransaction[] {
    return Array.from(this.transactions.values())
      .sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime())
      .slice(0, limit);
  }

  public async getTransactionById(txId: string): Promise<HotWalletTransaction | null> {
    if (this.transactions.has(txId)) {
      return this.transactions.get(txId)!;
    }

    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        const res = await pgDbService.query(
          `SELECT * FROM hot_wallet_transactions WHERE id = $1`,
          [txId]
        );
        if (res.rows.length > 0) {
          return this.mapDbRowToTransaction(res.rows[0]);
        }
      } catch (e: any) {
        console.warn('[HOT WALLET] Error querying tx by ID:', e.message);
      }
    }
    return null;
  }
}

export const hotWalletService = new HotWalletService();
