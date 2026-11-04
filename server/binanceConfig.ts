import crypto from 'crypto';

export interface BinanceConfig {
  enabled: boolean;
  apiKey: string;
  apiSecret: string;
  env: 'production' | 'testnet';
  baseUrl: string;
  treasuryAsset: string;
  minReserve: number;
  maxSingleExposure: number;
  maxDailyExposure: number;
  withdrawalsEnabled: boolean;
  recvWindow: number;
}

export interface BinanceConfigValidationResult {
  valid: boolean;
  configured: boolean;
  config: BinanceConfig;
  errors: string[];
  warnings: string[];
}

/**
 * Mask secret strings so they are never printed in logs or error traces
 */
export function maskSecret(secret?: string | null): string {
  if (!secret) return '[EMPTY]';
  if (secret.length <= 8) return '****';
  return `${secret.substring(0, 4)}...${secret.substring(secret.length - 4)}`;
}

/**
 * Read and strictly parse Binance configuration from server-side environment variables
 */
export function getBinanceConfig(): BinanceConfig {
  const enabledStr = process.env.BINANCE_ENABLED;
  const enabled = enabledStr !== undefined ? enabledStr === 'true' || enabledStr === '1' : true;

  const apiKey = (process.env.BINANCE_API_KEY || '').trim();
  const apiSecret = (process.env.BINANCE_API_SECRET || '').trim();
  const envRaw = (process.env.BINANCE_ENV || 'production').toLowerCase().trim();
  const env: 'production' | 'testnet' = envRaw === 'testnet' ? 'testnet' : 'production';

  const defaultBaseUrl = env === 'testnet' 
    ? 'https://testnet.binance.vision' 
    : 'https://api.binance.com';
  const baseUrl = (process.env.BINANCE_BASE_URL || defaultBaseUrl).trim();

  const treasuryAsset = (process.env.BINANCE_TREASURY_ASSET || 'USDT').toUpperCase().trim();
  const minReserve = Math.max(0, Number(process.env.BINANCE_MIN_RESERVE !== undefined ? process.env.BINANCE_MIN_RESERVE : process.env.BINANCE_MIN_RESERVE_USD) || 100.00);
  const maxSingleExposure = Math.max(1, Number(process.env.BINANCE_MAX_SINGLE_EXPOSURE !== undefined ? process.env.BINANCE_MAX_SINGLE_EXPOSURE : process.env.BINANCE_MAX_SINGLE_EXPOSURE_USD) || 500.00);
  const maxDailyExposure = Math.max(maxSingleExposure, Number(process.env.BINANCE_MAX_DAILY_EXPOSURE !== undefined ? process.env.BINANCE_MAX_DAILY_EXPOSURE : process.env.BINANCE_MAX_DAILY_EXPOSURE_USD) || 2000.00);
  
  // Strict security default: withdrawals MUST default to disabled
  const withdrawalsEnabled = process.env.BINANCE_WITHDRAWALS_ENABLED === 'true';

  const recvWindow = Math.min(60000, Math.max(1000, Number(process.env.BINANCE_RECV_WINDOW) || 5000));

  return {
    enabled,
    apiKey,
    apiSecret,
    env,
    baseUrl,
    treasuryAsset,
    minReserve,
    maxSingleExposure,
    maxDailyExposure,
    withdrawalsEnabled,
    recvWindow
  };
}

/**
 * Validate Binance configuration strictly for production readiness
 * Rejects invalid, weak, or dangerous configurations without leaking secrets
 */
export function validateBinanceConfig(): BinanceConfigValidationResult {
  const config = getBinanceConfig();
  const errors: string[] = [];
  const warnings: string[] = [];

  const configured = Boolean(config.apiKey && config.apiSecret);

  if (!config.enabled) {
    warnings.push('Binance treasury provider is explicitly disabled via BINANCE_ENABLED=false.');
  }

  if (!configured) {
    errors.push('BINANCE_API_KEY and BINANCE_API_SECRET must be configured.');
  } else {
    if (config.apiKey.length < 16) {
      errors.push('BINANCE_API_KEY entropy insufficient (must be at least 16 characters).');
    }
    if (config.apiSecret.length < 16) {
      errors.push('BINANCE_API_SECRET entropy insufficient (must be at least 16 characters).');
    }
    if (config.apiKey === config.apiSecret) {
      errors.push('BINANCE_API_KEY and BINANCE_API_SECRET must not be identical.');
    }
  }

  if (config.minReserve < 0) {
    errors.push('BINANCE_MIN_RESERVE cannot be negative.');
  }

  if (config.maxSingleExposure <= 0) {
    errors.push('BINANCE_MAX_SINGLE_EXPOSURE must be greater than zero.');
  }

  if (config.maxDailyExposure < config.maxSingleExposure) {
    errors.push('BINANCE_MAX_DAILY_EXPOSURE must be greater than or equal to BINANCE_MAX_SINGLE_EXPOSURE.');
  }

  if (!['USDT', 'USDC', 'USD', 'BTC', 'ETH', 'BNB'].includes(config.treasuryAsset)) {
    warnings.push(`BINANCE_TREASURY_ASSET '${config.treasuryAsset}' is non-standard. Prefer USDT or USDC for stable treasury operations.`);
  }

  if (config.withdrawalsEnabled) {
    warnings.push('SECURITY ALERT: BINANCE_WITHDRAWALS_ENABLED is set to TRUE. Outbound crypto withdrawals are active.');
  }

  return {
    valid: errors.length === 0,
    configured,
    config,
    errors,
    warnings
  };
}
