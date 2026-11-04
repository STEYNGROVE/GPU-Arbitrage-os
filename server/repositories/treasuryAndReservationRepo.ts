import crypto from 'crypto';
import type pg from 'pg';
import { BasePostgresRepository } from './baseRepo.js';
import { TreasuryAccount, TreasuryLedgerEntry, CapitalReservation } from './types.js';
import { toMinorUnits, fromMinorUnits } from '../moneyUtils.js';

export class TreasuryRepository extends BasePostgresRepository {
  /**
   * Get or create a specific treasury account
   */
  public async getOrCreateAccount(account: {
    id: string;
    provider: 'binance' | 'bank' | 'system';
    externalAccountId: string;
    accountType: 'CLEARING' | 'ESCROW_LIABILITY' | 'TREASURY_CASH' | 'COMPUTE_EXPENSE' | 'REVENUE';
    asset: string;
    currency: string;
    environment?: 'LIVE' | 'PAPER';
  }): Promise<TreasuryAccount> {
    const env = account.environment || 'LIVE';
    const res = await this.query(
      `INSERT INTO treasury_accounts (id, provider, external_account_id, account_type, asset, currency, environment, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', NOW(), NOW())
       ON CONFLICT (provider, external_account_id, asset, environment)
       DO UPDATE SET updated_at = NOW()
       RETURNING id, provider, external_account_id as "externalAccountId", account_type as "accountType",
                 asset, currency, environment, status, created_at as "createdAt", updated_at as "updatedAt"`,
      [account.id, account.provider, account.externalAccountId, account.accountType, account.asset, account.currency, env]
    );
    return res.rows[0];
  }

  public async findAccount(provider: string, externalAccountId: string, asset: string, environment: string = 'LIVE'): Promise<TreasuryAccount | null> {
    const res = await this.query(
      `SELECT id, provider, external_account_id as "externalAccountId", account_type as "accountType",
              asset, currency, environment, status, created_at as "createdAt", updated_at as "updatedAt"
       FROM treasury_accounts
       WHERE provider = $1 AND external_account_id = $2 AND asset = $3 AND environment = $4`,
      [provider, externalAccountId, asset, environment]
    );
    return res.rows[0] || null;
  }

  /**
   * Strictly Authoritative Account Lookup for LIVE Execution:
   * Only returns an existing, ACTIVE, VERIFIED account.
   * Rejects simulated or placeholder accounts (e.g. 'live-balance-*').
   */
  public async findVerifiedAccount(provider: string, asset: string, environment: 'LIVE' | 'PAPER' = 'LIVE'): Promise<TreasuryAccount | null> {
    const res = await this.query(
      `SELECT id, provider, external_account_id as "externalAccountId", account_type as "accountType",
              asset, currency, environment, status, created_at as "createdAt", updated_at as "updatedAt"
       FROM treasury_accounts
       WHERE provider = $1 AND asset = $2 AND environment = $3 AND status = 'ACTIVE'
         AND account_type = 'TREASURY_CASH'
         AND external_account_id NOT LIKE 'live-balance-%'
       ORDER BY created_at ASC
       LIMIT 1`,
      [provider, asset, environment]
    );
    return res.rows[0] || null;
  }

