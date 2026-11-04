import dotenv from 'dotenv';
import fs from 'fs';

// 1. LOAD ENVIRONMENT FIRST BEFORE ANY MODULE READS SECRETS
const initialEnv = { ...process.env };
dotenv.config();

// Normalize AWS Secrets Manager JSON-wrapped secrets if injected directly into process.env
for (const envVarName of [
  'DATABASE_URL',
  'DIRECT_URL',
  'SUPABASE_DB_URL',
  'POSTGRES_URL',
  'TREASURY_HOT_WALLET_PRIVATE_KEY',
  'OWNER_API_KEY',
  'CUSTOMER_API_KEY',
  'ESCROW_SIGNING_SECRET',
  'QUOTE_LOCK_SECRET',
  'AUDIT_CHAIN_SECRET',
  'BINANCE_API_KEY',
  'BINANCE_API_SECRET',
  'BINANCE_WEBHOOK_SECRET'
]) {
  for (const target of [initialEnv, process.env]) {
    const rawVal = target[envVarName]?.trim();
    if (rawVal && rawVal.startsWith('{') && rawVal.endsWith('}')) {
      try {
        const parsed = JSON.parse(rawVal);
        if (parsed && typeof parsed[envVarName] === 'string') {
          target[envVarName] = parsed[envVarName].trim();
        }
      } catch {}
    }
  }
}

// If container's TREASURY_HOT_WALLET_PRIVATE_KEY was inadvertently set to a 42-char address or placeholder, clear it so it fails closed safely
if (
  process.env.TREASURY_HOT_WALLET_PRIVATE_KEY &&
  (process.env.TREASURY_HOT_WALLET_PRIVATE_KEY.length === 42 ||
    process.env.TREASURY_HOT_WALLET_PRIVATE_KEY.includes('<') ||
    process.env.TREASURY_HOT_WALLET_PRIVATE_KEY.includes('>'))
) {
  delete process.env.TREASURY_HOT_WALLET_PRIVATE_KEY;
}

// Ensure non-empty container environment variables are preserved over empty .env values
for (const [key, val] of Object.entries(initialEnv)) {
  if (val && val.trim() !== '') {
    if (key === 'TREASURY_HOT_WALLET_PRIVATE_KEY' && val.length === 42 && process.env.TREASURY_HOT_WALLET_PRIVATE_KEY?.length === 66) {
      continue;
    }
    process.env[key] = val;
  }
}

// Standardize authentication variable: migrate & remove conflicting OWNER_API_TOKEN so OWNER_API_KEY is used exclusively
if (process.env.OWNER_API_TOKEN) {
  if (!process.env.OWNER_API_KEY) {
    process.env.OWNER_API_KEY = process.env.OWNER_API_TOKEN;
  }
  delete process.env.OWNER_API_TOKEN;
}


// Ensure authoritative public BSC wallet address is set if not explicitly provided
if (!process.env.TREASURY_HOT_WALLET_ADDRESS) {
  process.env.TREASURY_HOT_WALLET_ADDRESS = '0x19FaF16d0a8fb7EdBf31b4AbeC06bc4Bfbf9467B';
}
if (typeof (BigInt.prototype as any).toJSON !== 'function') {
  (BigInt.prototype as any).toJSON = function () {
    const num = Number(this);
    return Number.isSafeInteger(num) ? num : this.toString();
  };
}

// 2. VALIDATE CRITICAL CONFIGURATION
const nodeEnv = process.env.NODE_ENV || 'development';
console.log(`\n===============================================================`);
console.log(`[BOOTSTRAP] GPU COMPUTE ARBITRAGE OS v13 INITIALIZATION`);
console.log(`[BOOTSTRAP] Mode: ${nodeEnv.toUpperCase()}`);
console.log(`===============================================================`);

// 3. NOW IMPORT SYSTEM MODULES SAFELY
import { pgDbService } from './pgDatabase.js';
import { treasuryEngine } from './treasuryEngine.js';
import { initCustomerDirectory, isLiveEnvironmentConfigured, validateProductionSecretsAtStartup } from './auth.js';
import { crashRecoveryService } from './crashRecovery.js';
import { outboxWorker } from './outboxWorker.js';
import { systemReadinessService } from './systemReadiness.js';
import { hotWalletService } from './hotWalletService.js';
import { verifiedProfitWithdrawalService } from './verifiedProfitWithdrawalService.js';

export interface BootstrapResult {
  success: boolean;
  dbMode: string;
  treasuryStatus: string;
  liveReady: boolean;
  errors?: string[];
}

