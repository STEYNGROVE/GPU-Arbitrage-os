import { pgDbService } from './pgDatabase.js';
import { killSwitchRepo, auditRepo } from './repositories/index.js';

export interface CircuitBreakerLimits {
  maxDailyLossUsd: number;
  maxSingleDealLossUsd: number;
  maxConsecutiveProviderFailures: number;
  maxReconciliationVarianceUsd: number;
  maxUnsettledExposureUsd: number;
  maxProviderBillingVariancePct: number;
  maxUnknownOutcomeCount: number;
}

export const DEFAULT_CIRCUIT_BREAKER_LIMITS: CircuitBreakerLimits = {
  maxDailyLossUsd: 500.00,
  maxSingleDealLossUsd: 100.00,
  maxConsecutiveProviderFailures: 3,
  maxReconciliationVarianceUsd: 5.00,
  maxUnsettledExposureUsd: 2000.00,
  maxProviderBillingVariancePct: 20.0,
  maxUnknownOutcomeCount: 2
};

export interface CircuitBreakerStatus {
  isTripped: boolean;
  trippedAt: string | null;
  tripReason: string | null;
  triggerRule: string | null;
  severity: 'NORMAL' | 'WARNING' | 'CRITICAL' | 'TRIPPED';
  consecutiveFailures: number;
  unknownOutcomeCount: number;
  accumulatedDailyLossUsd: number;
  unsettledExposureUsd: number;
  limits: CircuitBreakerLimits;
  lastResetAt: string | null;
  lastResetBy: string | null;
  providerFailures?: Record<string, number>;
}

export class CircuitBreakerService {
  private limits: CircuitBreakerLimits = { ...DEFAULT_CIRCUIT_BREAKER_LIMITS };
  private isTripped: boolean = false;
  private trippedAt: string | null = null;
  private tripReason: string | null = null;
  private triggerRule: string | null = null;
  private consecutiveFailures: number = 0;
  private unknownOutcomeCount: number = 0;
  private accumulatedDailyLossUsd: number = 0;
  private unsettledExposureUsd: number = 0;
  private lastResetAt: string | null = null;
  private lastResetBy: string | null = null;
  private dailyLossResetDay: string = new Date().toISOString().substring(0, 10);
  private providerFailures: Record<string, number> = {};

  constructor() {
    this.syncFromDatabase().catch(() => {});
  }

  public async syncFromDatabase(): Promise<void> {
    if (!pgDbService.isLiveDatabaseConnected()) return;
    try {
      const res = await pgDbService.query(
        `SELECT is_tripped as "isTripped", tripped_at as "trippedAt", trip_reason as "tripReason",
                trigger_rule as "triggerRule", consecutive_failures as "consecutiveFailures",
                accumulated_loss_usd as "accumulatedLossUsd", unsettled_exposure_usd as "unsettledExposureUsd",
                reset_at as "resetAt", reset_by as "resetBy"
         FROM circuit_breaker_state WHERE breaker_id = 'GLOBAL_CIRCUIT_BREAKER'`
      );
      if (res.rows.length > 0) {
        const row = res.rows[0];
        this.isTripped = Boolean(row.isTripped);
        this.trippedAt = row.trippedAt ? new Date(row.trippedAt).toISOString() : null;
        this.tripReason = row.tripReason || null;
        this.triggerRule = row.triggerRule || null;
        this.consecutiveFailures = Number(row.consecutiveFailures) || 0;
        this.accumulatedDailyLossUsd = Number(row.accumulatedLossUsd) || 0;
        this.unsettledExposureUsd = Number(row.unsettledExposureUsd) || 0;
        this.lastResetAt = row.resetAt ? new Date(row.resetAt).toISOString() : null;
        this.lastResetBy = row.resetBy || null;
      }
    } catch {
      // Best-effort database sync
    }
  }

  private checkDailyReset(): void {
    const today = new Date().toISOString().substring(0, 10);
    if (today !== this.dailyLossResetDay) {
      this.accumulatedDailyLossUsd = 0;
      this.dailyLossResetDay = today;
    }
  }

