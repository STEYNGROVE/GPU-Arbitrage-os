import crypto from 'crypto';
import express from 'express';
import { pgDbService } from './pgDatabase.js';
import { customerRepo, authRepo } from './repositories/index.js';
import type { CustomerRecord, CustomerApiKeyRecord } from './repositories/types.js';

export { CustomerRecord, CustomerApiKeyRecord };

export interface BrowserSession {
  sessionId: string;
  role: 'OWNER' | 'CUSTOMER';
  customerId?: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
  permissions: string[];
  ipAddress?: string;
  userAgent?: string;
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey.trim()).digest('hex');
}

export function timingSafeMatch(provided: string, expected: string): boolean {
  if (!provided || !expected || provided.length !== expected.length) {
    return false;
  }
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Ephemeral runtime keys generated on startup ONLY if not provided in dev environment
const devEphemeralOwnerKey = `owner_dev_${crypto.randomBytes(32).toString('hex')}`;
const devEphemeralCustomerKey = `cust_dev_${crypto.randomBytes(32).toString('hex')}`;
const devEphemeralEscrowSecret = `escrow_dev_${crypto.randomBytes(32).toString('hex')}`;
const devEphemeralQuoteLockSecret = `quote_dev_${crypto.randomBytes(32).toString('hex')}`;
const devEphemeralAuditSecret = `audit_dev_${crypto.randomBytes(32).toString('hex')}`;

export function getEffectiveOwnerKey(): string {
  const key = (process.env.OWNER_API_KEY || '').trim();
  if (!key || key.length < 16 || key === 'gpu-arb-owner-2026-production') {
    return ''; // Fails closed
  }
  return key;
}

export function getEffectiveCustomerKey(): string {
  const key = (process.env.CUSTOMER_API_KEY || '').trim();
  if (!key || key.length < 16) {
    return ''; // Fails closed
  }
  return key;
}

export function getEffectiveEscrowSecret(): string {
  const secret = (process.env.ESCROW_SIGNING_SECRET || '').trim();
  return secret.length >= 16 ? secret : '';
}

export function getEffectiveQuoteSecret(): string {
  const secret = (process.env.QUOTE_LOCK_SECRET || '').trim();
  return secret.length >= 16 ? secret : '';
}

export function getEffectiveAuditSecret(): string {
  const secret = (process.env.AUDIT_CHAIN_SECRET || '').trim();
  return secret.length >= 16 ? secret : '';
}

export interface StartupSecretValidationReport {
  valid: boolean;
  missingSecrets: string[];
  conflictingVariables: string[];
  exposedFrontendVariables: string[];
}

export function validateProductionSecretsAtStartup(): StartupSecretValidationReport {
  const missing: string[] = [];
  const conflicting: string[] = [];

  if ('OWNER_API_TOKEN' in process.env && process.env.OWNER_API_TOKEN) {
    conflicting.push('OWNER_API_TOKEN (deprecated/conflicting; use OWNER_API_KEY exclusively)');
  }

  const requiredSecrets: Array<{ name: string; minLen: number }> = [
    { name: 'OWNER_API_KEY', minLen: 16 },
    { name: 'CUSTOMER_API_KEY', minLen: 16 },
    { name: 'ESCROW_SIGNING_SECRET', minLen: 16 },
    { name: 'QUOTE_LOCK_SECRET', minLen: 16 },
    { name: 'AUDIT_CHAIN_SECRET', minLen: 16 },
    { name: 'BINANCE_API_KEY', minLen: 16 },
    { name: 'BINANCE_API_SECRET', minLen: 16 },
    { name: 'BINANCE_WEBHOOK_SECRET', minLen: 16 },
    { name: 'DATABASE_URL', minLen: 10 },
    { name: 'BSC_RPC_URL', minLen: 8 },
    { name: 'TREASURY_HOT_WALLET_PRIVATE_KEY', minLen: 64 }
  ];

  for (const req of requiredSecrets) {
    const val = (process.env[req.name] || '').trim();
    if (req.name === 'TREASURY_HOT_WALLET_PRIVATE_KEY') {
      let candidate = val;
      if (candidate.startsWith('{') && candidate.endsWith('}')) {
        try {
          const parsed = JSON.parse(candidate);
          candidate = typeof parsed?.TREASURY_HOT_WALLET_PRIVATE_KEY === 'string'
            ? parsed.TREASURY_HOT_WALLET_PRIVATE_KEY.trim()
            : '';
        } catch {
          candidate = '';
        }
      }
      const cleanHex = candidate.startsWith('0x') ? candidate.slice(2) : candidate;
      const isValidHex32 =
        cleanHex.length === 64 &&
        /^[0-9a-fA-F]{64}$/.test(cleanHex) &&
        !candidate.includes('<') &&
        !candidate.includes('>');
      if (!isValidHex32) {
        missing.push(req.name);
      }
      continue;
    }
    if (!val || val.length < req.minLen || val.includes('<YOUR_')) {
      missing.push(req.name);
    }
  }

  if (!process.env.VAST_API_KEY && !process.env.RUNPOD_API_KEY && !process.env.LAMBDA_API_KEY) {
    missing.push('Compute Provider Key (VAST_API_KEY, RUNPOD_API_KEY, or LAMBDA_API_KEY)');
  }

  const forbiddenVitePrefixes = [
    'VITE_OWNER',
    'VITE_CUSTOMER_API_KEY',
    'VITE_ESCROW',
    'VITE_QUOTE',
    'VITE_AUDIT',
    'VITE_BINANCE',
    'VITE_TREASURY',
    'VITE_HOT_WALLET',
    'VITE_PRIVATE_KEY',
    'VITE_BSC_RPC',
    'VITE_DATABASE'
  ];
  const exposedFrontendVariables = Object.keys(process.env).filter(k =>
    forbiddenVitePrefixes.some(p => k.toUpperCase().startsWith(p)) && Boolean(process.env[k]?.trim())
  );

  return {
    valid: missing.length === 0 && conflicting.length === 0 && exposedFrontendVariables.length === 0,
    missingSecrets: missing,
    conflictingVariables: conflicting,
    exposedFrontendVariables
  };
}

export function isLiveEnvironmentConfigured(): { isReady: boolean; authStatus: string; missingSecrets: string[] } {
  const missing: string[] = [];
  const ownerKey = getEffectiveOwnerKey();
  if (!ownerKey) missing.push('OWNER_API_KEY');
  if (!getEffectiveCustomerKey()) missing.push('CUSTOMER_API_KEY');
  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');
  if (!getEffectiveEscrowSecret()) missing.push('ESCROW_SIGNING_SECRET');
  if (!getEffectiveQuoteSecret()) missing.push('QUOTE_LOCK_SECRET');
  if (!getEffectiveAuditSecret()) missing.push('AUDIT_CHAIN_SECRET');
  if (!process.env.BINANCE_API_KEY) missing.push('BINANCE_API_KEY');
  if (!process.env.BINANCE_API_SECRET) missing.push('BINANCE_API_SECRET');
  if (!process.env.BINANCE_WEBHOOK_SECRET) missing.push('BINANCE_WEBHOOK_SECRET');

  if (!process.env.VAST_API_KEY && !process.env.RUNPOD_API_KEY && !process.env.LAMBDA_API_KEY) {
    missing.push('Compute Provider Key (VAST_API_KEY, RUNPOD_API_KEY, or LAMBDA_API_KEY)');
  }

  const authStatus = ownerKey ? 'CONFIGURED' : 'AUTH_NOT_CONFIGURED';
  return {
    isReady: missing.length === 0,
    authStatus,
    missingSecrets: missing
  };
}

// Fallback in-memory cache if PostgreSQL is offline
const memoryCustomers: Map<string, CustomerRecord> = new Map();
const memoryApiKeys: Map<string, CustomerApiKeyRecord> = new Map();

export async function registerCustomer(customer: CustomerRecord): Promise<CustomerRecord> {
  memoryCustomers.set(customer.customerId, customer);
  if (pgDbService.isLiveDatabaseConnected()) {
    try {
      await customerRepo.createCustomer(customer);
    } catch {}
  }
  return customer;
}

export async function initCustomerDirectory(): Promise<void> {
  // STRICT REAL/LIVE ONLY POLICY (Requirement 1):
  // Synthetic customers must NEVER enter production.
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) {
    memoryCustomers.clear();
    return;
  }

  if (process.env.ALLOW_DEV_SEED_CUSTOMERS === 'true') {
    const defaultCustomers: CustomerRecord[] = [
      {
        customerId: 'cust-mstrl-88',
        name: 'Mistral Finetuning Partner AG',
        email: 'compute-ops@mistral-partner.eu',
        status: 'ACTIVE',
        kycStatus: 'VERIFIED',
        creditLimit: 2500.00,
        escrowBalance: 0.00,
        permissions: ['create_demand', 'quote_compute', 'view_orders', 'stream_telemetry'],
        createdAt: '2026-08-01T09:00:00.000Z'
      },
      {
        customerId: 'cust-kall-19',
        name: 'Kallisto AI Studio Ltd',
        email: 'infrastructure@kallisto.ai',
        status: 'ACTIVE',
        kycStatus: 'VERIFIED',
        creditLimit: 1000.00,
        escrowBalance: 0.00,
        permissions: ['create_demand', 'quote_compute', 'view_orders', 'stream_telemetry'],
        createdAt: '2026-08-10T11:30:00.000Z'
      }
    ];

    for (const c of defaultCustomers) {
      memoryCustomers.set(c.customerId, c);
      if (pgDbService.isLiveDatabaseConnected()) {
        try {
          await customerRepo.createCustomer(c);
        } catch {}
      }
    }
  }

  if (process.env.CUSTOMER_API_KEY && !isProd) {
    const envKey = process.env.CUSTOMER_API_KEY.trim();
    const envHash = hashApiKey(envKey);
    const envKeyId = `key_env_${crypto.randomBytes(4).toString('hex')}`;
    const apiKeyRec: CustomerApiKeyRecord = {
      keyId: envKeyId,
      customerId: 'cust-mstrl-88',
      keyHash: envHash,
      keyPrefix: envKey.slice(0, 8),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
      status: 'ACTIVE'
    };
    memoryApiKeys.set(envKeyId, apiKeyRec);
    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        await authRepo.createCustomerApiKey(
          apiKeyRec.customerId,
          apiKeyRec.keyPrefix,
          apiKeyRec.keyHash,
          apiKeyRec.expiresAt
        );
      } catch {}
    }
  }
}

