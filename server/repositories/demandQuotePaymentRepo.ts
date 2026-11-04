import { BasePostgresRepository } from './baseRepo.js';
import { AuthoritativeDemandOrder, AuthoritativeQuote } from './types.js';

export class DemandOrderRepository extends BasePostgresRepository {
  public async findById(id: string): Promise<AuthoritativeDemandOrder | null> {
    const res = await this.query(
      `SELECT id, customer_id as "customerId", customer_name as "customerName", demand_class as "demandClass",
              workload_type as "workloadType", gpu_model as "gpuModel", min_vram_gb as "minVramGb",
              gpu_count as "gpuCount", duration_hours::float as "durationHours", deadline_minutes as "deadlineMinutes",
              customer_gross_offer_price::float as "customerGrossOfferPrice", customer_hourly_rate::float as "customerHourlyRate",
              payment_status as "paymentStatus", demand_source as "demandSource", auth_signature as "authSignature",
              escrow_reference_id as "escrowReferenceId", is_confirmed as "isConfirmed", created_at as "createdAt"
       FROM demand_orders WHERE id = $1`,
      [id]
    );
    return res.rows[0] || null;
  }

  public async create(order: {
    id: string;
    customerId: string;
    customerName: string;
    demandClass?: 'CONFIRMED' | 'PROBABLE' | 'PREDICTED';
    workloadType: string;
    gpuModel: string;
    minVramGb: number;
    gpuCount: number;
    durationHours: number;
    deadlineMinutes: number;
    customerGrossOfferPrice: number;
    customerHourlyRate: number;
    paymentStatus: 'QUOTE_PENDING' | 'ESCROW_AUTHORIZED' | 'PREPAID_CREDIT' | 'SETTLED';
    demandSource: string;
    authSignature: string;
    escrowReferenceId?: string | null;
    isConfirmed?: boolean;
  }): Promise<AuthoritativeDemandOrder> {
    const res = await this.query(
      `INSERT INTO demand_orders 
        (id, customer_id, customer_name, demand_class, workload_type, gpu_model, min_vram_gb,
         gpu_count, duration_hours, deadline_minutes, customer_gross_offer_price, customer_hourly_rate,
         payment_status, demand_source, auth_signature, escrow_reference_id, is_confirmed, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
       RETURNING id, customer_id as "customerId", customer_name as "customerName", demand_class as "demandClass",
                 workload_type as "workloadType", gpu_model as "gpuModel", min_vram_gb as "minVramGb",
                 gpu_count as "gpuCount", duration_hours::float as "durationHours", deadline_minutes as "deadlineMinutes",
                 customer_gross_offer_price::float as "customerGrossOfferPrice", customer_hourly_rate::float as "customerHourlyRate",
                 payment_status as "paymentStatus", demand_source as "demandSource", auth_signature as "authSignature",
                 escrow_reference_id as "escrowReferenceId", is_confirmed as "isConfirmed", created_at as "createdAt"`,
      [
        order.id,
        order.customerId,
        order.customerName,
        order.demandClass || 'CONFIRMED',
        order.workloadType,
        order.gpuModel,
        order.minVramGb,
        order.gpuCount || 1,
        order.durationHours,
        order.deadlineMinutes,
        order.customerGrossOfferPrice,
        order.customerHourlyRate,
        order.paymentStatus,
        order.demandSource,
        order.authSignature,
        order.escrowReferenceId || null,
        order.isConfirmed ?? false
      ]
    );
    return res.rows[0];
  }

  public async createOrder(order: {
    id: string;
    customerId: string;
    customerName: string;
    demandClass?: 'CONFIRMED' | 'PROBABLE' | 'PREDICTED';
    workloadType: string;
    gpuModel: string;
    minVramGb: number;
    gpuCount: number;
    durationHours: number;
    deadlineMinutes: number;
    customerGrossOfferPrice: number;
    customerHourlyRate: number;
    paymentStatus: 'QUOTE_PENDING' | 'ESCROW_AUTHORIZED' | 'PREPAID_CREDIT' | 'SETTLED';
    demandSource: string;
    authSignature: string;
    escrowReferenceId?: string | null;
    isConfirmed?: boolean;
  }): Promise<AuthoritativeDemandOrder> {
    return this.create(order);
  }

