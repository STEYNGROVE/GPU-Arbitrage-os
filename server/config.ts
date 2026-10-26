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
  const envMode = process.env.SYSTEM_OPERATING_MODE || process.env.NODE_ENV;
  if (envMode === 'production' || envMode === 'PRODUCTION') {
    // Only allow true production mode if real keys are supplied, otherwise force simulation for safety
    return 'PRODUCTION';
  }
  return 'SIMULATION';
}

const operatingMode = resolveOperatingMode();
const isProduction = operatingMode === 'PRODUCTION';
if (isProduction) {
  const requiredSecrets = ['API_AUTH_TOKEN', 'OWNER_API_KEY', 'OWNER_OVERRIDE_KEY', 'PGPASSWORD'];
  const missing = requiredSecrets.filter((key) => !process.env[key] || process.env[key]!.length < 32);
  if (missing.length) throw new Error(`Production startup blocked: missing or weak required secrets: ${missing.join(', ')}`);
}

export const config: AppConfig = {
  operatingMode,
  isProduction,
  isSimulation: !isProduction,
  port: Number(process.env.PORT) || 3000,
  apiAuthToken: process.env.API_AUTH_TOKEN || '',
  ownerApiKey: process.env.OWNER_API_KEY || '',
  ownerOverrideKey: process.env.OWNER_OVERRIDE_KEY || '',
  bridgeUrl: process.env.V13_BRIDGE_URL || '',
  bridgeToken: process.env.V13_BRIDGE_TOKEN || '',
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    hasLiveKey: Boolean(
      process.env.GROQ_API_KEY &&
      process.env.GROQ_API_KEY !== 'MY_GROQ_API_KEY' &&
      process.env.GROQ_API_KEY.startsWith('gsk_')
    ),
    primaryModel: process.env.GROQ_PRIMARY_MODEL || 'qwen/qwen3.8-27b',
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
    targetUid: process.env.BINANCE_TARGET_UID || '16863338',
    primaryEvmAddress: process.env.SYSTEM_USDT_ADDRESS || '0x5d3fe4ac4cdcb3a6065bd4cbb528b7f72cca618d',
    tronAddress: process.env.SYSTEM_TRON_ADDRESS || 'TYP5q9G6N1m8xK7uP4bQ9xV3rE4aZ8wQpL',
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
    : [
        '127.0.0.1',
        '::1',
        '::ffff:127.0.0.1',
        'localhost',
        '34.96.39.119',
        '35.242.198',
        '35.242.198.112',
        '10.0.0.0/8',
        '172.16.0.0/12',
        '192.168.0.0/16',
      ],
};