export async function bootstrapApplication(): Promise<BootstrapResult> {
  const errors: string[] = [];

  // Step 0: Validate All Required Production Secrets at Startup
  const secretAudit = validateProductionSecretsAtStartup();
  if (!secretAudit.valid) {
    const missingStr = secretAudit.missingSecrets.length > 0 ? `Missing: [${secretAudit.missingSecrets.join(', ')}]` : '';
    const conflictStr = secretAudit.conflictingVariables.length > 0 ? `Conflicting: [${secretAudit.conflictingVariables.join(', ')}]` : '';
    const exposedStr = secretAudit.exposedFrontendVariables.length > 0 ? `Exposed VITE_*: [${secretAudit.exposedFrontendVariables.join(', ')}]` : '';
    const summary = [missingStr, conflictStr, exposedStr].filter(Boolean).join(' | ');
    console.warn(`[BOOTSTRAP] Production Secret Validation FAIL-CLOSED: ${summary}`);
    errors.push(`Production Secret Validation: ${summary}`);
  } else {
    console.log('[BOOTSTRAP] All required production secrets validated (OWNER_API_KEY, CUSTOMER_API_KEY, ESCROW_SIGNING_SECRET, QUOTE_LOCK_SECRET, AUDIT_CHAIN_SECRET, BINANCE_WEBHOOK_SECRET).');
  }

  // Step A: Initialize Authoritative PostgreSQL Database
  console.log('[BOOTSTRAP] Initializing Authoritative PostgreSQL Database...');
  const dbInit = await pgDbService.initialize();
  console.log(`[BOOTSTRAP] Database Mode: ${dbInit.mode} (${dbInit.success ? 'HEALTHY' : 'DEGRADED'})`);
  if (!dbInit.success && dbInit.error) {
    errors.push(`Database: ${dbInit.error}`);
  }

  // Step B: Initialize Customer Directory and Credential Stores
  console.log('[BOOTSTRAP] Initializing Customer RBAC & Credential Stores...');
  try {
    await initCustomerDirectory();
    console.log('[BOOTSTRAP] Customer RBAC & Credential Stores: INITIALIZED');
  } catch (err: any) {
    errors.push(`Customer Directory: ${err.message}`);
  }

  // Step C: Initialize Treasury Providers
  console.log('[BOOTSTRAP] Initializing Multi-Wallet Treasury Providers (Binance Sole Required Rail, Bank)...');
  await treasuryEngine.syncOpeningBalancesWithLiveBalances();
  const treasurySummary = await treasuryEngine.reconcileAll({ verifiedBy: 'system_bootstrap' });
  console.log(`[BOOTSTRAP] Treasury Reconciled: ${treasurySummary.overallStatus} ($${treasurySummary.totalVerifiedExternalValuationUsd.toFixed(2)} external verified valuation)`);

  // Step C2: Ensure Authoritative Treasury Hot Wallet is registered in allowlist
  try {
    const hotWalletAddr = hotWalletService.getAddress();
    if (hotWalletAddr) {
      const existingAllowlist = await verifiedProfitWithdrawalService.getAllowlist();
      const alreadyPresent = existingAllowlist.some(a => a.destinationAddress.toLowerCase() === hotWalletAddr.toLowerCase());
      if (!alreadyPresent) {
        await verifiedProfitWithdrawalService.addAllowlistAddress({
          destinationAddress: hotWalletAddr,
          network: 'BSC',
          coin: 'USDT',
          label: 'Primary Treasury Operations Vault',
          approvedBy: 'system_bootstrap'
        });
        console.log(`[BOOTSTRAP] Seeded authoritative treasury wallet (${hotWalletAddr}) into withdrawal allowlist.`);
      }
    }
  } catch (err: any) {
    console.warn(`[BOOTSTRAP] Note on allowlist initialization: ${err.message}`);
  }

  // Step C3: Synchronize Settled Realized Profits to PostgreSQL Withdrawable Ledger
  try {
    const syncRes = await verifiedProfitWithdrawalService.syncRealizedProfitsToWithdrawable();
    console.log(`[BOOTSTRAP] Realized Profits Synced to Withdrawable: ${syncRes.syncedCount} deals, $${syncRes.totalProfitSynced.toFixed(2)} total`);
  } catch (err: any) {
    console.warn(`[BOOTSTRAP] Note on realized profit sync: ${err.message}`);
  }

  // Step D: Start Durable State Machine, Crash Recovery & Outbox Workers
  console.log('[BOOTSTRAP] Starting Crash Recovery & Outbox Workers...');
  crashRecoveryService.startWorker(30000); // Run recovery check every 30 seconds
  outboxWorker.start(5000); // Poll outbox every 5 seconds for pending provider operations

  // Step E: Assess Production Readiness
  const readiness = await systemReadinessService.evaluateReadiness();
  console.log(`[BOOTSTRAP] System Live Readiness: ${readiness.liveReady ? 'READY FOR LIVE' : 'FAIL-CLOSED (HALTED - LIVE GATES REQUIRED)'}`);
  if (!readiness.liveReady) {
    console.log(`[BOOTSTRAP] Unmet Gates: ${readiness.failedMandatoryGates.join(', ')}`);
  }

  console.log(`===============================================================\n`);

  return {
    success: errors.length === 0,
    dbMode: dbInit.mode,
    treasuryStatus: treasurySummary.overallStatus,
    liveReady: readiness.liveReady,
    errors: errors.length > 0 ? errors : undefined
  };
}
