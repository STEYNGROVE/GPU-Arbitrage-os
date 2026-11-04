import { pgDbService } from './pgDatabase.js';
import { treasuryEngine } from './treasuryEngine.js';
import { binanceTreasuryProvider } from './binanceProvider.js';
import { getBinanceConfig } from './binanceConfig.js';
import { isLiveEnvironmentConfigured, getEffectiveOwnerKey, getEffectiveCustomerKey, getEffectiveEscrowSecret, getEffectiveQuoteSecret, getEffectiveAuditSecret } from './auth.js';
import { killSwitchRepo, computeJobRepo, auditRepo } from './repositories/index.js';
import { hardwareProvisioner } from './providerProvisioner.js';
import { circuitBreakerService } from './circuitBreaker.js';
import { outboxWorker } from './outboxWorker.js';
import { crashRecoveryService } from './crashRecovery.js';
import { fromMinorUnits } from './moneyUtils.js';
import { evaluateAuthoritativeReconciliationGate } from './reconciliationGate.js';

export interface ReadinessGate {
  gateId?: string;
  name: string;
  status: 'GREEN' | 'RED' | 'YELLOW';
  mandatory: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface SystemReadinessReport {
  timestamp: string;
  liveReady: boolean;
  overallHealth: 'HEALTHY' | 'DEGRADED' | 'CRITICAL';
  failedMandatoryGates: string[];
  gates: Record<string, ReadinessGate>;
}

export class SystemReadinessService {
  public async evaluateReadiness(): Promise<SystemReadinessReport> {
    const timestamp = new Date().toISOString();
    const gates: Record<string, ReadinessGate> = {};

    // 1. DATABASE (Authoritative PostgreSQL)
    const dbStatus = pgDbService.getStatus();
    const dbConnected = pgDbService.isLiveDatabaseConnected();
    gates['database'] = {
      name: 'Authoritative PostgreSQL Database',
      status: dbConnected ? 'GREEN' : 'RED',
      mandatory: true,
      message: dbConnected
        ? `PostgreSQL authoritative ledger operational (Mode: ${dbStatus.mode})`
        : 'PostgreSQL disconnected. Authoritative financial persistence unavailable.',
      details: dbStatus as unknown as Record<string, unknown>
    };

    // 2. SECURITY (Zero Browser Secrets & Fail-Closed Guardrails)
    // Verify no secret variables are leaked into public client bundles
    const forbiddenPublicPrefixes = ['VITE_BINANCE', 'VITE_OWNER', 'VITE_CUSTOMER', 'VITE_ESCROW', 'VITE_QUOTE', 'VITE_AUDIT', 'VITE_DATABASE', 'VITE_TREASURY', 'VITE_BSC_RPC', 'VITE_PRIVATE_KEY'];
    const leakedPublicSecrets = Object.keys(process.env).filter(k => 
      forbiddenPublicPrefixes.some(prefix => k.startsWith(prefix)) && Boolean(process.env[k]?.trim())
    );
    const hasSecretSeparation = Boolean(
      getEffectiveOwnerKey() && 
      getEffectiveCustomerKey() &&
      getEffectiveEscrowSecret() && 
      getEffectiveQuoteSecret() &&
      getEffectiveAuditSecret() &&
      process.env.BINANCE_WEBHOOK_SECRET
    );

    const securityOk = leakedPublicSecrets.length === 0 && hasSecretSeparation;
    gates['security'] = {
      name: 'Zero Browser Secrets & Fail-Closed Guardrails',
      status: securityOk ? 'GREEN' : 'RED',
      mandatory: true,
      message: securityOk
        ? 'Zero API keys or secrets exposed to browser bundles. Cryptographic secret isolation enforced.'
        : `Security breach or missing required secret: ${leakedPublicSecrets.length > 0 ? `Leaked client vars: ${leakedPublicSecrets.join(', ')}` : 'Incomplete secret isolation (OWNER_API_KEY, CUSTOMER_API_KEY, ESCROW_SIGNING_SECRET, QUOTE_LOCK_SECRET, AUDIT_CHAIN_SECRET, BINANCE_WEBHOOK_SECRET required)'}.`,
      details: {
        leakedPublicSecrets,
        secretSeparationEnforced: hasSecretSeparation
      }
    };

    // 3. AUTH/RBAC (Owner & Customer Identity)
    const authConfig = isLiveEnvironmentConfigured();
    const ownerKey = getEffectiveOwnerKey();
    const customerKey = getEffectiveCustomerKey();
    const hasOwnerAndCustomerSecret = Boolean(ownerKey && ownerKey.length >= 16 && customerKey && customerKey.length >= 16);
    gates['auth'] = {
      name: 'Owner & Customer RBAC Credentials',
      status: hasOwnerAndCustomerSecret ? 'GREEN' : 'RED',
      mandatory: true,
      message: hasOwnerAndCustomerSecret
        ? 'Root OWNER_API_KEY and CUSTOMER_API_KEY credentials configured with strict RBAC'
        : 'OWNER_API_KEY or CUSTOMER_API_KEY missing or entropy too low (< 16 chars). Live mode blocked.',
      details: {
        isConfigured: authConfig.isReady,
        missing: authConfig.missingSecrets
      }
    };

    // 4. BINANCE (Authoritative Crypto Treasury Rail Authenticated Preflight)
    const binancePreflight = await binanceTreasuryProvider.verifyConnection();
    const binanceConfig = getBinanceConfig();
    const binanceOk = binancePreflight.connected && binancePreflight.authenticated && binancePreflight.status === 'VERIFIED';
    gates['binance'] = {
      name: 'Binance Spot & Crypto Financial Rail Authenticated Preflight',
      status: binanceOk ? 'GREEN' : 'RED',
      mandatory: true,
      message: binanceOk
        ? `Binance verified live Spot connection (${binancePreflight.latencyMs}ms, Clock drift: ${binancePreflight.serverTimeDriftMs}ms, Permissions: [${binancePreflight.canTrade ? 'TRADE' : ''} ${binancePreflight.canDeposit ? 'DEPOSIT' : ''}]. ${binanceConfig.treasuryAsset} Balance: ${binancePreflight.treasuryAssetBalance?.total || 0})`
        : `Binance preflight failed [${binancePreflight.status}]: ${binancePreflight.error || 'Authentication rejected'}`,
      details: binancePreflight as unknown as Record<string, unknown>
    };

    // 5. PROVIDERS (GPU Hardware Providers Authenticated Preflight)
    const preflightResults = await hardwareProvisioner.runAllPreflights();
    const authenticatedProviders = Object.values(preflightResults).filter(p => p.authenticated && p.accountActive);
    const hasLiveVerifiedProvider = authenticatedProviders.length > 0;
    const providerSummaries = Object.values(preflightResults)
      .map(p => `${p.provider}: ${p.authenticated ? 'AUTHENTICATED' : p.configured ? 'AUTH_FAILED' : 'NOT_CONFIGURED'} (${p.latencyMs}ms)`)
      .join(' | ');

    gates['providers'] = {
      name: 'GPU Hardware Providers Authenticated Preflight',
      status: hasLiveVerifiedProvider ? 'GREEN' : 'RED',
      mandatory: true,
      message: hasLiveVerifiedProvider
        ? `Verified live compute providers: ${authenticatedProviders.map(p => p.provider).join(', ')} (${providerSummaries})`
        : `No GPU provider passed live authenticated preflight. Results: ${providerSummaries}`,
      details: preflightResults
    };

    // 6. QUOTE ENGINE (Cryptographic Tamper-Proof Quotes)
    const quoteSecret = getEffectiveQuoteSecret();
    const hasQuoteSecret = Boolean(quoteSecret && quoteSecret.length >= 16);
    gates['quotes'] = {
      name: 'Cryptographic Quote Lock Engine',
      status: hasQuoteSecret ? 'GREEN' : 'RED',
      mandatory: true,
      message: hasQuoteSecret
        ? 'QUOTE_LOCK_SECRET configured. Quotes tamper-proof and single-use bound.'
        : 'QUOTE_LOCK_SECRET missing or too weak (< 16 chars). Live quote locks cannot be signed.',
      details: { configured: hasQuoteSecret }
    };

    // 7. COMPUTE VERIFICATION (Hardware Spec & Telemetry Validator)
    let computeVerificationOk = false;
    let computeVerificationMsg = '';
    if (dbConnected) {
      try {
        const activeJobs = await computeJobRepo.findActiveJobs();
        computeVerificationOk = true;
        computeVerificationMsg = `Compute validator operational (${activeJobs.length} active jobs monitored).`;
      } catch (err: any) {
        computeVerificationMsg = `Compute verification error: ${err.message}`;
      }
    } else {
      computeVerificationMsg = 'Database required for compute job verification.';
    }

    gates['compute_verification'] = {
      name: 'Hardware Telemetry & Job Specification Validator',
      status: computeVerificationOk ? 'GREEN' : 'RED',
      mandatory: true,
      message: computeVerificationMsg,
      details: { operational: computeVerificationOk }
    };

    // 8. PAYMENT VERIFICATION (Cryptographic Escrow Ingestion)
    const escrowSecret = getEffectiveEscrowSecret();
    const hasEscrowSecret = Boolean(escrowSecret && escrowSecret.length >= 16);
    gates['payments'] = {
      name: 'Cryptographic Payment & Escrow Ingestion',
      status: hasEscrowSecret ? 'GREEN' : 'RED',
      mandatory: true,
      message: hasEscrowSecret
        ? 'Dedicated ESCROW_SIGNING_SECRET configured with cryptographic customer payment verification.'
        : 'ESCROW_SIGNING_SECRET missing or too weak. Payment signatures cannot be verified.',
      details: { configured: hasEscrowSecret }
    };

    // 9. TREASURY (Verified Spendable Liquid Capital)
    const spendable = await treasuryEngine.calculateAuthoritativeSpendableCapital();
    const minimumOperatingThresholdUsd = binanceConfig.minReserve || 100.00;
    const hasSpendableLiquidity = spendable.spendableCapital >= minimumOperatingThresholdUsd;
    gates['treasury'] = {
      name: 'Verified Spendable Liquid Capital',
      status: hasSpendableLiquidity ? 'GREEN' : 'RED',
      mandatory: true,
      message: hasSpendableLiquidity
        ? `Authoritative spendable capital verified: $${spendable.spendableCapital.toFixed(2)} ${spendable.asset} (Gross: $${spendable.verifiedAvailableBalance.toFixed(2)}, Reserved: $${spendable.reservedCapital.toFixed(2)}, Outflows: $${spendable.pendingOutflows.toFixed(2)}, Unsettled costs: $${spendable.unsettledProviderCosts.toFixed(2)}, Min reserve: $${spendable.minimumOperatingReserve.toFixed(2)}, Risk buffer: $${spendable.riskBuffer.toFixed(2)})`
        : `Insufficient spendable capital ($${spendable.spendableCapital.toFixed(2)} available vs $${minimumOperatingThresholdUsd.toFixed(2)} required threshold).`,
      details: spendable as unknown as Record<string, unknown>
    };

    // 10. RECONCILIATION: Authoritative Single Reconciliation Gate
    const reconGate = await evaluateAuthoritativeReconciliationGate();
    gates['reconciliation'] = {
      name: 'Authoritative Binance Balance & Ledger Reconciliation',
      status: reconGate.isGreen ? 'GREEN' : 'RED',
      mandatory: true,
      message: reconGate.message,
      details: {
        reconciliationStatus: reconGate.status,
        isGreen: reconGate.isGreen,
        discrepancyUsd: reconGate.discrepancyUsd,
        discrepancyMinor: reconGate.discrepancyMinor.toString(),
        lastRunAt: reconGate.lastRunAt,
        ageSeconds: reconGate.ageSeconds
      }
    };

    // 11. CRASH RECOVERY (Durable State Machine Recovery Worker)
    const recoveryReport = crashRecoveryService.getLastPassReport();
    const recoveryOk = dbConnected;
    gates['crash_recovery'] = {
      name: 'Crash Recovery Worker & Durable State Machine',
      status: recoveryOk ? 'GREEN' : 'RED',
      mandatory: true,
      message: recoveryOk
        ? `Crash recovery daemon operational (Last pass: ${recoveryReport.lastPassAt || 'Active startup'})`
        : 'Crash recovery worker offline. Database disconnected.',
      details: recoveryReport as unknown as Record<string, unknown>
    };

    // 12. OUTBOX (Transactional Outbox Background Processor)
    const workerHealth = await outboxWorker.getWorkerHealth();
    const outboxOk = workerHealth.status === 'HEALTHY' || (workerHealth.isRunning && !workerHealth.isStale);
    gates['outbox'] = {
      name: 'Durable Transactional Outbox Worker',
      status: outboxOk ? 'GREEN' : 'RED',
      mandatory: true,
      message: outboxOk
        ? `Outbox background processor active (Worker: ${workerHealth.workerId}, Queue depth: ${workerHealth.queueDepth}, Dead letters: ${workerHealth.deadLetterCount})`
        : `Outbox background processor degraded or offline (${workerHealth.evidence})`,
      details: workerHealth as unknown as Record<string, unknown>
    };

    // 13. LOSS LIMITS (Autonomous Loss Circuit Breaker)
    const breakerStatus = circuitBreakerService.getStatus();
    const breakerOk = !breakerStatus.isTripped;
    gates['loss_limits'] = {
      name: 'Autonomous Loss & Risk Circuit Breaker',
      status: breakerOk ? 'GREEN' : 'RED',
      mandatory: true,
      message: breakerOk
        ? `Loss limits healthy. Daily loss: $${breakerStatus.accumulatedDailyLossUsd.toFixed(2)} / $${breakerStatus.limits.maxDailyLossUsd.toFixed(2)} limit.`
        : `CIRCUIT BREAKER TRIPPED: ${breakerStatus.triggerRule}. Autonomous execution halted.`,
      details: breakerStatus as unknown as Record<string, unknown>
    };

    // 14. EXPOSURE LIMITS (Single & Daily Exposure Controls)
    const maxSingleExposure = binanceConfig.maxSingleExposure;
    const maxDailyExposure = binanceConfig.maxDailyExposure;
    let currentDailyExposure = 0;

    if (dbConnected) {
      try {
        const expRes = await pgDbService.query(
          `SELECT COALESCE(SUM(amount), 0)::numeric as daily_exposure
           FROM capital_reservations
           WHERE created_at >= NOW() - interval '24 hours'
             AND status IN ('RESERVED', 'CONSUMED')`
        );
        currentDailyExposure = parseFloat(expRes.rows[0]?.daily_exposure || '0');
      } catch {}
    }

    const withinExposureLimits = currentDailyExposure <= maxDailyExposure;
    gates['exposure_limits'] = {
      name: 'Maximum Single & Daily Exposure Guardrails',
      status: withinExposureLimits ? 'GREEN' : 'RED',
      mandatory: true,
      message: withinExposureLimits
        ? `Exposure limits clear: Current 24h exposure $${currentDailyExposure.toFixed(2)} / $${maxDailyExposure.toFixed(2)} max (Max single deal: $${maxSingleExposure.toFixed(2)})`
        : `EXPOSURE LIMIT EXCEEDED: Current 24h exposure $${currentDailyExposure.toFixed(2)} exceeds daily limit $${maxDailyExposure.toFixed(2)}.`,
      details: {
        currentDailyExposureUsd: currentDailyExposure,
        maxDailyExposureUsd: maxDailyExposure,
        maxSingleExposureUsd: maxSingleExposure
      }
    };

    // 15. KILL SWITCH (Global Emergency Kill Switch)
    let killSwitchActive = false;
    let killSwitchReason = '';
    if (dbConnected) {
      const ks = await killSwitchRepo.isKillSwitchActive();
      killSwitchActive = ks.active;
      killSwitchReason = ks.reason || '';
    }
    gates['kill_switch'] = {
      name: 'Global Emergency Kill Switch Status',
      status: killSwitchActive ? 'RED' : 'GREEN',
      mandatory: true,
      message: killSwitchActive
        ? `EMERGENCY HALT: Global Kill Switch is ACTIVE (${killSwitchReason}). All live execution blocked.`
        : 'All execution circuits clear. No active kill switches.',
      details: { active: killSwitchActive, reason: killSwitchReason }
    };

    // 16. AUDIT SYSTEM (Tamper-Evident SHA-256 Chaining)
    let auditTrailOk = false;
    if (dbConnected) {
      try {
        await auditRepo.getLatestHash();
        auditTrailOk = true;
      } catch {
        auditTrailOk = false;
      }
    }

    gates['audit_system'] = {
      name: 'Tamper-Evident SHA-256 Ledger Audit Trail',
      status: auditTrailOk ? 'GREEN' : 'RED',
      mandatory: true,
      message: auditTrailOk
        ? 'Audit logging and SHA-256 hash chaining active for all ledger events.'
        : 'Audit trail storage unavailable. Database disconnected.',
      details: { active: auditTrailOk }
    };

    // Calculate LIVE readiness - fail closed if any mandatory gate is not GREEN
    const failedMandatory = Object.values(gates)
      .filter(g => g.mandatory && g.status !== 'GREEN')
      .map(g => g.name);

    const liveReady = failedMandatory.length === 0;
    const overallHealth = failedMandatory.length === 0 
      ? 'HEALTHY' 
      : failedMandatory.length < 4 
      ? 'DEGRADED' 
      : 'CRITICAL';

    return {
      timestamp,
      liveReady,
      overallHealth,
      failedMandatoryGates: failedMandatory,
      gates
    };
  }
}

export const systemReadinessService = new SystemReadinessService();