  /**
   * Calculate Spendable Capital:
   * Spendable capital = ledger balance - locked reservations - risk reserve.
   * Cryptographic assets (BTC/ETH/USDT) must never be commingled with fiat (USD/ZAR).
   */
  public async getSpendableCapital(accountId: string, asset: string): Promise<number> {
    const balRes = await this.query(
      `SELECT COALESCE(
         SUM(CASE WHEN direction = 'DEBIT' THEN quantity ELSE -quantity END), 0
       )::float as "balance"
       FROM treasury_ledger WHERE account_id = $1 AND asset = $2`,
      [accountId, asset]
    );
    const ledgerBalance = Number(balRes.rows[0]?.balance) || 0;

    const resRes = await this.query(
      `SELECT COALESCE(SUM(amount), 0)::float as "reserved"
       FROM capital_reservations
       WHERE account_id = $1 AND asset = $2 AND status = 'RESERVED' AND expires_at > NOW()`,
      [accountId, asset]
    );
    const reserved = Number(resRes.rows[0]?.reserved) || 0;

    // Minimum risk reserve requirement (5% buffer) calculated in integer minor units
    const ledgerBalanceMinor = toMinorUnits(ledgerBalance);
    const reservedMinor = toMinorUnits(reserved);
    const riskReserveMinor = (ledgerBalanceMinor * 5n) / 100n;
    const spendableMinor = ledgerBalanceMinor > (reservedMinor + riskReserveMinor)
      ? ledgerBalanceMinor - reservedMinor - riskReserveMinor
      : 0n;
    return fromMinorUnits(spendableMinor);
  }

  /**
   * Calculate balance for an account derived strictly from double-entry ledger
   */
  public async getAccountBalance(accountId: string): Promise<number> {
    const res = await this.query(
      `SELECT COALESCE(
         SUM(CASE WHEN direction = 'DEBIT' THEN quantity ELSE -quantity END),
         0
       )::float as "balance"
       FROM treasury_ledger
       WHERE account_id = $1`,
      [accountId]
    );
    return Number(res.rows[0]?.balance) || 0;
  }

  /**
   * Get latest ledger entry record_hash for cryptographic chaining
   */
  public async getLatestRecordHash(client?: pg.PoolClient): Promise<string> {
    const sql = `SELECT record_hash FROM treasury_ledger ORDER BY created_at DESC, transaction_id DESC LIMIT 1`;
    const res = client ? await client.query(sql) : await this.query(sql);
    if (res.rows.length === 0 || !res.rows[0].record_hash) {
      return 'GENESIS_POSTGRESQL_TREASURY_LEDGER_HASH_0000000000000000';
    }
    return res.rows[0].record_hash;
  }

