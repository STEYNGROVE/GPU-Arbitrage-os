import { SupportedCurrency, CanonicalReconciliationStatus, fromMinorUnits } from './moneyUtils.js';
import { canonicalReconciliationService, CanonicalReconciliationRun } from './canonicalReconciliation.js';

export interface ReconciliationResult {
  runId: string;
  runAt: string;
  currency: SupportedCurrency;
  ledgerBalanceCents: number;
  ledgerBalanceFormatted: number;
  externalBalanceCents: number | null;
  externalBalanceFormatted: number | null;
  discrepancyCents: number | null;
  status: CanonicalReconciliationStatus;
  autonomousCapitalDeploymentAllowed: boolean;
  reason: string;
  externalSource: string | null;
  verifiedBy: string;
}

/**
 * ReconciliationEngine delegates directly to the single canonical reconciliation service.
 */
export class ReconciliationEngine {
  async runReconciliation(options: {
    currency?: SupportedCurrency;
    verifiedBy: string;
    injectDiscrepancyMinor?: bigint;
  }): Promise<ReconciliationResult> {
    const run: CanonicalReconciliationRun = await canonicalReconciliationService.runAuthoritativeReconciliation(options);
    return this.mapRunToResult(run);
  }

  getLastResult(): ReconciliationResult {
    const run = canonicalReconciliationService.getLastRun();
    return this.mapRunToResult(run);
  }

  private mapRunToResult(run: CanonicalReconciliationRun): ReconciliationResult {
    const ledgerCents = Number(run.ledgerBalanceMinor);
    const externalCents = run.externalBalanceMinor !== null ? Number(run.externalBalanceMinor) : null;
    const discrepancyCents = run.discrepancyMinor !== null ? Number(run.discrepancyMinor) : null;

    return {
      runId: run.runId,
      runAt: run.runAt,
      currency: run.currency,
      ledgerBalanceCents: ledgerCents,
      ledgerBalanceFormatted: fromMinorUnits(run.ledgerBalanceMinor),
      externalBalanceCents: externalCents,
      externalBalanceFormatted: externalCents !== null ? fromMinorUnits(run.externalBalanceMinor!) : null,
      discrepancyCents: discrepancyCents,
      status: run.status,
      autonomousCapitalDeploymentAllowed: run.autonomousCapitalDeploymentAllowed,
      reason: run.reason,
      externalSource: run.externalSource,
      verifiedBy: run.verifiedBy
    };
  }
}

export const reconciliationEngine = new ReconciliationEngine();
