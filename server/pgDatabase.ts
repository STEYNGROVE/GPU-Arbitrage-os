import pg from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const { Pool } = pg;

export interface PgDatabaseConfig {
  connectionString?: string;
  maxConnections?: number;
}

/**
 * Authoritative PostgreSQL Database Service
 *
 * PRODUCTION SCHEMA IMMUTABILITY INVARIANT:
 * This runtime service NEVER executes DDL schema mutation statements
 * at startup or during normal operation.
 * All schema definitions and changes live strictly in versioned PostgreSQL
 * migration files under `supabase/migrations/` and are applied offline via
 * `npm run db:migrate`. At startup, `verifySchemaReadiness()` performs a
 * read-only verification against `information_schema.tables` and fails closed
 * if any required authoritative financial table is missing.
 */
export class PostgresDatabaseService {
  private pool: pg.Pool | null = null;
  private isConnected: boolean = false;
  private connectionError: string | null = null;
  private isInitialized: boolean = false;

  constructor() {
    this.configurePool();
  }

  private configurePool(overrideUrl?: string) {
    const rawConnStr = (
      overrideUrl ||
      process.env.DATABASE_URL ||
      process.env.DIRECT_URL ||
      process.env.SUPABASE_DB_URL ||
      process.env.POSTGRES_URL ||
      ''
    ).trim();

    if (rawConnStr && (rawConnStr.startsWith('postgres://') || rawConnStr.startsWith('postgresql://'))) {
      try {
        const isCloudTlsHost =
          rawConnStr.includes('.supabase.co') ||
          rawConnStr.includes('.supabase.com') ||
          rawConnStr.includes('.neon.tech') ||
          rawConnStr.includes('sslmode=');

        // Normalize sslmode=require to include uselibpqcompat=true so pg-connection-string v2/v3 does not emit deprecation warnings
        let normalizedConnStr = rawConnStr;
        if (
          normalizedConnStr.includes('sslmode=require') &&
          !normalizedConnStr.includes('uselibpqcompat=')
        ) {
          normalizedConnStr = normalizedConnStr.replace('sslmode=require', 'uselibpqcompat=true&sslmode=require');
        }

        // Strict TLS configuration: verify certificates unless explicitly overridden
        const sslConfig = process.env.DATABASE_SSL_CA
          ? { ca: fs.readFileSync(process.env.DATABASE_SSL_CA).toString(), rejectUnauthorized: true }
          : process.env.DATABASE_SSL === 'true' || isCloudTlsHost
          ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
          : undefined;

        this.pool = new Pool({
          connectionString: normalizedConnStr,
          max: 15,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 8000,
          ssl: sslConfig
        });

        this.pool.on('error', (err) => {
          console.error('[POSTGRES POOL ERROR]', err.message);
          this.isConnected = false;
          this.connectionError = err.message;
        });
      } catch (err: any) {
        console.warn('[POSTGRES INIT ERROR]', err.message);
        this.connectionError = err.message;
      }
    }
  }

  public async initialize(options?: { skipSchemaCheck?: boolean }): Promise<{ success: boolean; mode: 'REMOTE_POSTGRES' | 'POSTGRES_DISCONNECTED'; error?: string }> {
    if (!this.pool) {
      this.configurePool();
    }
    if (this.pool) {
      try {
        const client = await this.pool.connect();
        try {
          await client.query('SELECT 1 as health');
          this.isConnected = true;
          this.connectionError = null;

          // Read-only schema readiness verification (zero runtime DDL mutation)
          if (!options?.skipSchemaCheck) {
            await this.verifySchemaReadiness(client);
          }
          this.isInitialized = true;
          return { success: true, mode: 'REMOTE_POSTGRES' };
        } finally {
          client.release();
        }
      } catch (err: any) {
        console.warn('[POSTGRES CONNECTION FAILED] Primary database connection error:', err.message);
        // Attempt failover to DIRECT_URL if distinct from DATABASE_URL
        const directUrl = process.env.DIRECT_URL?.trim();
        const primaryUrl = process.env.DATABASE_URL?.trim();
        if (directUrl && directUrl !== primaryUrl && (directUrl.startsWith('postgres://') || directUrl.startsWith('postgresql://'))) {
          try {
            this.configurePool(directUrl);
            if (this.pool) {
              const fallbackClient = await this.pool.connect();
              try {
                await fallbackClient.query('SELECT 1 as health');
                this.isConnected = true;
                this.connectionError = null;
                if (!options?.skipSchemaCheck) {
                  await this.verifySchemaReadiness(fallbackClient);
                }
                this.isInitialized = true;
                return { success: true, mode: 'REMOTE_POSTGRES' };
              } finally {
                fallbackClient.release();
              }
            }
          } catch (fallbackErr: any) {
            console.warn('[POSTGRES DIRECT_URL FAILOVER FAILED]:', fallbackErr.message);
          }
        }
        this.isConnected = false;
        this.connectionError = err.message;
      }
    }

    this.isInitialized = true;
    this.isConnected = false;
    return {
      success: false,
      mode: 'POSTGRES_DISCONNECTED',
      error: this.connectionError || 'DATABASE_URL is not configured or unreachable. LIVE operations are strictly BLOCKED.'
    };
  }