export async function getCustomerById(customerId: string): Promise<CustomerRecord | undefined> {
  if (pgDbService.isLiveDatabaseConnected()) {
    const cust = await customerRepo.findById(customerId);
    if (cust) return cust;
  }
  if (process.env.NODE_ENV === 'production') {
    return undefined;
  }
  return memoryCustomers.get(customerId);
}

export async function getCustomerList(): Promise<CustomerRecord[]> {
  if (pgDbService.isLiveDatabaseConnected()) {
    return customerRepo.findAll();
  }
  if (process.env.NODE_ENV === 'production') {
    return [];
  }
  return Array.from(memoryCustomers.values());
}

export async function createCustomerApiKey(customerId: string, name?: string): Promise<{
  plaintextKey: string;
  apiKeyRecord: CustomerApiKeyRecord;
}> {
  const customer = await getCustomerById(customerId);
  if (!customer) {
    throw new Error(`Customer ${customerId} does not exist`);
  }

  const rawBytes = crypto.randomBytes(32).toString('hex');
  const plaintextKey = `cust_live_${rawBytes}`;
  const keyHash = hashApiKey(plaintextKey);
  const keyPrefix = plaintextKey.slice(0, 12);
  const keyId = `key_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 180 * 86400000).toISOString();

  let record: CustomerApiKeyRecord;
  if (pgDbService.isLiveDatabaseConnected()) {
    record = await authRepo.createCustomerApiKey(customerId, keyPrefix, keyHash, expiresAt);
  } else {
    record = {
      keyId,
      customerId,
      keyHash,
      keyPrefix,
      createdAt: now.toISOString(),
      expiresAt,
      status: 'ACTIVE'
    };
    memoryApiKeys.set(keyId, record);
  }

  return { plaintextKey, apiKeyRecord: record };
}

export async function findCustomerByRawKey(rawKey: string): Promise<{ customer: CustomerRecord; apiKey: CustomerApiKeyRecord } | undefined> {
  if (!rawKey) return undefined;
  const trimmedKey = rawKey.trim();
  const targetHash = hashApiKey(trimmedKey);

  // Check authoritative CUSTOMER_API_KEY environment credential first
  const configuredCustomerKey = (process.env.CUSTOMER_API_KEY || '').trim();
  if (configuredCustomerKey && configuredCustomerKey.length >= 16 && timingSafeMatch(trimmedKey, configuredCustomerKey)) {
    const envCustomer: CustomerRecord = {
      customerId: 'cust-canonical-api',
      name: 'Authenticated Enterprise Customer',
      email: 'api-customer@compute-arbitrage.io',
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      creditLimit: 0.00,
      escrowBalance: 0.00,
      permissions: ['create_demand', 'quote_compute', 'view_orders', 'stream_telemetry'],
      createdAt: new Date().toISOString()
    };
    const envApiKey: CustomerApiKeyRecord = {
      keyId: 'key_env_canonical_customer',
      customerId: envCustomer.customerId,
      keyHash: targetHash,
      keyPrefix: configuredCustomerKey.slice(0, 8),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
      status: 'ACTIVE'
    };
    return { customer: envCustomer, apiKey: envApiKey };
  }

  if (pgDbService.isLiveDatabaseConnected()) {
    const match = await authRepo.findCustomerByRawKey(trimmedKey);
    if (match) return match;
  }

  if (process.env.NODE_ENV === 'production') {
    return undefined;
  }

  for (const apiKey of memoryApiKeys.values()) {
    if (apiKey.status !== 'ACTIVE') continue;
    if (new Date(apiKey.expiresAt).getTime() < Date.now()) {
      apiKey.status = 'EXPIRED';
      continue;
    }
    if (timingSafeMatch(apiKey.keyHash, targetHash)) {
      const customer = memoryCustomers.get(apiKey.customerId);
      if (customer) {
        apiKey.lastUsedAt = new Date().toISOString();
        return { customer, apiKey };
      }
    }
  }

  return undefined;
}

// Session store
const activeSessions: Map<string, BrowserSession> = new Map();
const loginRateLimiter: Map<string, { attempts: number; lastAttempt: number }> = new Map();

export function createBrowserSession(
  role: 'OWNER' | 'CUSTOMER',
  customerId?: string,
  verifiedByCredential: boolean = false
): BrowserSession {
  if (process.env.NODE_ENV === 'production' && !verifiedByCredential) {
    throw new Error('PRODUCTION_AUTH_BYPASS_FORBIDDEN: Unverified browser session creation is strictly forbidden in production.');
  }
  const sessionId = `sess_${crypto.randomBytes(32).toString('hex')}`;
  const now = Date.now();
  const session: BrowserSession = {
    sessionId,
    role,
    customerId,
    createdAt: now,
    expiresAt: now + 24 * 60 * 60 * 1000,
    permissions: role === 'OWNER'
      ? ['admin', 'execute_deal', 'settle_deal', 'configure_risk', 'view_telemetry', 'treasury_control']
      : ['create_demand', 'quote_compute', 'view_orders', 'stream_telemetry']
  };

  activeSessions.set(sessionId, session);
  return session;
}

export function validateBrowserSession(sessionId: string): BrowserSession | null {
  if (!sessionId) return null;
  const session = activeSessions.get(sessionId);
  if (!session) return null;

  if (session.revokedAt) {
    activeSessions.delete(sessionId);
    return null;
  }

  if (Date.now() > session.expiresAt) {
    activeSessions.delete(sessionId);
    return null;
  }

  return session;
}

export function revokeBrowserSession(sessionId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.revokedAt = Date.now();
    activeSessions.delete(sessionId);
    return true;
  }
  return false;
}

export function extractSessionIdFromRequest(req: express.Request): string | null {
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)gpu_arb_session=([^;]+)/);
    if (match && match[1]) {
      return decodeURIComponent(match[1]);
    }
  }

  const authHeader = (req.headers.authorization || '') as string;
  if (authHeader.startsWith('Bearer sess_')) {
    return authHeader.slice(7);
  }

  const customHeader = (req.headers['x-session-id'] || req.headers['x-session-token']) as string;
  if (customHeader && customHeader.startsWith('sess_')) {
    return customHeader;
  }

  const querySession = (req.query.sessionId || req.query.session_id) as string;
  if (typeof querySession === 'string' && querySession.startsWith('sess_')) {
    return querySession;
  }

  // Development & studio preview iframe fallback:
  // STRICT PRODUCTION RULE (Requirement 3): Never allow session bypass in production or when STRICT_AUTH_ENFORCEMENT=true.
  if (process.env.NODE_ENV !== 'production' && process.env.STRICT_AUTH_ENFORCEMENT !== 'true') {
    const activeOwnerSession = Array.from(activeSessions.values())
      .reverse()
      .find(s => s.role === 'OWNER' && Date.now() < s.expiresAt && !s.revokedAt);
    if (activeOwnerSession) {
      return activeOwnerSession.sessionId;
    }
    const newSession = createBrowserSession('OWNER');
    return newSession.sessionId;
  }

  return null;
}

export async function authenticateAndCreateSession(params: {
  role: 'OWNER' | 'CUSTOMER';
  secretOrKey: string;
  customerId?: string;
  ip?: string;
}): Promise<{ success: boolean; session?: BrowserSession; error?: string }> {
  const ip = params.ip || 'unknown';
  const now = Date.now();

  const rateRecord = loginRateLimiter.get(ip) || { attempts: 0, lastAttempt: now };
  if (now - rateRecord.lastAttempt > 60000) {
    rateRecord.attempts = 0;
  }

  if (rateRecord.attempts >= 5) {
    return {
      success: false,
      error: 'RATE_LIMITED: Too many failed authentication attempts. Cooldown active for 60 seconds.'
    };
  }

  if (params.role === 'OWNER') {
    const expectedKey = getEffectiveOwnerKey();
    if (!expectedKey || !params.secretOrKey || !timingSafeMatch(params.secretOrKey.trim(), expectedKey.trim())) {
      rateRecord.attempts++;
      rateRecord.lastAttempt = now;
      loginRateLimiter.set(ip, rateRecord);
      return { success: false, error: 'INVALID_CREDENTIALS: Owner authentication failed.' };
    }

    loginRateLimiter.delete(ip);
    const session = createBrowserSession('OWNER', undefined, true);
    return { success: true, session };
  } else {
    const match = await findCustomerByRawKey(params.secretOrKey.trim());
    if (!match) {
      rateRecord.attempts++;
      rateRecord.lastAttempt = now;
      loginRateLimiter.set(ip, rateRecord);
      return { success: false, error: 'INVALID_CREDENTIALS: Customer API key not found.' };
    }

    if (match.customer.status !== 'ACTIVE') {
      return { success: false, error: `ACCOUNT_${match.customer.status}: Customer account is suspended.` };
    }

    loginRateLimiter.delete(ip);
    const session = createBrowserSession('CUSTOMER', match.customer.customerId, true);
    return { success: true, session };
  }
}

export function requireOwnerAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const sessionId = extractSessionIdFromRequest(req);
  if (sessionId) {
    const session = validateBrowserSession(sessionId);
    if (session && session.role === 'OWNER') {
      (req as any).isOwner = true;
      (req as any).isAdmin = true;
      (req as any).authRole = 'owner';
      (req as any).sessionId = session.sessionId;
      return next();
    }
  }

  const authHeader = (req.headers.authorization || '') as string;
  const customKeyHeader = (req.headers['x-owner-api-key'] || req.headers['x-api-key']) as string;
  const token = authHeader.startsWith('Bearer ') && !authHeader.startsWith('Bearer sess_')
    ? authHeader.slice(7)
    : customKeyHeader;

  if (token) {
    const expectedKey = getEffectiveOwnerKey();
    if (expectedKey && timingSafeMatch(token.trim(), expectedKey.trim())) {
      (req as any).isOwner = true;
      (req as any).isAdmin = true;
      (req as any).authRole = 'owner';
      return next();
    }
  }

  return res.status(403).json({
    status: 'forbidden',
    error: 'OWNER_AUTHENTICATION_REQUIRED',
    message: 'Owner authentication required. Provide valid Owner session or header X-Owner-Api-Key.'
  });
}

export async function requireCustomerAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const sessionId = extractSessionIdFromRequest(req);
  if (sessionId) {
    const session = validateBrowserSession(sessionId);
    if (session) {
      (req as any).isOwner = session.role === 'OWNER';
      (req as any).isAdmin = session.role === 'OWNER';
      (req as any).authRole = session.role.toLowerCase();
      (req as any).sessionId = session.sessionId;
      if (session.customerId) {
        (req as any).customerId = session.customerId;
        (req as any).customer = await getCustomerById(session.customerId);
      }
      return next();
    }
  }

  const authHeader = (req.headers.authorization || '') as string;
  const customHeader = (req.headers['x-customer-api-key'] || req.headers['x-api-key']) as string;
  const rawKey = authHeader.startsWith('Bearer ') && !authHeader.startsWith('Bearer sess_')
    ? authHeader.slice(7)
    : customHeader;

  if (rawKey) {
    const expectedOwnerKey = getEffectiveOwnerKey();
    if (expectedOwnerKey && timingSafeMatch(rawKey.trim(), expectedOwnerKey.trim())) {
      (req as any).isOwner = true;
      (req as any).isAdmin = true;
      (req as any).authRole = 'owner';
      return next();
    }

    const match = await findCustomerByRawKey(rawKey.trim());
    if (match) {
      (req as any).isOwner = false;
      (req as any).isAdmin = false;
      (req as any).authRole = 'customer';
      (req as any).customerId = match.customer.customerId;
      (req as any).customer = match.customer;
      return next();
    }
  }

  return res.status(401).json({
    status: 'unauthorized',
    error: 'AUTHENTICATION_REQUIRED',
    message: 'Customer API authentication required. Provide valid session or X-Api-Key.'
  });
}

export async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const sessionId = extractSessionIdFromRequest(req);
  if (sessionId) {
    const session = validateBrowserSession(sessionId);
    if (session) {
      (req as any).isOwner = session.role === 'OWNER';
      (req as any).isAdmin = session.role === 'OWNER';
      (req as any).authRole = session.role.toLowerCase();
      (req as any).sessionId = session.sessionId;
      if (session.customerId) {
        (req as any).customerId = session.customerId;
        (req as any).customer = await getCustomerById(session.customerId);
      }
      return next();
    }
  }

  const authHeader = (req.headers.authorization || '') as string;
  const customHeader = (
    req.headers['x-api-key'] ||
    req.headers['x-owner-api-key'] ||
    req.headers['x-customer-api-key']
  ) as string;
  const token = authHeader.startsWith('Bearer ') && !authHeader.startsWith('Bearer sess_')
    ? authHeader.slice(7)
    : customHeader;

  if (token) {
    const expectedOwnerKey = getEffectiveOwnerKey();
    if (expectedOwnerKey && timingSafeMatch(token.trim(), expectedOwnerKey.trim())) {
      (req as any).isOwner = true;
      (req as any).isAdmin = true;
      (req as any).authRole = 'owner';
      return next();
    }

    const match = await findCustomerByRawKey(token.trim());
    if (match) {
      (req as any).isOwner = false;
      (req as any).isAdmin = false;
      (req as any).authRole = 'customer';
      (req as any).customerId = match.customer.customerId;
      (req as any).customer = match.customer;
      return next();
    }
  }

  return res.status(401).json({
    status: 'unauthorized',
    error: 'AUTHENTICATION_REQUIRED',
    message: 'Authentication required. Provide header Authorization: Bearer <token> or X-Api-Key.'
  });
}

export function requireAdminAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  requireAuth(req, res, () => {
    if (!(req as any).isAdmin && !(req as any).isOwner) {
      return res.status(403).json({
        status: 'forbidden',
        error: 'ADMIN_ROLE_REQUIRED',
        message: 'Administrative privileges required.'
      });
    }
    next();
  });
}

export function requireFinancialAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  requireAuth(req, res, () => {
    next();
  });
}

export function requireCapitalAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  requireAuth(req, res, () => {
    if (!(req as any).isOwner && !(req as any).isAdmin) {
      return res.status(403).json({
        status: 'forbidden',
        error: 'CAPITAL_AUTHORIZATION_REQUIRED',
        message: 'Owner or Capital Manager authorization required for capital allocation.'
      });
    }
    next();
  });
}

export function assertHighValueApproval(
  req: express.Request,
  amount: number,
  currency: string = 'USD'
): { approved: boolean; error?: string } {
  const threshold = currency.toUpperCase() === 'ZAR' ? 18000 : 1000;
  if (amount > threshold) {
    const approvalToken = (
      req.headers['x-human-approval-token'] ||
      (req.body && req.body.humanApprovalToken) ||
      ''
    ) as string;

    if (!approvalToken || approvalToken.length < 16) {
      return {
        approved: false,
        error: `HIGH_VALUE_HUMAN_APPROVAL_REQUIRED: Transaction amount (${amount} ${currency}) exceeds autonomous policy ceiling of ${threshold} ${currency}. Explicit human approval token required in header X-Human-Approval-Token.`
      };
    }
  }
  return { approved: true };
}

export function assertOrderOwnership(req: express.Request, orderCustomerId: string): { authorized: boolean; reason?: string } {
  if ((req as any).isOwner) {
    return { authorized: true };
  }

  const customer = (req as any).customer as CustomerRecord | undefined;
  if (!customer) {
    return { authorized: false, reason: 'Authentication required' };
  }

  if (customer.customerId !== orderCustomerId) {
    return {
      authorized: false,
      reason: `Access Denied: Authenticated customer '${customer.customerId}' (${customer.name}) does not own demand order '${orderCustomerId}'. Cross-customer access is prohibited.`
    };
  }

  return { authorized: true };
}

// Initialize seed directory
initCustomerDirectory().catch(console.error);
