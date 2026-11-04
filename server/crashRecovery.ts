import crypto from 'crypto';
import { pgDbService } from './pgDatabase.js';
import { treasuryRepo, reservationRepo, providerOperationRepo, computeJobRepo, auditRepo, demandOrderRepo, quoteRepo } from './repositories/index.js';
import { outboxWorker } from './outboxWorker.js';
import { hardwareProvisioner } from './providerProvisioner.js';
import { toMinorUnits, fromMinorUnits } from './moneyUtils.js';

export function calculateProviderExposure(params: {
  accruedCostUsd: number;
  estimatedRemainingCostUsd: number;
  contractualMaximumExposureUsd: number;
  pendingChargesUsd: number;
}): number {
  const accruedMinor = toMinorUnits(params.accruedCostUsd);
  const remainingMinor = toMinorUnits(params.estimatedRemainingCostUsd);
  const maxExpMinor = toMinorUnits(params.contractualMaximumExposureUsd);
  const pendingMinor = toMinorUnits(params.pendingChargesUsd);
  return fromMinorUnits(accruedMinor + remainingMinor + maxExpMinor + pendingMinor);
}

export interface CrashRecoveryPassResult {
  expiredReservationsSwept: number;
  hangingOperationsRecovered: number;
  timeoutInstancesAdopted: number;
  timeoutOperationsSafelyFailed: number;
  outboxEventsProcessed: number;
}

export class CrashRecoveryService {
  private isRunning: boolean = false;
  private startCount: number = 0;
  private intervalTimer: NodeJS.Timeout | null = null;
  private lastPassAt: string | null = null;
  private lastPassResult: CrashRecoveryPassResult | null = null;

  public startWorker(intervalMs: number = 30000): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startCount += 1;
    console.log(`[CRASH RECOVERY] Starting durable state machine recovery worker (interval: ${intervalMs}ms, startCount: ${this.startCount})`);

    // Run immediate pass
    this.runRecoveryPass().catch(err => console.error('[CRASH RECOVERY ERROR]', err));

