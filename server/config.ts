import dotenv from 'dotenv';
dotenv.config();

export type OperatingMode = 'PRODUCTION' | 'SIMULATION' | 'SANDBOX';

export interface AppConfig {
  operatingMode: OperatingMode;
  isProduction: boolean;
  isSimulation: boolean;
  port: number;
  apiAuthToken: string;
  ownerApiKey: string;
  ownerOverrideKey: string;
  bridgeUrl: string;
  bridgeToken: string;
  appUrl: string;
  geminiApiKey: string;
  groq: {
    apiKey: string;
    hasLiveKey: boolean;
    primaryModel: string;
    baseUrl?: string;
    enabled?: boolean;
  };
  binance: {
    apiKey: string;
    secretKey: string;
    hasLiveKeys: boolean;
    targetUid: string;
    primaryEvmAddress: string;
    tronAddress: string;
  };
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password?: string;
    hasConfiguredPassword: boolean;
  };
  payfast: {
    merchantId: string;
    merchantKey: string;
    passphrase?: string;
    sandbox: boolean;
    notifyUrl: string;
  };
  gotyme: {
    partnerId: string;
    clientSecret?: string;
    sandbox: boolean;
  };
  github: {
    repo: string;
    token?: string;
    committerEmail: string;
    committerName: string;
  };
  trustedIps: string[];
}

function resolveOperatingMode(): OperatingMode {
  const envMode = process.env.SYSTEM_OPERATING_MODE;
  if (envMode === 'PRODUCTION' || envMode === 'production') {
    return 'PRODUCTION';
  }
  return 'SIMULATION';
}

const operatingMode = resolveOperatingMode();
const isProduction = operatingMode === 'PRODUCTION';
if (isProduction) {
  const requiredSecrets = ['API_AUTH_TOKEN', 'OWNER_API_KEY', 'OWNER_OVERRIDE_KEY', 'PGPASSWORD'];
  const missing = requiredSecrets.filter((key) => !process.env[key] || process.env[key]!.length < 32);
  const authSecrets = ['API_AUTH_TOKEN', 'OWNER_API_KEY'].map((key) => process.env[key]);
  if (new Set(authSecrets).size !== authSecrets.length) throw new Error('Production secrets must be independent.');
  if (missing.length) throw new Error(`Production startup blocked: missing or weak required secrets: ${missing.join(', ')}`);
}

const defaultOperatorKey = 'gpu_arb_simulation_operator_key_32c';
const defaultOwnerKey = 'gpu_arb_simulation_owner_master_key_32c';

export const config: AppConfig = {
  operatingMode,
  isProduction,
  isSimulation: !isProduction,
  port: Number(process.env.PORT) || 3000,
  apiAuthToken: process.env.API_AUTH_TOKEN || (isProduction ? '' : defaultOperatorKey),
  ownerApiKey: process.env.OWNER_API_KEY || (isProduction ? '' : defaultOwnerKey),
  ownerOverrideKey: process.env.OWNER_OVERRIDE_KEY || '',
  bridgeUrl: process.env.V13_BRIDGE_URL || '',
  bridgeToken: process.env.V13_BRIDGE_TOKEN || '',
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  groq: {
    apiKey: process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'YOUR_GROQ_API_KEY_HERE' ? process.env.GROQ_API_KEY : '',
    hasLiveKey: Boolean(
      process.env.GROQ_API_KEY &&
      process.env.GROQ_API_KEY !== 'MY_GROQ_API_KEY' &&
      process.env.GROQ_API_KEY !== 'YOUR_GROQ_API_KEY_HERE' &&
      process.env.GROQ_API_KEY.startsWith('gsk_')
    ),
    primaryModel: process.env.GROQ_MODEL || process.env.GROQ_PRIMARY_MODEL || 'llama-3.3-70b-versatile',
    baseUrl: process.env.GROQ_API_BASE_URL || 'https://api.groq.com/openai/v1',
    enabled: process.env.GROQ_ENABLED !== 'false',
  },
  binance: {
    apiKey: process.env.BINANCE_API_KEY || '',
    secretKey: process.env.BINANCE_SECRET_KEY || '',
    hasLiveKeys: Boolean(
      process.env.BINANCE_API_KEY &&
      process.env.BINANCE_SECRET_KEY &&
      process.env.BINANCE_API_KEY !== 'MY_BINANCE_API_KEY' &&
      process.env.BINANCE_SECRET_KEY !== 'MY_BINANCE_SECRET_KEY'
    ),
    targetUid: process.env.BINANCE_TARGET_UID || '',
    primaryEvmAddress: process.env.SYSTEM_USDT_ADDRESS || '',
    tronAddress: process.env.SYSTEM_TRON_ADDRESS || '',
  },
  postgres: {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT) || 5432,
    database: process.env.PGDATABASE || 'arbitrage_v13',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || process.env.DB_PASSWORD,
    hasConfiguredPassword: Boolean(
      (process.env.PGPASSWORD && process.env.PGPASSWORD !== 'your_secure_password') ||
      (process.env.DB_PASSWORD && process.env.DB_PASSWORD !== 'your_secure_password')
    ),
  },
  payfast: {
    merchantId: process.env.PAYFAST_MERCHANT_ID || '', // Default official PayFast sandbox ID
    merchantKey: process.env.PAYFAST_MERCHANT_KEY || '', // Official PayFast sandbox key
    passphrase: process.env.PAYFAST_PASSPHRASE || '',
    sandbox: process.env.PAYFAST_SANDBOX !== 'false',
    notifyUrl: process.env.PAYFAST_NOTIFY_URL || '/api/payments/payfast/notify',
  },
  gotyme: {
    partnerId: process.env.GOTYME_PARTNER_ID || '',
    clientSecret: process.env.GOTYME_CLIENT_SECRET,
    sandbox: process.env.GOTYME_SANDBOX !== 'false',
  },
  github: {
    repo: process.env.GITHUB_UPSTREAM_REPO || 'STEYNGROVE/GPU-Arbitrage-os',
    token: process.env.GITHUB_ACCESS_TOKEN && !process.env.GITHUB_ACCESS_TOKEN.includes('your_private')
      ? process.env.GITHUB_ACCESS_TOKEN
      : undefined,
    committerEmail: process.env.GITHUB_COMMITTER_EMAIL || '',
    committerName: process.env.GITHUB_COMMITTER_NAME || 'GPU Arbitrage OS',
  },
  trustedIps: process.env.TRUSTED_IPS
    ? process.env.TRUSTED_IPS.split(',').map((ip) => ip.trim()).filter(Boolean)
    : ['127.0.0.1', '::1'],
};