  /**
   * Read-only schema readiness check.
   * Strictly verifies that all authoritative financial tables exist in PostgreSQL
   * without mutating the database schema at startup or during normal operation.
   */
  public async verifySchemaReadiness(client: pg.PoolClient): Promise<void> {
    const requiredTables = [
      'schema_migrations',
      'customers',
      'customer_api_keys',
      'customer_sessions',
      'demand_orders',
      'webhook_events',
      'treasury_accounts',
      'treasury_ledger',
      'treasury_transactions',
      'treasury_snapshots',
      'treasury_reconciliations',
      'quotes',
      'capital_reservations',
      'provider_operations',
      'provider_instances',
      'compute_jobs',
      'settlements',
      'outbox_events',
      'audit_events',
      'idempotency_keys',
      'reconciliation_runs',
      'kill_switch_state',
      'payment_intents',
      'provider_transactions',
      'worker_heartbeats',
      'circuit_breaker_state',
      'profit_withdrawals_audit',
      'verified_profit_records',
      'withdrawal_allowlist',
      'provider_funding_events',
      'autonomous_profit_allocations',
      'hot_wallet_transactions',
      'hot_wallet_idempotency',
      'hot_wallet_nonce_state',
      'hot_wallet_emergency_state',
      'market_opportunities'
    ];

    const tableCheckRes = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [requiredTables]
    );
    const existingTableNames = new Set(tableCheckRes.rows.map((r: any) => r.table_name));
    for (const reqTable of requiredTables) {
      if (!existingTableNames.has(reqTable)) {
        throw new Error(
          `CRITICAL_SCHEMA_ERROR: Required authoritative table '${reqTable}' is missing. Run 'npm run db:migrate' to apply versioned PostgreSQL migrations before starting LIVE operations.`
        );
      }
    }