    this.intervalTimer = setInterval(() => {
      this.runRecoveryPass().catch(err => console.error('[CRASH RECOVERY ERROR]', err));
    }, intervalMs);
  }

  public getStartCount(): number {
    return this.startCount;
  }

  public stopWorker(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.isRunning = false;
  }

  /**
   * Executes a complete authoritative recovery cycle:
   * 1. Sweep expired capital reservations in PostgreSQL
   * 2. Inspect hanging provider operations (PROVIDER_REQUEST_SENT for > 5 min -> RECOVERY_REQUIRED)
   * 3. Provider Timeout Reconciliation & Adoption (Match ambiguous instances before releasing or retrying)
   * 4. Trigger outbox worker cycle
   */
  public async runRecoveryPass(): Promise<CrashRecoveryPassResult> {
    let expiredReservationsSwept = 0;
    let hangingOperationsRecovered = 0;
    let timeoutInstancesAdopted = 0;
    let timeoutOperationsSafelyFailed = 0;
    let outboxEventsProcessed = 0;

    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        // 1. Sweep expired reservations
        const sweepRes = await pgDbService.query(
          `UPDATE capital_reservations
           SET status = 'EXPIRED', updated_at = NOW()
           WHERE status = 'RESERVED' AND expires_at < NOW()
           RETURNING reservation_id`
        );
        expiredReservationsSwept = sweepRes.rowCount || 0;

        // 2. Inspect hanging operations in PROVIDER_REQUEST_SENT exceeding 5 min window
        const hangingRes = await pgDbService.query(
          `UPDATE provider_operations
           SET state = 'RECOVERY_REQUIRED',
               error_message = 'Operation stalled in PROVIDER_REQUEST_SENT exceeding timeout window',
               updated_at = NOW()
           WHERE state = 'PROVIDER_REQUEST_SENT'
             AND created_at < NOW() - interval '5 minutes'
           RETURNING operation_id`
        );
        hangingOperationsRecovered = hangingRes.rowCount || 0;

        // 3. Reconcile and adopt operations in RECOVERY_REQUIRED
        const recoveryOps = await pgDbService.query(
          `SELECT operation_id as "operationId", demand_order_id as "demandOrderId", quote_id as "quoteId",
                  reservation_id as "reservationId", customer_id as "customerId", provider,
                  offer_id as "offerId", gpu_model as "gpuModel", gpu_count as "gpuCount",
                  created_at as "createdAt"
           FROM provider_operations
           WHERE state = 'RECOVERY_REQUIRED' AND updated_at < NOW() - interval '30 seconds'
           LIMIT 10`
        );

        for (const op of recoveryOps.rows) {
          try {
            const providerType = op.provider as 'vast_ai' | 'runpod' | 'lambda';
            const adoptionCheck = await hardwareProvisioner.findInstanceByReference(providerType, {
              operationId: op.operationId,
              offerId: op.offerId,
              customerName: op.customerId,
              createdAfterMs: new Date(op.createdAt).getTime()
            });

            if (adoptionCheck.found && adoptionCheck.instanceId) {
              // 10-POINT MANDATORY FINANCIAL & CONTRACTUAL RECOVERY CRITERIA AUDIT:
              // 1. Customer, 2. Order, 3. Payment, 4. Quote, 5. Revenue,
              // 6. Requirements, 7. Provider, 8. Instance, 9. Reservation, 10. Authorization
              const demandOrder = await demandOrderRepo.findById(op.demandOrderId);
              const quote = op.quoteId ? await quoteRepo.findById(op.quoteId) : null;
              const contractedRevenue = demandOrder ? Number(demandOrder.customerGrossOfferPrice) : 0;

              const c1Customer = Boolean(demandOrder && demandOrder.customerId && demandOrder.customerId === op.customerId);
              const c2Order = Boolean(demandOrder && demandOrder.id);
              const c3Payment = Boolean(demandOrder && (demandOrder.paymentStatus === 'ESCROW_AUTHORIZED' || demandOrder.paymentStatus === 'SETTLED' || demandOrder.isConfirmed));
              const c4Quote = Boolean(quote && quote.quoteId);
              const c5Revenue = Boolean(contractedRevenue > 0);
              const c6Requirements = Boolean(op.gpuModel && op.gpuCount > 0);
              const c7Provider = ['vast_ai', 'runpod', 'lambda'].includes(op.provider);
              const c8Instance = Boolean(adoptionCheck.instanceId);
              const c9Reservation = Boolean(op.reservationId);
              const c10Authorization = Boolean(op.operationId && op.state === 'RECOVERY_REQUIRED');

              const all10CriteriaMet = c1Customer && c2Order && c3Payment && c4Quote && c5Revenue &&
                                      c6Requirements && c7Provider && c8Instance && c9Reservation && c10Authorization;

              if (!all10CriteriaMet) {
                const missingCriteria: string[] = [];
                if (!c1Customer) missingCriteria.push('CUSTOMER_INVALID');
                if (!c2Order) missingCriteria.push('ORDER_MISSING');
                if (!c3Payment) missingCriteria.push('PAYMENT_UNVERIFIED');
                if (!c4Quote) missingCriteria.push('QUOTE_MISSING');
                if (!c5Revenue) missingCriteria.push('REVENUE_NON_POSITIVE');
                if (!c6Requirements) missingCriteria.push('REQUIREMENTS_INVALID');
                if (!c7Provider) missingCriteria.push('PROVIDER_UNSUPPORTED');
                if (!c8Instance) missingCriteria.push('INSTANCE_NOT_FOUND');
                if (!c9Reservation) missingCriteria.push('RESERVATION_MISSING');
                if (!c10Authorization) missingCriteria.push('AUTHORIZATION_INVALID');

                console.error(`[CRASH RECOVERY EXPOSURE PREVENTED] Instance ${adoptionCheck.instanceId} for op ${op.operationId} failed 10-point criteria (${missingCriteria.join(', ')}). Terminating immediately to prevent unhedged GPU liability.`);

                const isLive = process.env.SYSTEM_MODE === 'LIVE' || process.env.NODE_ENV === 'production';
                await hardwareProvisioner.terminateComputeHardware(
                  op.provider as any,
                  adoptionCheck.instanceId,
                  isLive
                );

                if (op.reservationId) {
                  await pgDbService.query(
                    `UPDATE capital_reservations SET status = 'RELEASED', updated_at = NOW() WHERE reservation_id = $1`,
                    [op.reservationId]
                  );
                }

                await providerOperationRepo.updateState(op.operationId, 'FAILED', {
                  errorMessage: `ORPHANED_INSTANCE_TERMINATED: Failed 10-point recovery criteria: ${missingCriteria.join(', ')}`
                });

                await auditRepo.recordEvent({
                  eventType: 'ORPHANED_INSTANCE_TERMINATED',
                  severity: 'CRITICAL',
                  message: `Terminated orphaned instance ${adoptionCheck.instanceId} to prevent unhedged cost leak. Missing criteria: ${missingCriteria.join(', ')}.`,
                  details: { operationId: op.operationId, instanceId: adoptionCheck.instanceId, demandOrderId: op.demandOrderId, missingCriteria }
                });

                timeoutOperationsSafelyFailed++;
                continue;
              }

              // Contracted customer revenue verified (> 0). Adopt the instance safely!
              console.log(`[CRASH RECOVERY] Adopted verified instance ${adoptionCheck.instanceId} for operation ${op.operationId} with contracted revenue $${contractedRevenue.toFixed(2)}`);
              await pgDbService.query(
                `INSERT INTO provider_instances
                  (instance_id, provider, external_id, gpu_model, gpu_count, actual_hourly_cost, status, metadata, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, 'PROVISIONED', $7, NOW(), NOW())
                 ON CONFLICT (instance_id) DO UPDATE SET status = 'PROVISIONED', updated_at = NOW()`,
                [
                  adoptionCheck.instanceId,
                  op.provider,
                  adoptionCheck.instanceId,
                  op.gpuModel,
                  op.gpuCount,
                  adoptionCheck.hourlyPrice || 0,
                  JSON.stringify(adoptionCheck.raw || {})
                ]
              );

              // Update operation
              await providerOperationRepo.updateState(op.operationId, 'INSTANCE_VERIFIED', {
                providerInstanceId: adoptionCheck.instanceId,
                metadata: { adoptedViaRecovery: true, adoptedAt: new Date().toISOString() }
              });

              // Create compute job with verified contracted revenue
              const jobId = `job-adopted-${crypto.randomUUID()}`;
              await computeJobRepo.createJob({
                jobId,
                operationId: op.operationId,
                demandOrderId: op.demandOrderId,
                customerId: op.customerId,
                provider: op.provider,
                providerInstanceId: adoptionCheck.instanceId,
                gpuModel: op.gpuModel,
                gpuCount: op.gpuCount,
                contractedRevenue,
                providerHourlyRate: adoptionCheck.hourlyPrice || 0
              });

              await auditRepo.recordEvent({
                eventType: 'TIMEOUT_INSTANCE_ADOPTED',
                severity: 'INFO',
                message: `Adopted verified instance ${adoptionCheck.instanceId} for operation ${op.operationId} with contracted revenue $${contractedRevenue.toFixed(2)}`,
                details: { operationId: op.operationId, instanceId: adoptionCheck.instanceId, contractedRevenue }
              });

              timeoutInstancesAdopted++;
            } else {
              // Operation created > 5 minutes ago and provider confirms no instance exists
              const isOlderThan5Min = Date.now() - new Date(op.createdAt).getTime() > 300000;
              if (isOlderThan5Min) {
                if (op.reservationId) {
                  await pgDbService.query(
                    `UPDATE capital_reservations SET status = 'RELEASED', updated_at = NOW() WHERE reservation_id = $1`,
                    [op.reservationId]
                  );
                }
                await providerOperationRepo.updateState(op.operationId, 'FAILED', {
                  errorMessage: 'PROVIDER_TIMEOUT_CONFIRMED_UNPROVISIONED: Provider confirmed no instance created. Reservation safely released.'
                });

                await auditRepo.recordEvent({
                  eventType: 'TIMEOUT_CONFIRMED_UNPROVISIONED',
                  severity: 'INFO',
                  message: `Confirmed no instance was created for timed-out operation ${op.operationId}. Capital reservation released.`,
                  details: { operationId: op.operationId, reservationId: op.reservationId }
                });

                timeoutOperationsSafelyFailed++;
              }
            }
          } catch (opErr: any) {
            console.warn(`[CRASH RECOVERY] Error reconciling operation ${op.operationId}:`, opErr.message);
          }
        }

        // 4. Trigger outbox worker cycle
        outboxEventsProcessed = await outboxWorker.pollAndExecute();
      } catch (err: any) {
        console.warn('[CRASH RECOVERY] Error during recovery cycle:', err.message);
      }
    }

    const result: CrashRecoveryPassResult = {
      expiredReservationsSwept,
      hangingOperationsRecovered,
      timeoutInstancesAdopted,
      timeoutOperationsSafelyFailed,
      outboxEventsProcessed
    };

    this.lastPassAt = new Date().toISOString();
    this.lastPassResult = result;
    return result;
  }

  public getLastPassReport(): { lastPassAt: string | null; result: CrashRecoveryPassResult | null } {
    return {
      lastPassAt: this.lastPassAt,
      result: this.lastPassResult
    };
  }
}

export const crashRecoveryService = new CrashRecoveryService();