  public async trip(rule: string, reason: string): Promise<void> {
    this.isTripped = true;
    this.trippedAt = new Date().toISOString();
    this.tripReason = reason;
    this.triggerRule = rule;

    console.error(`🚨 [CIRCUIT BREAKER TRIPPED] Rule: ${rule} | Reason: ${reason}`);

    // Persist trip to PostgreSQL circuit_breaker_state
    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        await pgDbService.query(
          `INSERT INTO circuit_breaker_state 
            (breaker_id, is_tripped, tripped_at, trip_reason, trigger_rule, severity, consecutive_failures, accumulated_loss_usd, unsettled_exposure_usd, updated_at)
           VALUES ('GLOBAL_CIRCUIT_BREAKER', TRUE, NOW(), $1, $2, 'CRITICAL', $3, $4, $5, NOW())
           ON CONFLICT (breaker_id) DO UPDATE SET
             is_tripped = TRUE,
             tripped_at = NOW(),
             trip_reason = $1,
             trigger_rule = $2,
             severity = 'CRITICAL',
             consecutive_failures = $3,
             accumulated_loss_usd = $4,
             unsettled_exposure_usd = $5,
             updated_at = NOW()`,
          [reason, rule, this.consecutiveFailures, this.accumulatedDailyLossUsd, this.unsettledExposureUsd]
        );
      } catch (err: any) {
        console.error('[CIRCUIT BREAKER DB ERROR]', err.message);
      }

      // Automatically engage authoritative global kill switch!
      try {
        await killSwitchRepo.setKillSwitch('GLOBAL_KILL_SWITCH', true, `CIRCUIT_BREAKER: ${reason}`, 'SYSTEM_CIRCUIT_BREAKER');
      } catch (err: any) {
        console.error('[KILL SWITCH ENGAGE ERROR]', err.message);
      }

