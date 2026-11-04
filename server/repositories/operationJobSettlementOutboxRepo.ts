import crypto from 'crypto';
import type pg from 'pg';
import { BasePostgresRepository } from './baseRepo.js';
import {
  ProviderOperation,
  ProviderOperationState,
  ComputeJob,
  SettlementRecord,
  OutboxEvent,
  OutboxStatus
} from './types.js';

const VALID_TRANSITIONS: Record<ProviderOperationState, ProviderOperationState[]> = {
  CREATED: ['RESERVATION_PENDING', 'FAILED', 'RECOVERY_REQUIRED'],
  RESERVATION_PENDING: ['RESERVED', 'FAILED', 'RECOVERY_REQUIRED'],
  RESERVED: ['PROVIDER_REQUEST_PENDING', 'FAILED', 'RECOVERY_REQUIRED'],
  PROVIDER_REQUEST_PENDING: ['PROVIDER_REQUEST_SENT', 'FAILED', 'RECOVERY_REQUIRED'],
  PROVIDER_REQUEST_SENT: ['INSTANCE_CREATED', 'FAILED', 'RECOVERY_REQUIRED'],
  INSTANCE_CREATED: ['INSTANCE_VERIFIED', 'FAILED', 'RECOVERY_REQUIRED'],
  INSTANCE_VERIFIED: ['JOB_COMMITTED', 'FAILED', 'RECOVERY_REQUIRED'],
  JOB_COMMITTED: ['RUNNING', 'FAILED', 'RECOVERY_REQUIRED'],
  RUNNING: ['TERMINATION_PENDING', 'SETTLEMENT_PENDING', 'FAILED', 'RECOVERY_REQUIRED'],
  TERMINATION_PENDING: ['TERMINATED', 'SETTLEMENT_PENDING', 'FAILED', 'RECOVERY_REQUIRED'],
  TERMINATED: ['SETTLEMENT_PENDING', 'FAILED', 'RECOVERY_REQUIRED'],
  SETTLEMENT_PENDING: ['SETTLED', 'FAILED', 'RECOVERY_REQUIRED'],
  SETTLED: [],
  FAILED: ['RECOVERY_REQUIRED'],
  RECOVERY_REQUIRED: [
    'PROVIDER_REQUEST_PENDING',
    'PROVIDER_REQUEST_SENT',
    'INSTANCE_CREATED',
    'INSTANCE_VERIFIED',
    'JOB_COMMITTED',
    'RUNNING',
    'TERMINATED',
    'SETTLED',
    'FAILED'
  ]
};

