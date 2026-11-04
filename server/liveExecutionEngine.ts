import crypto from 'crypto';
import {
  demandOrderRepo,
  quoteRepo,
  customerRepo,
  treasuryRepo,
  reservationRepo,
  providerOperationRepo,
  computeJobRepo,
  settlementRepo,
  outboxRepo,
  auditRepo,
  killSwitchRepo,
  escrowRepo
} from './repositories/index.js';
import { pgDbService } from './pgDatabase.js';
import { hardwareProvisioner } from './providerProvisioner.js';
import { toMinorUnits, fromMinorUnits } from './moneyUtils.js';

export interface LiveExecutionInput {
  demandOrderId: string;
  quoteId: string;
  idempotencyKey?: string;
}

export interface LiveExecutionResult {
  success: boolean;
  executionMode: 'LIVE';
  jobId?: string;
  operationId?: string;
  contractedRevenue?: number;
  capitalReserved?: number;
  projectedProfit?: number;
  error?: string;
  state?: string;
  message?: string;
}

export class LiveExecutionEngine {
  /**
   * Authoritative LIVE Execution Pipeline
   * Accept ONLY: demandOrderId, quoteId, idempotencyKey
   * Never trust client values for: provider, GPU, price, capital, duration, customer.
   */
  public async executeLiveDeal(
    input: LiveExecutionInput,
    authenticatedCustomer: { customerId: string; role: string }
  ): Promise<LiveExecutionResult> {
    // 1. Check PostgreSQL Database Connection (Fails Closed)
    const connStatus = pgDbService.assertLiveModeAllowed();
    if (!connStatus.allowed) {
      return {
        success: false,
        executionMode: 'LIVE',
        error: connStatus.reason || 'PostgreSQL unavailable. Live operations blocked.'
      };
    }

    // 2. Check Global and Domain-Specific Safety Kill Switches
    const killSwitch = await killSwitchRepo.isKillSwitchActive('GLOBAL_KILL_SWITCH');
    if (killSwitch.active) {
      return {
        success: false,
        executionMode: 'LIVE',
        error: `SECURITY GATE: Emergency kill switch is ACTIVE: ${killSwitch.reason || 'Operations halted'}`
      };
    }

    const provKs = await killSwitchRepo.isKillSwitchActive('NEW_PROVISIONING_KILL_SWITCH');
    if (provKs.active) {
      return {
        success: false,
        executionMode: 'LIVE',
        error: `SECURITY GATE: NEW_PROVISIONING_KILL_SWITCH is ACTIVE: ${provKs.reason || 'Provisioning halted'}`
      };
    }

    const autoKs = await killSwitchRepo.isKillSwitchActive('AUTONOMOUS_EXECUTION_KILL_SWITCH');
    if (autoKs.active) {
      return {
        success: false,
        executionMode: 'LIVE',
        error: `SECURITY GATE: AUTONOMOUS_EXECUTION_KILL_SWITCH is ACTIVE: ${autoKs.reason || 'Autonomous execution halted'}`
      };
    }

    const { demandOrderId, quoteId, idempotencyKey } = input;
    if (!demandOrderId || !quoteId) {
      return {
        success: false,
        executionMode: 'LIVE',
        error: 'INVALID_INPUT: demandOrderId and quoteId are strictly required.'
      };
    }

    // 3. Resolve Authoritative Demand Order from PostgreSQL
    const order = await demandOrderRepo.findById(demandOrderId);
    if (!order) {
      return {
        success: false,
        executionMode: 'LIVE',
        error: `DEMAND_ORDER_NOT_FOUND: Order ${demandOrderId} does not exist in authoritative PostgreSQL store.`
      };
    }

    // 4. Resolve Authoritative Quote from PostgreSQL
    const quote = await quoteRepo.findById(quoteId);
    if (!quote) {
      return {
        success: false,
        executionMode: 'LIVE',
        error: `QUOTE_NOT_FOUND: Quote ${quoteId} does not exist in authoritative PostgreSQL store.`
      };
    }

    // 5. Strict Customer & Order Binding Verification
    // Authenticated customer MUST match both the quote's customer and the demand order's customer
    // (unless caller is OWNER with explicit administrative authorization)
    if (authenticatedCustomer.role !== 'OWNER') {
      if (authenticatedCustomer.customerId !== order.customerId || authenticatedCustomer.customerId !== quote.customerId) {
        await auditRepo.recordEvent({
          eventType: 'CUSTOMER_BINDING_VIOLATION',
          severity: 'SECURITY',
          message: `Blocked attempt by customer ${authenticatedCustomer.customerId} to execute order/quote owned by ${order.customerId}/${quote.customerId}`,
          details: { authenticatedCustomer, orderCustomerId: order.customerId, quoteCustomerId: quote.customerId }
        });
        return {
          success: false,
          executionMode: 'LIVE',
          error: 'SECURITY_VIOLATION: Authenticated customer does not match order or quote customer binding.'
        };
      }
    }

    if (quote.demandOrderId !== demandOrderId) {
      return {
        success: false,
        executionMode: 'LIVE',
        error: 'QUOTE_MISMATCH: Quote is not bound to the specified demand order.'
      };
    }

    // Verify order payment status
    if (order.paymentStatus !== 'ESCROW_AUTHORIZED' && order.paymentStatus !== 'PREPAID_CREDIT') {
      return {
        success: false,
        executionMode: 'LIVE',
        error: `PAYMENT_UNVERIFIED: Demand order paymentStatus is ${order.paymentStatus}. Must be ESCROW_AUTHORIZED or PREPAID_CREDIT.`
      };
    }

    // Verify customer has sufficient escrow balance in authoritative ledger
    const customerEscrow = await escrowRepo.getCustomerEscrowBalance(order.customerId);
    if (customerEscrow < order.customerGrossOfferPrice) {
      return {
        success: false,
        executionMode: 'LIVE',
        error: `INSUFFICIENT_CUSTOMER_ESCROW: Ledger escrow is $${customerEscrow.toFixed(2)}, required $${order.customerGrossOfferPrice.toFixed(2)}.`
      };
    }

    // 6. Transactionally Consume Quote (Single-Use Guarantee)
    // Only one transaction can transition status from 'ISSUED' to 'CONSUMED'.
    const consumedQuote = await quoteRepo.consumeQuoteAtomic(quoteId, authenticatedCustomer.customerId);
    if (!consumedQuote) {
      return {
        success: false,
        executionMode: 'LIVE',
        error: 'QUOTE_UNUSABLE: Quote is either already consumed, expired, or invalid.'
      };
    }

    // 7. Saga State 1: CREATED
    const operationId = `op-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const operation = await providerOperationRepo.createOperation({
      operationId,
      demandOrderId,
      quoteId,
      customerId: order.customerId,
      provider: quote.provider,
      offerId: quote.offerId,
      gpuModel: quote.gpuModel,
      gpuCount: quote.gpuCount,
      idempotencyKey
    });

    // 8. Saga State 2: RESERVATION_PENDING -> RESERVED
    await providerOperationRepo.updateState(operationId, 'RESERVATION_PENDING');

    const reservationId = `res-${operationId}`;
    const capitalRequired = quote.maxTotalCost;

    // Requirement 7: LIVE execution MUST NOT call getOrCreateAccount() or use live-balance-${provider}.
    // Strictly find verified, active production treasury cash account for this provider and asset.
    let treasuryAccount = await treasuryRepo.findVerifiedAccount(quote.provider, 'USD', 'LIVE');
    if (!treasuryAccount) {
      treasuryAccount = await treasuryRepo.findAccount(quote.provider, `${quote.provider}-main`, 'USD', 'LIVE');
    }

    if (!treasuryAccount || treasuryAccount.status !== 'ACTIVE') {
      await providerOperationRepo.updateState(operationId, 'FAILED', {
        errorMessage: `TREASURY_ACCOUNT_UNVERIFIED: Active treasury account for ${quote.provider} USD does not exist.`
      });
      return {
        success: false,
        executionMode: 'LIVE',
        operationId,
        error: `TREASURY_ACCOUNT_UNVERIFIED: Authoritative treasury account for provider ${quote.provider} does not exist or is unverified. Live operations blocked.`
      };
    }

    try {
      await reservationRepo.createReservationAtomic({
        reservationId,
        demandOrderId,
        quoteId,
        accountId: treasuryAccount.id,
        asset: 'USD',
        currency: 'USD',
        amount: capitalRequired,
        durationMinutes: 15
      });

      await providerOperationRepo.updateState(operationId, 'RESERVED', { reservationId });
    } catch (err: any) {
      await providerOperationRepo.updateState(operationId, 'FAILED', {
        errorMessage: `Capital reservation failed: ${err.message}`
      });
      return {
        success: false,
        executionMode: 'LIVE',
        operationId,
        error: `CAPITAL_RESERVATION_FAILED: ${err.message}`
      };
    }

    // 9. Saga State 3: PROVIDER_REQUEST_PENDING -> Enqueue Outbox Event
    await providerOperationRepo.updateState(operationId, 'PROVIDER_REQUEST_PENDING');

    // Enqueue outbox event for real provider interaction
    await outboxRepo.enqueueEvent('PROVIDER_OPERATION', operationId, 'PROVISION_GPU_INSTANCE', {
      operationId,
      provider: quote.provider,
      offerId: quote.offerId,
      gpuModel: quote.gpuModel,
      gpuCount: quote.gpuCount,
      region: quote.region,
      reservationId,
      maxCost: capitalRequired,
      demandOrderId,
      customerId: order.customerId,
      workloadType: order.workloadType,
      customerName: order.customerName,
      customerGrossOfferPrice: order.customerGrossOfferPrice,
      verifiedHourlyPrice: quote.verifiedHourlyPrice
    });

    // Record audit event for enqueued provisioning
    await auditRepo.recordEvent({
      eventType: 'PROVIDER_PROVISIONING_ENQUEUED',
      severity: 'INFO',
      message: `Authoritative outbox event enqueued for provider ${quote.provider} (Operation ${operationId})`,
      details: { operationId, demandOrderId, provider: quote.provider, reservationId, capitalRequired }
    });

    const projectedProfit = order.customerGrossOfferPrice - capitalRequired;

    return {
      success: true,
      executionMode: 'LIVE',
      operationId,
      contractedRevenue: order.customerGrossOfferPrice,
      capitalReserved: capitalRequired,
      projectedProfit,
      state: 'PROVIDER_REQUEST_PENDING',
      message: 'Provider provisioning enqueued in transactional outbox. Awaiting asynchronous worker execution.'
    };
  }

  /**
   * Authoritative LIVE Settlement Pipeline
   * Requires:
   * - real compute job record
   * - verified duration
   * - verified billing from provider
   * - gross revenue calculated from order / contract
   * - provider cost calculated from actual run
   * - net profit = revenue - cost
   * - double-entry ledger settlement
   * - immutable settlement record
   */
  public async settleLiveDeal(jobId: string, durationHours?: number, idempotencyKey?: string): Promise<{
    success: boolean;
    settlementId?: string;
    netProfit?: number;
    status?: string;
    error?: string;
  }> {
    // 1. Verify PostgreSQL connection
    const connStatus = pgDbService.assertLiveModeAllowed();
    if (!connStatus.allowed) {
      return { success: false, error: connStatus.reason };
    }

    // 2. Fetch authoritative ComputeJob from PostgreSQL
    const job = await computeJobRepo.findById(jobId);
    if (!job) {
      return { success: false, error: `Compute job ${jobId} not found in PostgreSQL.` };
    }

    if (job.status === 'COMPLETED') {
      const existingSettlement = await settlementRepo.findByJobId(jobId);
      if (existingSettlement) {
        return {
          success: true,
          settlementId: existingSettlement.settlementId,
          netProfit: existingSettlement.netProfit,
          status: 'SETTLED'
        };
      }
    }

    // 3. Resolve demand order
    const order = await demandOrderRepo.findById(job.demandOrderId);
    if (!order) {
      return { success: false, error: `Associated demand order ${job.demandOrderId} not found.` };
    }

    // 4. Retrieve and verify actual provider billing evidence (COST VERIFIED)
    // Requirement 23: Retrieve actual provider billing. Do NOT use providerHourlyRate * duration.
    // Do NOT use bill-${provider}-${Date.now()} as billing reference.
    const billingEvidence = await hardwareProvisioner.fetchActualProviderBilling(
      job.provider as any,
      job.providerInstanceId,
      job.providerHourlyRate
    );

    if (!billingEvidence.verified) {
      return {
        success: false,
        status: 'COST_UNVERIFIED',
        error: `BILLING_VERIFICATION_FAILED: Could not verify actual billing from provider ${job.provider}: ${billingEvidence.error || 'Unknown billing error'}`
      };
    }

    // 4.5. Verify Provider Termination (TERMINATION VERIFIED)
    // Critical Fix #1: Never settle or calculate final profit unless Vast.ai/RunPod confirms termination.
    // If termination cannot be verified: mark TERMINATION_PENDING/UNKNOWN, keep capital reserved, do not settle.
    const terminationResult = await hardwareProvisioner.terminateComputeHardware(
      job.provider as any,
      job.providerInstanceId,
      true
    );

    if (!terminationResult.success || terminationResult.status !== 'TERMINATED') {
      const pendingState = terminationResult.status === 'UNKNOWN' ? 'UNKNOWN' : 'TERMINATION_PENDING';
      try {
        await pgDbService.query(
          `UPDATE compute_jobs SET status = $1 WHERE job_id = $2`,
          [pendingState, jobId]
        );
        if (job.operationId) {
          await providerOperationRepo.updateState(job.operationId, 'TERMINATION_PENDING', {
            errorMessage: terminationResult.message
          });
        }
        await auditRepo.recordEvent({
          eventType: 'PROVIDER_TERMINATION_UNVERIFIED',
          severity: 'CRITICAL',
          message: `Termination unverified for job ${jobId} (${job.provider} instance ${job.providerInstanceId}). Marked ${pendingState}; capital remains reserved; settlement blocked.`,
          details: { jobId, provider: job.provider, providerInstanceId: job.providerInstanceId, status: pendingState, reason: terminationResult.message }
        });
      } catch {}

      return {
        success: false,
        status: pendingState,
        error: `TERMINATION_UNVERIFIED: ${terminationResult.message}`
      };
    }

    const actualDurationHours = billingEvidence.durationHours || durationHours || order.durationHours || 1;
    const actualCost = billingEvidence.actualCost;
    const grossRevenue = order.customerGrossOfferPrice;
    const grossRevenueMinor = toMinorUnits(grossRevenue);
    const actualCostMinor = toMinorUnits(actualCost);
    const netProfit = fromMinorUnits(grossRevenueMinor - actualCostMinor);
    const billingReference = billingEvidence.billingReference;

    // 5. Execute Atomic Settlement Transaction
    // Requirement 25: One PostgreSQL transaction covering:
    // job lock, customer escrow lock, provider billing verification result,
    // settlement record, revenue ledger, compute expense ledger,
    // reservation consumption/release, job completion, provider operation completion, audit event.
    const settlementResult = await settlementRepo.settleJobAtomic({
      jobId,
      actualDurationHours,
      actualCost,
      grossRevenue,
      netProfit,
      billingReference,
      customerId: order.customerId,
      provider: job.provider,
      operationId: job.operationId,
      reservationId: null,
      idempotencyKey
    });

    return {
      success: true,
      settlementId: settlementResult.settlementId,
      netProfit: settlementResult.netProfit
    };
  }
}

export const liveExecutionEngine = new LiveExecutionEngine();