    await this.verifyMigrationChecksums(client);
  }

  /**
   * Read-only Migration Checksum Integrity Verification.
   * Ensures every versioned SQL migration in `supabase/migrations/` is recorded in
   * `schema_migrations` and that `stored checksum === current file checksum`.
   * Throws `MIGRATION_INTEGRITY_FAILURE` if any applied migration file was modified.
   */
  public async verifyMigrationChecksums(
    clientOverride?: pg.PoolClient,
    migrationsDirOverride?: string
  ): Promise<{ verified: boolean; count: number; versions: string[] }> {
    const migrationsDir = migrationsDirOverride || path.join(process.cwd(), 'supabase', 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      throw new Error('MIGRATION_INTEGRITY_FAILURE: supabase/migrations directory is missing.');
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    const queryFn = clientOverride
      ? (sql: string, params: any[] = []) => clientOverride.query(sql, params)
      : (sql: string, params: any[] = []) => this.query(sql, params);

    const existingRes = await queryFn('SELECT version, checksum FROM schema_migrations');
    const storedMap = new Map<string, string>();
    for (const row of existingRes.rows) {
      storedMap.set(String(row.version).trim(), String(row.checksum).trim());
    }

    const verifiedVersions: string[] = [];
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      const currentChecksum = crypto.createHash('sha256').update(sql.trim()).digest('hex');

      const storedChecksum = storedMap.get(version);
      if (!storedChecksum) {
        throw new Error(
          `MIGRATION_INTEGRITY_FAILURE: Versioned migration '${version}' has not been applied to PostgreSQL. Run 'npm run db:migrate' before starting LIVE operations.`
        );
      }
      if (storedChecksum !== currentChecksum) {
        throw new Error(
          `MIGRATION_INTEGRITY_FAILURE: Applied financial migration '${version}' checksum mismatch! Stored checksum (${storedChecksum}) !== current file checksum (${currentChecksum}). Startup/deployment refused.`
        );
      }
      verifiedVersions.push(version);
    }

    return {
      verified: true,
      count: verifiedVersions.length,
      versions: verifiedVersions
    };
  }

  public getStatus(): { isConnected: boolean; error: string | null; mode: string; liveExecutionAllowed: boolean } {
    return {
      isConnected: this.isConnected,
      error: this.connectionError,
      mode: this.isConnected ? 'POSTGRESQL_LIVE' : 'POSTGRES_DISCONNECTED',
      liveExecutionAllowed: this.isConnected
    };
  }

  public isLiveDatabaseConnected(): boolean {
    return this.isConnected && this.pool !== null;
  }

  /**
   * Fail-Closed Outage Test Probe:
   * Temporarily switches database connectivity flag to simulate an authoritative database drop,
   * proves that assertLiveModeAllowed() strictly rejects execution with fail-closed reason,
   * then safely restores previous connection state.
   */
  public simulateOutageVerification(): { failClosedEnforced: boolean; reason: string } {
    const originalConnected = this.isConnected;
    try {
      this.isConnected = false;
      const check = this.assertLiveModeAllowed();
      const failClosedEnforced = check.allowed === false && typeof check.reason === 'string' && check.reason.includes('LIVE MODE BLOCKED');
      return {
        failClosedEnforced,
        reason: check.reason || ''
      };
    } finally {
      this.isConnected = originalConnected;
    }
  }

  /**
   * Production Safety Requirement:
   * If PostgreSQL is unavailable, LIVE financial execution is strictly disabled.
   */
  public assertLiveModeAllowed(): { allowed: boolean; reason?: string } {
    if (!this.isConnected || !this.pool) {
      return {
        allowed: false,
        reason: 'LIVE MODE BLOCKED: Authoritative PostgreSQL database is not connected. All live financial operations are strictly disabled.'
      };
    }
    return { allowed: true };
  }

  /**
   * Advisory lock on treasury for concurrency serialization
   */
  public async acquireTreasuryLock(client: pg.PoolClient): Promise<void> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('arbitrage_treasury_capital_mutex'))`);
  }

  public async query(sql: string, params: any[] = []): Promise<pg.QueryResult<any>> {
    if (!this.pool || !this.isConnected) {
      throw new Error('DATABASE_UNAVAILABLE: PostgreSQL is not connected. Live financial query refused.');
    }
    return this.pool.query(sql, params);
  }

  public async getClient(): Promise<pg.PoolClient> {
    if (!this.pool || !this.isConnected) {
      throw new Error('DATABASE_UNAVAILABLE: Cannot acquire transaction client. PostgreSQL is offline.');
    }
    return this.pool.connect();
  }

  public async recordTreasuryDeposit(deposit: {
    transactionId: string;
    provider: string;
    amount: number;
    currency: string;
    settlementStatus: string;
    treasuryReference?: string;
    accountDestination?: string;
    rawPayload: any;
  }): Promise<void> {
    if (!this.pool || !this.isConnected) return;
    await this.query(
      `INSERT INTO webhook_events (provider, event_id, amount, currency, processed_at, raw_payload)
       VALUES ($1, $2, $3, $4, NOW(), $5)
       ON CONFLICT (provider, event_id) DO NOTHING`,
      [deposit.provider, deposit.transactionId, deposit.amount, deposit.currency, JSON.stringify(deposit.rawPayload)]
    );
  }
}

export const pgDbService = new PostgresDatabaseService();