  public async updatePaymentStatus(
    id: string,
    paymentStatus: string,
    escrowReferenceId?: string,
    isConfirmed: boolean = true
  ): Promise<void> {
    await this.query(
      `UPDATE demand_orders
       SET payment_status = $1, escrow_reference_id = COALESCE($2, escrow_reference_id), is_confirmed = $3
       WHERE id = $4`,
      [paymentStatus, escrowReferenceId || null, isConfirmed, id]
    );
  }

  public async listAll(): Promise<AuthoritativeDemandOrder[]> {
    const res = await this.query(
      `SELECT id, customer_id as "customerId", customer_name as "customerName", demand_class as "demandClass",
              workload_type as "workloadType", gpu_model as "gpuModel", min_vram_gb as "minVramGb",
              gpu_count as "gpuCount", duration_hours::float as "durationHours", deadline_minutes as "deadlineMinutes",
              customer_gross_offer_price::float as "customerGrossOfferPrice", customer_hourly_rate::float as "customerHourlyRate",
              payment_status as "paymentStatus", demand_source as "demandSource", auth_signature as "authSignature",
              escrow_reference_id as "escrowReferenceId", is_confirmed as "isConfirmed", created_at as "createdAt"
       FROM demand_orders ORDER BY created_at DESC`
    );
    return res.rows;
  }
}

export class QuoteRepository extends BasePostgresRepository {
  public async createQuote(quote: {
    quoteId: string;
    customerId: string;
    demandOrderId: string;
    provider: string;
    offerId: string;
    gpuModel: string;
    gpuCount: number;
    region?: string;
    durationHours: number;
    verifiedHourlyPrice: number;
    maxTotalCost: number;
    currency?: string;
    expiresAt?: string;
    expiresInSeconds?: number;
    nonce?: string;
    signature?: string;
  }): Promise<AuthoritativeQuote> {
    const crypto = await import('crypto');
    const issuedAt = new Date().toISOString();
    const expiresAt = quote.expiresAt || new Date(Date.now() + (quote.expiresInSeconds || 60) * 1000).toISOString();
    const nonce = quote.nonce || crypto.randomBytes(16).toString('hex');
    const secret = process.env.QUOTE_LOCK_SECRET;
    if (!secret) {
      throw new Error('CONFIG_ERROR: QUOTE_LOCK_SECRET is strictly required for cryptographic quote locks.');
    }

    const region = quote.region || 'US-East';
    const currency = quote.currency || 'USD';
    const verifiedHourlyPriceFormatted = Number(quote.verifiedHourlyPrice).toFixed(4);
    const maxTotalCostFormatted = Number(quote.maxTotalCost).toFixed(4);

    // Canonical HMAC payload per Requirement 16:
    // quoteId|customerId|demandOrderId|provider|offerId|gpuModel|gpuCount|region|durationHours|verifiedHourlyPrice|maxTotalCost|currency|issuedAt|expiresAt|nonce
    const payload = `${quote.quoteId}|${quote.customerId}|${quote.demandOrderId}|${quote.provider}|${quote.offerId}|${quote.gpuModel}|${quote.gpuCount}|${region}|${quote.durationHours}|${verifiedHourlyPriceFormatted}|${maxTotalCostFormatted}|${currency}|${issuedAt}|${expiresAt}|${nonce}`;
    const signature = quote.signature || crypto.createHmac('sha256', secret).update(payload).digest('hex');

    const res = await this.query(
      `INSERT INTO quotes 
        (quote_id, customer_id, demand_order_id, provider, offer_id, gpu_model, gpu_count,
         region, duration_hours, verified_hourly_price, max_total_cost, currency,
         issued_at, expires_at, nonce, signature, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'ISSUED', NOW())
       RETURNING quote_id as "quoteId", customer_id as "customerId", demand_order_id as "demandOrderId",
                 provider, offer_id as "offerId", gpu_model as "gpuModel", gpu_count as "gpuCount",
                 region, duration_hours::float as "durationHours", verified_hourly_price::float as "verifiedHourlyPrice",
                 max_total_cost::float as "maxTotalCost", currency, issued_at as "issuedAt", expires_at as "expiresAt",
                 nonce, signature, status, consumed_at as "consumedAt", consumed_by as "consumedBy", created_at as "createdAt"`,
      [
        quote.quoteId,
        quote.customerId,
        quote.demandOrderId,
        quote.provider,
        quote.offerId,
        quote.gpuModel,
        quote.gpuCount,
        region,
        quote.durationHours,
        quote.verifiedHourlyPrice,
        quote.maxTotalCost,
        currency,
        issuedAt,
        expiresAt,
        nonce,
        signature
      ]
    );
    return res.rows[0];
  }