      // Record immutable cryptographic audit trail
      try {
        await auditRepo.recordEvent({
          eventType: 'CIRCUIT_BREAKER_TRIPPED',
          severity: 'CRITICAL',
          message: `AUTONOMOUS HALT: Circuit breaker tripped by rule ${rule}. Reason: ${reason}`,
          details: {
            rule,
            reason,
            consecutiveFailures: this.consecutiveFailures,
            accumulatedDailyLoss: this.accumulatedDailyLossUsd,
            unsettledExposure: this.unsettledExposureUsd
          }
        });
      } catch (err: any) {
        console.error('[AUDIT EVENT ERROR]', err.message);
      }
    }
  }

  public async recordProviderFailure(provider: string, error: string, isAmbiguousOutcome: boolean = false): Promise<void> {
    this.consecutiveFailures++;
    this.providerFailures[provider] = (this.providerFailures[provider] || 0) + 1;
    if (isAmbiguousOutcome) {
      this.unknownOutcomeCount++;
    }

    console.warn(`[CIRCUIT BREAKER] Recorded failure for provider ${provider} (Consecutive: ${this.consecutiveFailures}/${this.limits.maxConsecutiveProviderFailures}, Unknown: ${this.unknownOutcomeCount}/${this.limits.maxUnknownOutcomeCount})`);

    if (this.unknownOutcomeCount >= this.limits.maxUnknownOutcomeCount) {
      await this.trip(
        'MAX_UNKNOWN_OUTCOME_COUNT',
        `Reached ${this.unknownOutcomeCount} ambiguous provider execution outcomes without confirmation. Autonomous halt required to prevent capital leakage.`
      );
      return;
    }

    if (this.consecutiveFailures >= this.limits.maxConsecutiveProviderFailures) {
      await this.trip(
        'MAX_CONSECUTIVE_PROVIDER_FAILURES',
        `${this.consecutiveFailures} consecutive hardware provider provisioning failures detected (${error}).`
      );
    }
  }

  public recordProviderSuccess(provider?: string): void {
    this.consecutiveFailures = 0;
    this.unknownOutcomeCount = 0;
    if (provider) {
      this.providerFailures[provider] = 0;
    } else {
      this.providerFailures = {};
    }
  }

  public async recordDealFinancialOutcome(profitOrLossUsd: number, demandOrderId: string): Promise<void> {
    this.checkDailyReset();

    if (profitOrLossUsd < 0) {
      const loss = Math.abs(profitOrLossUsd);
      this.accumulatedDailyLossUsd += loss;

      console.warn(`[CIRCUIT BREAKER] Recorded financial loss: -$${loss.toFixed(2)} on order ${demandOrderId} (Daily Loss: $${this.accumulatedDailyLossUsd.toFixed(2)}/$${this.limits.maxDailyLossUsd})`);

      if (loss >= this.limits.maxSingleDealLossUsd) {
        await this.trip(
          'MAX_SINGLE_DEAL_LOSS',
          `Single deal loss of -$${loss.toFixed(2)} on order ${demandOrderId} exceeded limit of -$${this.limits.maxSingleDealLossUsd.toFixed(2)}.`
        );
        return;
      }

      if (this.accumulatedDailyLossUsd >= this.limits.maxDailyLossUsd) {
        await this.trip(
          'MAX_DAILY_LOSS',
          `Accumulated daily loss of -$${this.accumulatedDailyLossUsd.toFixed(2)} exceeded daily stop-loss limit of -$${this.limits.maxDailyLossUsd.toFixed(2)}.`
        );
      }
    }
  }

  public async recordReconciliationVariance(varianceUsd: number): Promise<void> {
    if (Math.abs(varianceUsd) > this.limits.maxReconciliationVarianceUsd) {
      await this.trip(
        'MAX_RECONCILIATION_VARIANCE',
        `Reconciliation variance of $${Math.abs(varianceUsd).toFixed(2)} exceeded allowable tolerance of $${this.limits.maxReconciliationVarianceUsd.toFixed(2)}.`
      );
    }
  }

  public async checkUnsettledExposure(unsettledUsd: number): Promise<void> {
    this.unsettledExposureUsd = unsettledUsd;
    if (unsettledUsd > this.limits.maxUnsettledExposureUsd) {
      await this.trip(
        'MAX_UNSETTLED_EXPOSURE',
        `Unsettled active compute exposure of $${unsettledUsd.toFixed(2)} exceeded exposure cap of $${this.limits.maxUnsettledExposureUsd.toFixed(2)}.`
      );
    }
  }

  public async reset(adminUser: string, reason: string): Promise<{ success: boolean; message: string }> {
    this.isTripped = false;
    this.trippedAt = null;
    this.tripReason = null;
    this.triggerRule = null;
    this.consecutiveFailures = 0;
    this.unknownOutcomeCount = 0;
    this.providerFailures = {};
    this.lastResetAt = new Date().toISOString();
    this.lastResetBy = adminUser;

    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        await pgDbService.query(
          `UPDATE circuit_breaker_state
           SET is_tripped = FALSE,
               severity = 'NORMAL',
               trip_reason = NULL,
               trigger_rule = NULL,
               consecutive_failures = 0,
               reset_at = NOW(),
               reset_by = $1,
               updated_at = NOW()
           WHERE breaker_id = 'GLOBAL_CIRCUIT_BREAKER'`,
          [adminUser]
        );

        await killSwitchRepo.deactivateKillSwitch('GLOBAL_KILL_SWITCH', adminUser).catch(() => {});

        await auditRepo.recordEvent({
          eventType: 'CIRCUIT_BREAKER_RESET',
          severity: 'SECURITY',
          message: `Circuit breaker manually reset by admin ${adminUser}. Reason: ${reason}`,
          details: { adminUser, reason }
        });
      } catch (err: any) {
        return { success: false, message: `Failed to persist reset: ${err.message}` };
      }
    }

    return { success: true, message: 'Circuit breaker reset successfully. Execution paths re-enabled.' };
  }

  public isCircuitTripped(rule?: string): boolean {
    if (rule) {
      return this.isTripped && this.triggerRule === rule;
    }
    return this.isTripped;
  }

  public async resetCircuitBreaker(ruleOrReason: string = 'MANUAL_RESET'): Promise<void> {
    await this.reset('SYSTEM_ADMIN', ruleOrReason);
  }

  public getStatus(): CircuitBreakerStatus {
    this.checkDailyReset();
    return {
      isTripped: this.isTripped,
      trippedAt: this.trippedAt,
      tripReason: this.tripReason,
      triggerRule: this.triggerRule,
      severity: this.isTripped ? 'TRIPPED' : this.consecutiveFailures > 0 ? 'WARNING' : 'NORMAL',
      consecutiveFailures: this.consecutiveFailures,
      unknownOutcomeCount: this.unknownOutcomeCount,
      accumulatedDailyLossUsd: Math.round(this.accumulatedDailyLossUsd * 100) / 100,
      unsettledExposureUsd: Math.round(this.unsettledExposureUsd * 100) / 100,
      limits: { ...this.limits },
      lastResetAt: this.lastResetAt,
      lastResetBy: this.lastResetBy,
      providerFailures: { ...this.providerFailures }
    };
  }
}

export const circuitBreakerService = new CircuitBreakerService();