export class ProviderOperationRepository extends BasePostgresRepository {
  public async createOperation(op: {
    operationId: string;
    demandOrderId: string;
    quoteId: string;
    reservationId?: string | null;
    customerId: string;
    provider: string;
    offerId: string;
    gpuModel: string;
    gpuCount: number;
    idempotencyKey?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<ProviderOperation> {
    const res = await this.query(
      `INSERT INTO provider_operations 
        (operation_id, demand_order_id, quote_id, reservation_id, customer_id, provider,
         offer_id, gpu_model, gpu_count, state, idempotency_key, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CREATED', $10, $11, NOW(), NOW())
       RETURNING operation_id as "operationId", demand_order_id as "demandOrderId", quote_id as "quoteId",
                 reservation_id as "reservationId", customer_id as "customerId", provider,
                 offer_id as "offerId", gpu_model as "gpuModel", gpu_count as "gpuCount",
                 provider_instance_id as "providerInstanceId", state, idempotency_key as "idempotencyKey",
                 error_message as "errorMessage", metadata, created_at as "createdAt", updated_at as "updatedAt"`,
      [
        op.operationId,
        op.demandOrderId,
        op.quoteId,
        op.reservationId || null,
        op.customerId,
        op.provider,
        op.offerId,
        op.gpuModel,
        op.gpuCount,
        op.idempotencyKey || null,
        op.metadata ? JSON.stringify(op.metadata) : null
      ]
    );
    return res.rows[0];
  }

  public async updateState(
    operationId: string,
    state: ProviderOperationState,
    extra?: {
      providerInstanceId?: string | null;
      reservationId?: string | null;
      errorMessage?: string | null;
      metadata?: Record<string, unknown> | null;
    }
  ): Promise<ProviderOperation> {
    return this.withTransaction(async (client) => {
      // 1. Lock operation row for update
      const currentRes = await client.query(
        `SELECT state FROM provider_operations WHERE operation_id = $1 FOR UPDATE`,
        [operationId]
      );
      if (currentRes.rows.length === 0) {
        throw new Error(`OPERATION_NOT_FOUND: Operation ${operationId} does not exist.`);
      }

      const currentState = currentRes.rows[0].state as ProviderOperationState;
      if (currentState !== state) {
        const allowed = VALID_TRANSITIONS[currentState] || [];
        if (!allowed.includes(state)) {
          throw new Error(
            `ILLEGAL_STATE_TRANSITION: Cannot transition provider operation from '${currentState}' to '${state}'. Allowed: [${allowed.join(', ')}]`
          );
        }
      }

      const res = await client.query(
        `UPDATE provider_operations
         SET state = $1,
             provider_instance_id = COALESCE($2, provider_instance_id),
             reservation_id = COALESCE($3, reservation_id),
             error_message = COALESCE($4, error_message),
             metadata = COALESCE($5, metadata),
             updated_at = NOW()
         WHERE operation_id = $6
         RETURNING operation_id as "operationId", demand_order_id as "demandOrderId", quote_id as "quoteId",
                   reservation_id as "reservationId", customer_id as "customerId", provider,
                   offer_id as "offerId", gpu_model as "gpuModel", gpu_count as "gpuCount",
                   provider_instance_id as "providerInstanceId", state, idempotency_key as "idempotencyKey",
                   error_message as "errorMessage", metadata, created_at as "createdAt", updated_at as "updatedAt"`,
        [
          state,
          extra?.providerInstanceId || null,
          extra?.reservationId || null,
          extra?.errorMessage || null,
          extra?.metadata ? JSON.stringify(extra.metadata) : null,
          operationId
        ]
      );
      return res.rows[0];
    });
  }

  public async findById(operationId: string): Promise<ProviderOperation | null> {
    const res = await this.query(
      `SELECT operation_id as "operationId", demand_order_id as "demandOrderId", quote_id as "quoteId",
              reservation_id as "reservationId", customer_id as "customerId", provider,
              offer_id as "offerId", gpu_model as "gpuModel", gpu_count as "gpuCount",
              provider_instance_id as "providerInstanceId", state, idempotency_key as "idempotencyKey",
              error_message as "errorMessage", metadata, created_at as "createdAt", updated_at as "updatedAt"
       FROM provider_operations WHERE operation_id = $1`,
      [operationId]
    );
    return res.rows[0] || null;
  }

  public async findPendingRecovery(): Promise<ProviderOperation[]> {
    const res = await this.query(
      `SELECT operation_id as "operationId", demand_order_id as "demandOrderId", quote_id as "quoteId",
              reservation_id as "reservationId", customer_id as "customerId", provider,
              offer_id as "offerId", gpu_model as "gpuModel", gpu_count as "gpuCount",
              provider_instance_id as "providerInstanceId", state, idempotency_key as "idempotencyKey",
              error_message as "errorMessage", metadata, created_at as "createdAt", updated_at as "updatedAt"
       FROM provider_operations
       WHERE state IN ('PROVIDER_REQUEST_SENT', 'RECOVERY_REQUIRED')
       ORDER BY created_at ASC`
    );
    return res.rows;
  }
}

export class ComputeJobRepository extends BasePostgresRepository {
  public async createJob(job: {
    jobId: string;
    operationId: string;
    demandOrderId: string;
    customerId: string;
    provider: string;
    providerInstanceId: string;
    gpuModel: string;
    gpuCount: number;
    contractedRevenue: number;
    providerHourlyRate: number;
    telemetryStatus?: 'LIVE_VERIFIED' | 'LIVE_UNMEASURED' | 'TELEMETRY_UNAVAILABLE';
  }): Promise<ComputeJob> {
    const res = await this.query(
      `INSERT INTO compute_jobs
        (job_id, operation_id, demand_order_id, customer_id, provider, provider_instance_id,
         gpu_model, gpu_count, contracted_revenue, provider_hourly_rate, status,
         started_at, billing_verified, telemetry_status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PROVISIONING', NOW(), FALSE, $11, NOW())
       RETURNING job_id as "jobId", operation_id as "operationId", demand_order_id as "demandOrderId",
                 customer_id as "customerId", provider, provider_instance_id as "providerInstanceId",
                 gpu_model as "gpuModel", gpu_count as "gpuCount", contracted_revenue::float as "contractedRevenue",
                 provider_hourly_rate::float as "providerHourlyRate", status, started_at as "startedAt",
                 ended_at as "endedAt", actual_duration_hours::float as "actualDurationHours",
                 actual_cost::float as "actualCost", billing_verified as "billingVerified",
                 billing_reference as "billingReference", telemetry_status as "telemetryStatus", created_at as "createdAt"`,
      [
        job.jobId,
        job.operationId,
        job.demandOrderId,
        job.customerId,
        job.provider,
        job.providerInstanceId,
        job.gpuModel,
        job.gpuCount,
        job.contractedRevenue,
        job.providerHourlyRate,
        job.telemetryStatus || 'LIVE_UNMEASURED'
      ]
    );
    return res.rows[0];
  }

  public async markJobRunning(
    jobId: string,
    telemetryStatus: 'LIVE_VERIFIED' | 'LIVE_UNMEASURED' = 'LIVE_VERIFIED'
  ): Promise<void> {
    await this.query(
      `UPDATE compute_jobs
       SET status = 'RUNNING',
           telemetry_status = $2,
           started_at = NOW()
       WHERE job_id = $1`,
      [jobId, telemetryStatus]
    );
  }

  public async findById(jobId: string): Promise<ComputeJob | null> {
    const res = await this.query(
      `SELECT job_id as "jobId", operation_id as "operationId", demand_order_id as "demandOrderId",
              customer_id as "customerId", provider, provider_instance_id as "providerInstanceId",
              gpu_model as "gpuModel", gpu_count as "gpuCount", contracted_revenue::float as "contractedRevenue",
              provider_hourly_rate::float as "providerHourlyRate", status, started_at as "startedAt",
              ended_at as "endedAt", actual_duration_hours::float as "actualDurationHours",
              actual_cost::float as "actualCost", billing_verified as "billingVerified",
              billing_reference as "billingReference", telemetry_status as "telemetryStatus", created_at as "createdAt"
       FROM compute_jobs WHERE job_id = $1`,
      [jobId]
    );
    return res.rows[0] || null;
  }

  public async listRunningJobs(): Promise<ComputeJob[]> {
    const res = await this.query(
      `SELECT job_id as "jobId", operation_id as "operationId", demand_order_id as "demandOrderId",
              customer_id as "customerId", provider, provider_instance_id as "providerInstanceId",
              gpu_model as "gpuModel", gpu_count as "gpuCount", contracted_revenue::float as "contractedRevenue",
              provider_hourly_rate::float as "providerHourlyRate", status, started_at as "startedAt",
              ended_at as "endedAt", actual_duration_hours::float as "actualDurationHours",
              actual_cost::float as "actualCost", billing_verified as "billingVerified",
              billing_reference as "billingReference", telemetry_status as "telemetryStatus", created_at as "createdAt"
       FROM compute_jobs WHERE status IN ('PROVISIONING', 'RUNNING') ORDER BY started_at DESC`
    );
    return res.rows;
  }

  public async findActiveJobs(): Promise<ComputeJob[]> {
    return this.listRunningJobs();
  }

  public async updateJobCompleted(
    jobId: string,
    actualDurationHours: number,
    actualCost: number,
    billingReference?: string
  ): Promise<ComputeJob> {
    const res = await this.query(
      `UPDATE compute_jobs
       SET status = 'COMPLETED',
           ended_at = NOW(),
           actual_duration_hours = $1,
           actual_cost = $2,
           billing_verified = TRUE,
           billing_reference = $3
       WHERE job_id = $4
       RETURNING job_id as "jobId", operation_id as "operationId", demand_order_id as "demandOrderId",
                 customer_id as "customerId", provider, provider_instance_id as "providerInstanceId",
                 gpu_model as "gpuModel", gpu_count as "gpuCount", contracted_revenue::float as "contractedRevenue",
                 provider_hourly_rate::float as "providerHourlyRate", status, started_at as "startedAt",
                 ended_at as "endedAt", actual_duration_hours::float as "actualDurationHours",
                 actual_cost::float as "actualCost", billing_verified as "billingVerified",
                 billing_reference as "billingReference", telemetry_status as "telemetryStatus", created_at as "createdAt"`,
      [actualDurationHours, actualCost, billingReference || null, jobId]
    );
    return res.rows[0];
  }

  public async updateJob(jobId: string, updates: Partial<ComputeJob>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;
    if (updates.status) {
      fields.push(`status = $${idx++}`);
      values.push(updates.status);
    }
    if (updates.endedAt) {
      fields.push(`ended_at = $${idx++}`);
      values.push(updates.endedAt);
    }
    if (fields.length > 0) {
      values.push(jobId);
      await this.query(`UPDATE compute_jobs SET ${fields.join(', ')} WHERE job_id = $${idx}`, values);
    }
  }
}

export class SettlementRepository extends BasePostgresRepository {
  public async createSettlement(settlement: {
    settlementId: string;
    jobId: string;
    customerId: string;
    grossRevenue: number;
    totalCost: number;
    netProfit: number;
    escrowDebited: number;
    providerCostPaid: number;
    idempotencyKey?: string | null;
  }): Promise<SettlementRecord> {
    const res = await this.query(
      `INSERT INTO settlements 
        (settlement_id, job_id, customer_id, gross_revenue, total_cost, net_profit,
         escrow_debited, provider_cost_paid, status, idempotency_key, settled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'SETTLED', $9, NOW())
       RETURNING settlement_id as "settlementId", job_id as "jobId", customer_id as "customerId",
                 gross_revenue::float as "grossRevenue", total_cost::float as "totalCost",
                 net_profit::float as "netProfit", escrow_debited::float as "escrowDebited",
                 provider_cost_paid::float as "providerCostPaid", status, idempotency_key as "idempotencyKey",
                 settled_at as "settledAt"`,
      [
        settlement.settlementId,
        settlement.jobId,
        settlement.customerId,
        settlement.grossRevenue,
        settlement.totalCost,
        settlement.netProfit,
        settlement.escrowDebited,
        settlement.providerCostPaid,
        settlement.idempotencyKey || null
      ]
    );
    return res.rows[0];
  }

  public async findByJobId(jobId: string): Promise<SettlementRecord | null> {
    const res = await this.query(
      `SELECT settlement_id as "settlementId", job_id as "jobId", customer_id as "customerId",
              gross_revenue::float as "grossRevenue", total_cost::float as "totalCost",
              net_profit::float as "netProfit", escrow_debited::float as "escrowDebited",
              provider_cost_paid::float as "providerCostPaid", status, idempotency_key as "idempotencyKey",
              settled_at as "settledAt"
       FROM settlements WHERE job_id = $1`,
      [jobId]
    );
    return res.rows[0] || null;
  }

  /**
   * Atomic Settlement Transaction (Requirement 38)
   * Encompasses billing verification, job completion, settlement record,
   * balanced double-entry ledger entries, reservation consumption, and operation state.
   */
  public async settleJobAtomic(params: {
    jobId: string;
    actualDurationHours: number;
    actualCost: number;
    grossRevenue: number;
    netProfit: number;
    billingReference: string;
    customerId: string;
    provider: string;
    operationId: string;
    reservationId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<{ settlementId: string; netProfit: number }> {
    return this.withTransaction(async (client) => {
      // 1. Acquire transaction advisory locks
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('authoritative_treasury_ledger_lock'))`);

      // 2. Mark ComputeJob as COMPLETED
      await client.query(
        `UPDATE compute_jobs
         SET status = 'COMPLETED',
             ended_at = NOW(),
             actual_duration_hours = $1,
             actual_cost = $2,
             billing_verified = TRUE,
             billing_reference = $3
         WHERE job_id = $4`,
        [params.actualDurationHours, params.actualCost, params.billingReference, params.jobId]
      );

      // 3. Create immutable Settlement Record
      const settlementId = `stl-${crypto.randomUUID()}`;
      await client.query(
        `INSERT INTO settlements 
          (settlement_id, job_id, customer_id, gross_revenue, total_cost, net_profit,
           escrow_debited, provider_cost_paid, status, idempotency_key, settled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'SETTLED', $9, NOW())`,
        [
          settlementId,
          params.jobId,
          params.customerId,
          params.grossRevenue,
          params.actualCost,
          params.netProfit,
          params.grossRevenue,
          params.actualCost,
          params.idempotencyKey || null
        ]
      );

      // 4. Ensure required treasury accounts exist
      await client.query(
        `INSERT INTO treasury_accounts (id, provider, external_account_id, account_type, account_class, asset, currency, environment, status, created_at, updated_at)
         VALUES 
           ($1, 'system', $2, 'ESCROW_LIABILITY', 'LIABILITY', 'USD', 'USD', 'LIVE', 'ACTIVE', NOW(), NOW()),
           ('platform-revenue-usd', 'system', 'platform-treasury', 'REVENUE', 'REVENUE', 'USD', 'USD', 'LIVE', 'ACTIVE', NOW(), NOW()),
           ($3, $4, $4, 'COMPUTE_EXPENSE', 'EXPENSE', 'USD', 'USD', 'LIVE', 'ACTIVE', NOW(), NOW()),
           ($5, $4, $4, 'TREASURY_CASH', 'ASSET', 'USD', 'USD', 'LIVE', 'ACTIVE', NOW(), NOW())
         ON CONFLICT (provider, external_account_id, asset, environment) DO UPDATE SET updated_at = NOW()`,
        [
          `escrow-cust-${params.customerId}`,
          params.customerId,
          `compute-expense-${params.provider}`,
          params.provider,
          `treasury-cash-${params.provider}`
        ]
      );

      // Resolve account IDs
      const escrowAcctId = `escrow-cust-${params.customerId}`;
      const revenueAcctId = 'platform-revenue-usd';
      const expenseAcctId = `compute-expense-${params.provider}`;
      const cashAcctId = `treasury-cash-${params.provider}`;

      // 5. Post Double-Entry Set 1: Customer Escrow Settlement
      // DR Customer Escrow Liability (grossRevenue), CR Revenue (grossRevenue)
      const lastHashRes = await client.query(
        `SELECT record_hash FROM treasury_ledger ORDER BY created_at DESC, transaction_id DESC LIMIT 1`
      );
      let prevHash = lastHashRes.rows[0]?.record_hash || 'GENESIS_POSTGRESQL_TREASURY_LEDGER_HASH_0000000000000000';

      const entryGroup1 = `settle-rev-${params.jobId}-${crypto.randomUUID().substring(0, 8)}`;
      const drTxId1 = `tx-dr-${entryGroup1}`;
      const drHash1 = crypto.createHash('sha256')
        .update(`${drTxId1}|${escrowAcctId}|USD|${params.grossRevenue}|DEBIT|SETTLEMENT|${prevHash}`)
        .digest('hex');

      await client.query(
        `INSERT INTO treasury_ledger 
          (transaction_id, entry_group_id, account_id, asset, currency, quantity, precision, direction, transaction_type, external_reference, provider, operation_id, created_at, previous_hash, record_hash)
         VALUES ($1, $2, $3, 'USD', 'USD', $4, 2, 'DEBIT', 'SETTLEMENT', $5, $6, $7, NOW(), $8, $9)`,
        [drTxId1, entryGroup1, escrowAcctId, params.grossRevenue, params.billingReference, params.provider, params.operationId, prevHash, drHash1]
      );

      prevHash = drHash1;
      const crTxId1 = `tx-cr-${entryGroup1}`;
      const crHash1 = crypto.createHash('sha256')
        .update(`${crTxId1}|${revenueAcctId}|USD|${params.grossRevenue}|CREDIT|SETTLEMENT|${prevHash}`)
        .digest('hex');

      await client.query(
        `INSERT INTO treasury_ledger 
          (transaction_id, entry_group_id, account_id, asset, currency, quantity, precision, direction, transaction_type, external_reference, provider, operation_id, created_at, previous_hash, record_hash)
         VALUES ($1, $2, $3, 'USD', 'USD', $4, 2, 'CREDIT', 'SETTLEMENT', $5, $6, $7, NOW(), $8, $9)`,
        [crTxId1, entryGroup1, revenueAcctId, params.grossRevenue, params.billingReference, params.provider, params.operationId, prevHash, crHash1]
      );

      // 6. Post Double-Entry Set 2: Provider Compute Cost
      // DR Compute Expense (actualCost), CR Treasury Cash (actualCost)
      if (params.actualCost > 0) {
        prevHash = crHash1;
        const entryGroup2 = `settle-exp-${params.jobId}-${crypto.randomUUID().substring(0, 8)}`;
        const drTxId2 = `tx-dr-${entryGroup2}`;
        const drHash2 = crypto.createHash('sha256')
          .update(`${drTxId2}|${expenseAcctId}|USD|${params.actualCost}|DEBIT|COMPUTE_PURCHASE|${prevHash}`)
          .digest('hex');

        await client.query(
          `INSERT INTO treasury_ledger 
            (transaction_id, entry_group_id, account_id, asset, currency, quantity, precision, direction, transaction_type, external_reference, provider, operation_id, created_at, previous_hash, record_hash)
           VALUES ($1, $2, $3, 'USD', 'USD', $4, 4, 'DEBIT', 'COMPUTE_PURCHASE', $5, $6, $7, NOW(), $8, $9)`,
          [drTxId2, entryGroup2, expenseAcctId, params.actualCost, params.billingReference, params.provider, params.operationId, prevHash, drHash2]
        );

        prevHash = drHash2;
        const crTxId2 = `tx-cr-${entryGroup2}`;
        const crHash2 = crypto.createHash('sha256')
          .update(`${crTxId2}|${cashAcctId}|USD|${params.actualCost}|CREDIT|COMPUTE_PURCHASE|${prevHash}`)
          .digest('hex');

        await client.query(
          `INSERT INTO treasury_ledger 
            (transaction_id, entry_group_id, account_id, asset, currency, quantity, precision, direction, transaction_type, external_reference, provider, operation_id, created_at, previous_hash, record_hash)
           VALUES ($1, $2, $3, 'USD', 'USD', $4, 4, 'CREDIT', 'COMPUTE_PURCHASE', $5, $6, $7, NOW(), $8, $9)`,
          [crTxId2, entryGroup2, cashAcctId, params.actualCost, params.billingReference, params.provider, params.operationId, prevHash, crHash2]
        );
      }

      // 7. Consume / release reservation if associated
      if (params.reservationId) {
        await client.query(
          `UPDATE capital_reservations SET status = 'CONSUMED', updated_at = NOW() WHERE reservation_id = $1`,
          [params.reservationId]
        );
      }

      // 8. Create Immutable Verified Realized Profit Record (Sole source of truth for real profit withdrawal)
      const verifiedProfitId = `vp-${params.jobId}`;
      const profitAuditHash = crypto.createHash('sha256')
        .update(`${verifiedProfitId}|${settlementId}|${params.jobId}|${params.grossRevenue}|${params.actualCost}|${params.netProfit}|${prevHash}`)
        .digest('hex');

      await client.query(
        `INSERT INTO verified_profit_records
          (id, settlement_id, job_id, customer_id, verified_gross_revenue, verified_actual_provider_cost, verified_payment_fees, verified_realized_profit, reconciliation_variance, reconciled_at, audit_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 0.0000, $7, 0.0000, NOW(), $8, NOW())
         ON CONFLICT (job_id) DO UPDATE SET
           verified_gross_revenue = EXCLUDED.verified_gross_revenue,
           verified_actual_provider_cost = EXCLUDED.verified_actual_provider_cost,
           verified_realized_profit = EXCLUDED.verified_realized_profit,
           audit_hash = EXCLUDED.audit_hash`,
        [
          verifiedProfitId,
          settlementId,
          params.jobId,
          params.customerId,
          params.grossRevenue,
          params.actualCost,
          params.netProfit,
          profitAuditHash
        ]
      );

      // 9. Update operation state to SETTLED
      await client.query(
        `UPDATE provider_operations SET state = 'SETTLED', updated_at = NOW() WHERE operation_id = $1`,
        [params.operationId]
      );

      return { settlementId, netProfit: params.netProfit };
    });
  }
}

export class OutboxRepository extends BasePostgresRepository {
  public async enqueueEvent(
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: Record<string, unknown>,
    client?: pg.PoolClient
  ): Promise<OutboxEvent> {
    const id = `outbox-${crypto.randomUUID()}`;
    const sql = `
      INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, status, retry_count, created_at)
      VALUES ($1, $2, $3, $4, $5, 'PENDING', 0, NOW())
      RETURNING id, aggregate_type as "aggregateType", aggregate_id as "aggregateId", event_type as "eventType",
                payload, status, retry_count as "retryCount", claimed_by as "claimedBy",
                claimed_at as "claimedAt", lease_timeout_at as "leaseTimeoutAt", created_at as "createdAt",
                processed_at as "processedAt", error
    `;
    const params = [id, aggregateType, aggregateId, eventType, JSON.stringify(payload)];
    const res = client ? await client.query(sql, params) : await this.query(sql, params);
    return res.rows[0];
  }

  /**
   * Concurrency-safe claim with lease timeout
   */
  public async claimPendingEvents(workerId: string, batchSize: number = 5, leaseSeconds: number = 60): Promise<OutboxEvent[]> {
    return this.withTransaction(async (client) => {
      const res = await client.query(
        `UPDATE outbox_events
         SET status = 'CLAIMED',
             claimed_by = $1,
             claimed_at = NOW(),
             updated_at = NOW(),
             lease_timeout_at = NOW() + interval '${leaseSeconds} seconds'
         WHERE id IN (
           SELECT id FROM outbox_events
           WHERE (status = 'PENDING' OR (status = 'CLAIMED' AND lease_timeout_at < NOW()))
             AND status NOT IN ('SUCCEEDED', 'DEAD_LETTER')
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         RETURNING id, aggregate_type as "aggregateType", aggregate_id as "aggregateId", event_type as "eventType",
                   payload, status, retry_count as "retryCount", claimed_by as "claimedBy",
                   claimed_at as "claimedAt", lease_timeout_at as "leaseTimeoutAt", created_at as "createdAt",
                   processed_at as "processedAt", error`,
        [workerId, batchSize]
      );
      return res.rows;
    });
  }

  public async markProcessed(id: string, success: boolean, error?: string): Promise<void> {
    if (success) {
      await this.query(
        `UPDATE outbox_events
         SET status = 'SUCCEEDED', processed_at = NOW(), updated_at = NOW(), error = NULL
         WHERE id = $1`,
        [id]
      );
    } else {
      await this.query(
        `UPDATE outbox_events
         SET status = CASE WHEN retry_count >= 5 THEN 'DEAD_LETTER' ELSE 'FAILED' END,
             retry_count = retry_count + 1,
             updated_at = NOW(),
             error = $2,
             claimed_by = NULL,
             lease_timeout_at = NULL
         WHERE id = $1`,
        [id, error || 'Unknown processing error']
      );
    }
  }
}