  public async findById(quoteId: string): Promise<AuthoritativeQuote | null> {
    const res = await this.query(
      `SELECT quote_id as "quoteId", customer_id as "customerId", demand_order_id as "demandOrderId",
              provider, offer_id as "offerId", gpu_model as "gpuModel", gpu_count as "gpuCount",
              region, duration_hours::float as "durationHours", verified_hourly_price::float as "verifiedHourlyPrice",
              max_total_cost::float as "maxTotalCost", currency, issued_at as "issuedAt", expires_at as "expiresAt",
              nonce, signature, status, consumed_at as "consumedAt", consumed_by as "consumedBy", created_at as "createdAt"
       FROM quotes WHERE quote_id = $1`,
      [quoteId]
    );
    return res.rows[0] || null;
  }

  /**
   * Transactionally consume quote with single-use guarantee:
   * 1. Locks quote row with SELECT FOR UPDATE.
   * 2. Verifies status === 'ISSUED'.
   * 3. Verifies not expired.
   * 4. Verifies HMAC cryptographic signature against QUOTE_LOCK_SECRET.
   * 5. Transitions status to 'CONSUMED'.
   */
  public async consumeQuoteAtomic(quoteId: string, consumedBy: string): Promise<AuthoritativeQuote | null> {
    const crypto = await import('crypto');
    const secret = process.env.QUOTE_LOCK_SECRET;
    if (!secret) {
      throw new Error('CONFIG_ERROR: QUOTE_LOCK_SECRET is strictly required for cryptographic quote locks.');
    }

    return this.withTransaction(async (client) => {
      const res = await client.query(
        `SELECT quote_id as "quoteId", customer_id as "customerId", demand_order_id as "demandOrderId",
                provider, offer_id as "offerId", gpu_model as "gpuModel", gpu_count as "gpuCount",
                region, duration_hours::float as "durationHours", verified_hourly_price::float as "verifiedHourlyPrice",
                max_total_cost::float as "maxTotalCost", currency, issued_at as "issuedAt", expires_at as "expiresAt",
                nonce, signature, status, consumed_at as "consumedAt", consumed_by as "consumedBy", created_at as "createdAt"
         FROM quotes WHERE quote_id = $1 FOR UPDATE`,
        [quoteId]
      );

      if (res.rows.length === 0) {
        return null;
      }

      const quote = res.rows[0];
      if (quote.status !== 'ISSUED') {
        return null;
      }

      if (new Date(quote.expiresAt).getTime() <= Date.now()) {
        return null;
      }

      // Verify HMAC signature
      const issuedAtStr = new Date(quote.issuedAt).toISOString();
      const expiresAtStr = new Date(quote.expiresAt).toISOString();
      const payload = `${quote.quoteId}|${quote.customerId}|${quote.demandOrderId}|${quote.provider}|${quote.offerId}|${quote.gpuModel}|${quote.gpuCount}|${quote.region}|${quote.durationHours}|${Number(quote.verifiedHourlyPrice).toFixed(4)}|${Number(quote.maxTotalCost).toFixed(4)}|${quote.currency}|${issuedAtStr}|${expiresAtStr}|${quote.nonce}`;
      const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('hex');

      // Also support legacy/flexible format if generated under earlier payload format for backwards compatibility
      const legacyPayload = `${quote.quoteId}|${quote.demandOrderId}|${quote.customerId}|${quote.provider}|${quote.offerId}|${Number(quote.verifiedHourlyPrice).toFixed(4)}|${quote.expiresAt}|${quote.nonce}`;
      const expectedLegacySig = crypto.createHmac('sha256', secret).update(legacyPayload).digest('hex');

      const matchesCurrent = crypto.timingSafeEqual(Buffer.from(quote.signature), Buffer.from(expectedSig));
      const matchesLegacy = quote.signature.length === expectedLegacySig.length && crypto.timingSafeEqual(Buffer.from(quote.signature), Buffer.from(expectedLegacySig));

      if (!matchesCurrent && !matchesLegacy) {
        throw new Error(`SECURITY_ALERT: Cryptographic HMAC signature on quote ${quoteId} is invalid or tampered.`);
      }

      const updateRes = await client.query(
        `UPDATE quotes
         SET status = 'CONSUMED',
             consumed_at = NOW(),
             consumed_by = $2
         WHERE quote_id = $1
         RETURNING quote_id as "quoteId", customer_id as "customerId", demand_order_id as "demandOrderId",
                   provider, offer_id as "offerId", gpu_model as "gpuModel", gpu_count as "gpuCount",
                   region, duration_hours::float as "durationHours", verified_hourly_price::float as "verifiedHourlyPrice",
                   max_total_cost::float as "maxTotalCost", currency, issued_at as "issuedAt", expires_at as "expiresAt",
                   nonce, signature, status, consumed_at as "consumedAt", consumed_by as "consumedBy", created_at as "createdAt"`,
        [quoteId, consumedBy]
      );

      return updateRes.rows[0] || null;
    });
  }
}