  /**
   * Atomic Double-Entry Posting:
   * Every financial movement requires both a DEBIT and a CREDIT entry in the same transaction!
   */
  public async recordDoubleEntryTransaction(params: {
    entryGroupId: string;
    debit: {
      accountId: string;
      asset: string;
      currency: string;
      quantity: number;
      precision: number;
      transactionType: 'CUSTOMER_PAYMENT' | 'ESCROW_LOCK' | 'COMPUTE_PURCHASE' | 'SETTLEMENT' | 'REFUND' | 'CORRECTION';
      externalReference: string;
      provider: string;
      operationId?: string | null;
    };
    credit: {
      accountId: string;
      asset: string;
      currency: string;
      quantity: number;
      precision: number;
      transactionType: 'CUSTOMER_PAYMENT' | 'ESCROW_LOCK' | 'COMPUTE_PURCHASE' | 'SETTLEMENT' | 'REFUND' | 'CORRECTION';
      externalReference: string;
      provider: string;
      operationId?: string | null;
    };
  }): Promise<{ debitEntry: TreasuryLedgerEntry; creditEntry: TreasuryLedgerEntry }> {
    // 0. Double-entry mathematical balance enforcement
    if (params.debit.quantity <= 0 || params.credit.quantity <= 0) {
      throw new Error('INVALID_QUANTITY: Double-entry transactions require positive quantities.');
    }
    if (Math.abs(params.debit.quantity - params.credit.quantity) > 0.00000001) {
      throw new Error(`UNBALANCED_DOUBLE_ENTRY: Debit quantity (${params.debit.quantity}) does not match credit quantity (${params.credit.quantity}).`);
    }
    if (params.debit.asset !== params.credit.asset || params.debit.currency !== params.credit.currency) {
      throw new Error(`ASSET_MISMATCH: Debit asset/currency (${params.debit.asset}/${params.debit.currency}) does not match credit (${params.credit.asset}/${params.credit.currency}).`);
    }

    return this.withTransaction(async (client) => {
      // 1. Acquire advisory xact lock to prevent ledger race conditions
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('authoritative_treasury_ledger_lock'))`);

      let prevHash = await this.getLatestRecordHash(client);

      // 2. Post DEBIT entry
      const debitTxId = `tx-dr-${params.entryGroupId}-${crypto.randomUUID()}`;
      const debitHashPayload = `${debitTxId}|${params.debit.accountId}|${params.debit.asset}|${params.debit.quantity}|DEBIT|${params.debit.transactionType}|${prevHash}`;
      const debitRecordHash = crypto.createHash('sha256').update(debitHashPayload).digest('hex');

      const debitRes = await client.query(
        `INSERT INTO treasury_ledger 
          (transaction_id, entry_group_id, account_id, asset, currency, quantity, precision,
           direction, transaction_type, external_reference, provider, operation_id, created_at, previous_hash, record_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'DEBIT', $8, $9, $10, $11, NOW(), $12, $13)
         RETURNING transaction_id as "transactionId", entry_group_id as "entryGroupId", account_id as "accountId",
                   asset, currency, quantity::float as quantity, precision, direction, transaction_type as "transactionType",
                   external_reference as "externalReference", provider, operation_id as "operationId", created_at as "createdAt",
                   previous_hash as "previousHash", record_hash as "recordHash"`,
        [
          debitTxId,
          params.entryGroupId,
          params.debit.accountId,
          params.debit.asset,
          params.debit.currency,
          params.debit.quantity,
          params.debit.precision,
          params.debit.transactionType,
          params.debit.externalReference,
          params.debit.provider,
          params.debit.operationId || null,
          prevHash,
          debitRecordHash
        ]
      );

      // Chain from debit entry to credit entry
      prevHash = debitRecordHash;

      // 3. Post CREDIT entry
      const creditTxId = `tx-cr-${params.entryGroupId}-${crypto.randomUUID()}`;
      const creditHashPayload = `${creditTxId}|${params.credit.accountId}|${params.credit.asset}|${params.credit.quantity}|CREDIT|${params.credit.transactionType}|${prevHash}`;
      const creditRecordHash = crypto.createHash('sha256').update(creditHashPayload).digest('hex');

      const creditRes = await client.query(
        `INSERT INTO treasury_ledger 
          (transaction_id, entry_group_id, account_id, asset, currency, quantity, precision,
           direction, transaction_type, external_reference, provider, operation_id, created_at, previous_hash, record_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'CREDIT', $8, $9, $10, $11, NOW(), $12, $13)
         RETURNING transaction_id as "transactionId", entry_group_id as "entryGroupId", account_id as "accountId",
                   asset, currency, quantity::float as quantity, precision, direction, transaction_type as "transactionType",
                   external_reference as "externalReference", provider, operation_id as "operationId", created_at as "createdAt",
                   previous_hash as "previousHash", record_hash as "recordHash"`,
        [
          creditTxId,
          params.entryGroupId,
          params.credit.accountId,
          params.credit.asset,
          params.credit.currency,
          params.credit.quantity,
          params.credit.precision,
          params.credit.transactionType,
          params.credit.externalReference,
          params.credit.provider,
          params.credit.operationId || null,
          prevHash,
          creditRecordHash
        ]
      );

      return {
        debitEntry: debitRes.rows[0],
        creditEntry: creditRes.rows[0]
      };
    });
  }

  public async listLedgerEntries(limit: number = 100): Promise<TreasuryLedgerEntry[]> {
    const res = await this.query(
      `SELECT transaction_id as "transactionId", entry_group_id as "entryGroupId", account_id as "accountId",
              asset, currency, quantity::float as quantity, precision, direction, transaction_type as "transactionType",
              external_reference as "externalReference", provider, operation_id as "operationId", created_at as "createdAt",
              previous_hash as "previousHash", record_hash as "recordHash"
       FROM treasury_ledger
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return res.rows;
  }
}

export class ReservationRepository extends BasePostgresRepository {
  /**
   * Create an atomic capital reservation with PostgreSQL concurrency serialization
   */
  public async createReservationAtomic(reservation: {
    reservationId: string;
    demandOrderId: string;
    quoteId: string;
    accountId: string;
    asset: string;
    currency: string;
    amount: number;
    durationMinutes?: number;
  }): Promise<CapitalReservation> {
    return this.withTransaction(async (client) => {
      // Advisory xact lock on the treasury account to prevent race condition over-reservation
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('reservation_account_mutex_' || $1))`, [reservation.accountId]);

      // 1. Expire any overdue reservations first
      await client.query(
        `UPDATE capital_reservations
         SET status = 'EXPIRED', updated_at = NOW()
         WHERE status = 'RESERVED' AND expires_at < NOW()`
      );

      // 2. Check total ledger balance of account
      const balRes = await client.query(
        `SELECT COALESCE(
           SUM(CASE WHEN direction = 'DEBIT' THEN quantity ELSE -quantity END), 0
         )::float as "balance"
         FROM treasury_ledger WHERE account_id = $1`,
        [reservation.accountId]
      );
      const totalBalance = Number(balRes.rows[0]?.balance) || 0;

      // 3. Check currently active reservations
      const activeRes = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::float as "reserved"
         FROM capital_reservations
         WHERE account_id = $1 AND status = 'RESERVED' AND expires_at > NOW()`,
        [reservation.accountId]
      );
      const activeReserved = Number(activeRes.rows[0]?.reserved) || 0;

      const totalBalanceMinor = toMinorUnits(totalBalance);
      const activeReservedMinor = toMinorUnits(activeReserved);
      const requestedMinor = toMinorUnits(reservation.amount);
      const availableSpendableMinor = totalBalanceMinor - activeReservedMinor;
      if (availableSpendableMinor < requestedMinor) {
        const availableSpendable = fromMinorUnits(availableSpendableMinor > 0n ? availableSpendableMinor : 0n);
        throw new Error(`INSUFFICIENT_SPENDABLE_CAPITAL: Account available $${availableSpendable.toFixed(2)}, required $${reservation.amount.toFixed(2)}.`);
      }

      // 4. Create reservation (parameterized interval)
      const ttlMinutes = Math.max(1, Math.floor(Number(reservation.durationMinutes) || 10));
      const res = await client.query(
        `INSERT INTO capital_reservations 
          (reservation_id, demand_order_id, quote_id, account_id, asset, currency, amount, status, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'RESERVED', NOW() + ($8::int * interval '1 minute'), NOW(), NOW())
         RETURNING reservation_id as "reservationId", demand_order_id as "demandOrderId", quote_id as "quoteId",
                   account_id as "accountId", asset, currency, amount::float as amount, status,
                   expires_at as "expiresAt", created_at as "createdAt", updated_at as "updatedAt"`,
        [
          reservation.reservationId,
          reservation.demandOrderId,
          reservation.quoteId,
          reservation.accountId,
          reservation.asset,
          reservation.currency,
          reservation.amount,
          ttlMinutes
        ]
      );
      return res.rows[0];
    });
  }

  public async consumeReservation(reservationId: string): Promise<void> {
    await this.query(
      `UPDATE capital_reservations
       SET status = 'CONSUMED', updated_at = NOW()
       WHERE reservation_id = $1 AND status = 'RESERVED'`,
      [reservationId]
    );
  }

  public async releaseReservation(reservationId: string): Promise<void> {
    await this.query(
      `UPDATE capital_reservations
       SET status = 'RELEASED', updated_at = NOW()
       WHERE reservation_id = $1 AND status = 'RESERVED'`,
      [reservationId]
    );
  }

  public async getActiveReservationCount(accountId: string): Promise<number> {
    const res = await this.query(
      `SELECT COUNT(*)::int as "count" FROM capital_reservations 
       WHERE account_id = $1 AND status = 'RESERVED' AND expires_at > NOW()`,
      [accountId]
    );
    return res.rows[0]?.count || 0;
  }
}