export class PaymentRepository extends BasePostgresRepository {
  public async createPaymentIntent(intent: {
    id: string;
    customerId: string;
    provider: string;
    amountMinor: bigint;
    currency: string;
    clientSecret?: string;
    reference?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.query(
      `INSERT INTO payment_intents 
        (id, customer_id, provider, amount_minor, currency, status, client_secret, reference, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8, NOW())`,
      [
        intent.id,
        intent.customerId,
        intent.provider,
        intent.amountMinor.toString(),
        intent.currency,
        intent.clientSecret || null,
        intent.reference || null,
        intent.metadata ? JSON.stringify(intent.metadata) : null
      ]
    );
  }

  public async getPaymentIntent(id: string): Promise<any | null> {
    const res = await this.query(
      `SELECT id, customer_id as "customerId", provider, amount_minor as "amountMinor",
              currency, status, client_secret as "clientSecret", reference, metadata,
              created_at as "createdAt", settled_at as "settledAt", failed_at as "failedAt"
       FROM payment_intents WHERE id = $1`,
      [id]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      ...row,
      amountMinor: BigInt(row.amountMinor)
    };
  }

  public async getProviderTransaction(provider: string, providerTransactionId: string): Promise<any | null> {
    const res = await this.query(
      `SELECT id, payment_intent_id as "paymentIntentId", provider,
              provider_transaction_id as "providerTransactionId", provider_event_id as "providerEventId",
              amount_minor as "amountMinor", currency, status, raw_payload as "rawPayload",
              verified_at as "verifiedAt", created_at as "createdAt"
       FROM provider_transactions
       WHERE provider = $1 AND provider_transaction_id = $2`,
      [provider, providerTransactionId]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      ...row,
      amountMinor: BigInt(row.amountMinor)
    };
  }

  /**
   * Atomic Payment Settlement:
   * Single PostgreSQL transaction covering:
   * 1. Payment intent row lock (FOR UPDATE)
   * 2. Provider transaction uniqueness verification (FOR UPDATE)
   * 3. Payment intent status transition to SETTLED
   * 4. Double-entry treasury ledger credit (DR Clearing, CR Customer Escrow Liability)
   * 5. Demand order payment status update (if demandOrderId provided)
   * 6. Audit event insertion
   * COMMIT only when all succeed. ROLLBACK on any failure.
   */
  public async settlePaymentAtomic(params: {
    intentId: string;
    provider: string;
    providerTransactionId: string;
    providerEventId?: string;
    amountMinor: bigint;
    currency: string;
    status: string;
    rawPayload?: Record<string, unknown>;
    demandOrderId?: string;
    customerId: string;
  }): Promise<{ success: boolean; transactionId: string }> {
    const crypto = await import('crypto');

    return this.withTransaction(async (client) => {
      // 1. Lock payment intent
      const intentRes = await client.query(
        `SELECT id, customer_id, provider, amount_minor, currency, status FROM payment_intents WHERE id = $1 FOR UPDATE`,
        [params.intentId]
      );
      if (intentRes.rows.length === 0) {
        throw new Error(`INTENT_NOT_FOUND: Payment intent ${params.intentId} does not exist in PostgreSQL store.`);
      }
      const intent = intentRes.rows[0];
      if (intent.status === 'SETTLED') {
        throw new Error(`INTENT_ALREADY_SETTLED: Payment intent ${params.intentId} has already been settled.`);
      }
      if (intent.status !== 'PENDING') {
        throw new Error(`INVALID_INTENT_STATUS: Payment intent ${params.intentId} status is ${intent.status}, expected PENDING.`);
      }
      if (BigInt(intent.amount_minor) !== params.amountMinor) {
        throw new Error(`AMOUNT_MISMATCH: Intent amount ${intent.amount_minor} does not match verified provider amount ${params.amountMinor}.`);
      }
      if (intent.currency !== params.currency) {
        throw new Error(`CURRENCY_MISMATCH: Intent currency ${intent.currency} does not match verified provider currency ${params.currency}.`);
      }

      // 2. Uniqueness check on provider transaction
      const dupRes = await client.query(
        `SELECT id FROM provider_transactions WHERE provider = $1 AND provider_transaction_id = $2 FOR UPDATE`,
        [params.provider, params.providerTransactionId]
      );
      if (dupRes.rows.length > 0) {
        throw new Error(`DUPLICATE_PROVIDER_TRANSACTION: Provider transaction ${params.providerTransactionId} on ${params.provider} was already processed.`);
      }

      // 3. Insert provider_transactions record
      const ptxId = `ptx-${crypto.randomUUID()}`;
      await client.query(
        `INSERT INTO provider_transactions 
          (id, payment_intent_id, provider, provider_transaction_id, provider_event_id, amount_minor, currency, status, raw_payload, verified_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
        [
          ptxId,
          params.intentId,
          params.provider,
          params.providerTransactionId,
          params.providerEventId || null,
          params.amountMinor.toString(),
          params.currency,
          params.status,
          params.rawPayload ? JSON.stringify(params.rawPayload) : null
        ]
      );

      // 4. Update payment intent status
      await client.query(
        `UPDATE payment_intents SET status = 'SETTLED', settled_at = NOW() WHERE id = $1`,
        [params.intentId]
      );

      // 5. Post Double-Entry Treasury Ledger Credit
      // DR Clearing Account (Asset), CR Customer Escrow Liability (Liability)
      const amountMajor = Number(params.amountMinor) / 100;
      const clearingAccountId = `clearing-${params.provider.toLowerCase()}`;
      const escrowAccountId = `escrow-cust-${params.customerId}`;

      // Ensure clearing and escrow accounts exist and lock them
      await client.query(
        `INSERT INTO treasury_accounts (id, provider, external_account_id, account_type, account_class, asset, currency, environment, status, created_at, updated_at)
         VALUES ($1, $2, $1, 'CLEARING', 'ASSET', $3, $3, 'LIVE', 'ACTIVE', NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET updated_at = NOW()`,
        [clearingAccountId, params.provider, params.currency]
      );

      await client.query(
        `INSERT INTO treasury_accounts (id, provider, external_account_id, account_type, account_class, asset, currency, environment, status, created_at, updated_at)
         VALUES ($1, 'system', $2, 'ESCROW_LIABILITY', 'LIABILITY', $3, $3, 'LIVE', 'ACTIVE', NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET updated_at = NOW()`,
        [escrowAccountId, params.customerId, params.currency]
      );

      // Lock ledger mutex
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('arbitrage_treasury_capital_mutex'))`);

      // Get previous hash
      const lastEntryRes = await client.query(
        `SELECT record_hash FROM treasury_ledger ORDER BY created_at DESC, transaction_id DESC LIMIT 1`
      );
      let prevHash = lastEntryRes.rows[0]?.record_hash || '0'.repeat(64);

      const entryGroupId = `pay-${params.intentId}`;
      const drTxId = `tx-dr-${entryGroupId}`;
      const drHash = crypto.createHash('sha256')
        .update(`${drTxId}|${clearingAccountId}|${params.currency}|${amountMajor}|DEBIT|CUSTOMER_PAYMENT|${prevHash}`)
        .digest('hex');

      await client.query(
        `INSERT INTO treasury_ledger 
          (transaction_id, entry_group_id, account_id, asset, currency, quantity, precision, direction, transaction_type, external_reference, provider, created_at, previous_hash, record_hash)
         VALUES ($1, $2, $3, $4, $4, $5, 2, 'DEBIT', 'CUSTOMER_PAYMENT', $6, $7, NOW(), $8, $9)`,
        [drTxId, entryGroupId, clearingAccountId, params.currency, amountMajor, params.providerTransactionId, params.provider, prevHash, drHash]
      );

      prevHash = drHash;
      const crTxId = `tx-cr-${entryGroupId}`;
      const crHash = crypto.createHash('sha256')
        .update(`${crTxId}|${escrowAccountId}|${params.currency}|${amountMajor}|CREDIT|CUSTOMER_PAYMENT|${prevHash}`)
        .digest('hex');

      await client.query(
        `INSERT INTO treasury_ledger 
          (transaction_id, entry_group_id, account_id, asset, currency, quantity, precision, direction, transaction_type, external_reference, provider, created_at, previous_hash, record_hash)
         VALUES ($1, $2, $3, $4, $4, $5, 2, 'CREDIT', 'CUSTOMER_PAYMENT', $6, $7, NOW(), $8, $9)`,
        [crTxId, entryGroupId, escrowAccountId, params.currency, amountMajor, params.providerTransactionId, params.provider, prevHash, crHash]
      );

      // 6. Update demand order if bound
      if (params.demandOrderId) {
        await client.query(
          `UPDATE demand_orders 
           SET payment_status = 'ESCROW_AUTHORIZED', is_confirmed = true, escrow_reference_id = $1 
           WHERE id = $2`,
          [ptxId, params.demandOrderId]
        );
      }

      // 7. Audit event with cryptographic HMAC-SHA256 hash chain
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('authoritative_audit_chain_lock'))`);
      const lastAuditRes = await client.query(
        `SELECT verified_signature FROM audit_events ORDER BY created_at DESC, id DESC LIMIT 1`
      );
      const prevAuditHash =
        lastAuditRes.rows[0]?.verified_signature ||
        'GENESIS_AUDIT_SIGNATURE_00000000000000000000000000000000';
      const auditId = `audit-${crypto.randomUUID()}`;
      const auditMessage = `Payment intent ${params.intentId} atomically settled via ${params.provider} ($${amountMajor.toFixed(2)} ${params.currency})`;
      const auditSecret = (process.env.AUDIT_CHAIN_SECRET || '').trim();
      if (!auditSecret || auditSecret.length < 16) {
        throw new Error('AUDIT_CHAIN_SECRET_REQUIRED: Audit chain cryptographic signing secret is missing or insufficient length (min 16 chars). Financial mutation blocked.');
      }
      const auditPayload = `${auditId}|PAYMENT_SETTLED_ATOMIC|INFO|${auditMessage}|${prevAuditHash}`;
      const verifiedSignature = crypto.createHmac('sha256', auditSecret).update(auditPayload).digest('hex');

      await client.query(
        `INSERT INTO audit_events (id, event_type, severity, message, details, prev_hash, verified_signature, created_at)
         VALUES ($1, 'PAYMENT_SETTLED_ATOMIC', 'INFO', $2, $3, $4, $5, NOW())`,
        [
          auditId,
          auditMessage,
          JSON.stringify({
            intentId: params.intentId,
            ptxId,
            provider: params.provider,
            providerTransactionId: params.providerTransactionId,
            amountMinor: params.amountMinor.toString(),
            currency: params.currency,
            demandOrderId: params.demandOrderId,
            customerId: params.customerId
          }),
          prevAuditHash,
          verifiedSignature
        ]
      );

      return { success: true, transactionId: ptxId };
    });
  }

  public async recordWebhookEvent(event: {
    provider: string;
    eventId: string;
    orderId?: string | null;
    customerId?: string | null;
    amount: number;
    currency?: string;
    rawPayload?: Record<string, unknown>;
  }): Promise<{ isDuplicate: boolean }> {
    const res = await this.query(
      `INSERT INTO webhook_events (provider, event_id, order_id, customer_id, amount, currency, processed_at, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
       ON CONFLICT (provider, event_id) DO NOTHING
       RETURNING provider, event_id`,
      [
        event.provider,
        event.eventId,
        event.orderId || null,
        event.customerId || null,
        event.amount,
        event.currency || 'USD',
        event.rawPayload ? JSON.stringify(event.rawPayload) : null
      ]
    );
    return { isDuplicate: res.rowCount === 0 };
  }

  public async hasProcessedEvent(provider: string, eventId: string): Promise<boolean> {
    const res = await this.query(
      `SELECT 1 FROM webhook_events WHERE provider = $1 AND event_id = $2`,
      [provider, eventId]
    );
    return (res.rowCount || 0) > 0;
  }
}

export class EscrowRepository extends BasePostgresRepository {
  /**
   * Derive customer escrow balance purely from ledger entries:
   * Sum of all credits to ESCROW_LIABILITY for this customer minus debits from settlements/refunds.
   * Never trust mutable customer.escrowBalance!
   */
  public async getCustomerEscrowBalance(customerId: string): Promise<number> {
    const res = await this.query(
      `SELECT COALESCE(
         SUM(CASE WHEN l.direction = 'CREDIT' THEN l.quantity ELSE -l.quantity END), 
         0.00
       )::float as "balance"
       FROM treasury_ledger l
       JOIN treasury_accounts a ON l.account_id = a.id
       WHERE a.account_type = 'ESCROW_LIABILITY'
         AND a.external_account_id = $1`,
      [customerId]
    );
    return Math.max(0, Number(res.rows[0]?.balance) || 0);
  }

  /**
   * Lock and verify customer escrow balance within an existing transaction
   */
  public async lockAndVerifyCustomerEscrow(client: any, customerId: string, requiredAmount: number): Promise<number> {
    const res = await client.query(
      `SELECT COALESCE(
         SUM(CASE WHEN l.direction = 'CREDIT' THEN l.quantity ELSE -l.quantity END), 
         0.00
       )::float as "balance"
       FROM treasury_ledger l
       JOIN treasury_accounts a ON l.account_id = a.id
       WHERE a.account_type = 'ESCROW_LIABILITY'
         AND a.external_account_id = $1
       FOR UPDATE`,
      [customerId]
    );
    const balance = Math.max(0, Number(res.rows[0]?.balance) || 0);
    if (balance < requiredAmount) {
      throw new Error(`INSUFFICIENT_CUSTOMER_ESCROW: Available escrow balance $${balance.toFixed(2)} is less than required $${requiredAmount.toFixed(2)}.`);
    }
    return balance;
  }
}
