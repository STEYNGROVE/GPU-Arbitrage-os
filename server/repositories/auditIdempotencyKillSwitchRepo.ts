import crypto from 'crypto';
import type pg from 'pg';
import { pgDbService } from '../pgDatabase.js';
import { BasePostgresRepository } from './baseRepo.js';
import { AuditEvent, KillSwitchState, ReconciliationRun } from './types.js';

export class IdempotencyRepository extends BasePostgresRepository {
  public async get(key: string, endpoint?: string): Promise<{ statusCode: number; response: any } | null> {
    const res = endpoint
      ? await this.query(
          `SELECT status_code as "statusCode", response
           FROM idempotency_keys
           WHERE key = $1 AND endpoint = $2`,
          [key, endpoint]
        )
      : await this.query(
          `SELECT status_code as "statusCode", response
           FROM idempotency_keys
           WHERE key = $1`,
          [key]
        );
    return res.rows[0] || null;
  }

  public async set(key: string, endpoint: string, statusCode: number, response: any): Promise<void> {
    await this.query(
      `INSERT INTO idempotency_keys (key, endpoint, status_code, response, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (key) DO NOTHING`,
      [key, endpoint, statusCode, JSON.stringify(response)]
    );
  }

  public async checkIdempotency(key: string, endpoint?: string): Promise<{ statusCode: number; response: any } | null> {
    return this.get(key, endpoint);
  }

  public async saveIdempotency(key: string, endpoint: string, statusCode: number, response: any): Promise<void> {
    return this.set(key, endpoint, statusCode, response);
  }

  public async recordIdempotency(key: string, endpoint: string, statusCode: number, response: any): Promise<void> {
    return this.set(key, endpoint, statusCode, response);
  }
}

export class AuditRepository extends BasePostgresRepository {
  private getAuditSecret(): string {
    const secret = process.env.AUDIT_CHAIN_SECRET;
    if (!secret) {
      throw new Error('CONFIG_ERROR: AUDIT_CHAIN_SECRET is strictly required for cryptographic audit trail.');
    }
    return secret;
  }

  public async getLatestHash(client?: pg.PoolClient): Promise<string> {
    const sql = `SELECT verified_signature FROM audit_events ORDER BY created_at DESC, id DESC LIMIT 1`;
    const res = client ? await client.query(sql) : await this.query(sql);
    if (res.rows.length === 0 || !res.rows[0].verified_signature) {
      return 'GENESIS_AUDIT_SIGNATURE_00000000000000000000000000000000';
    }
    return res.rows[0].verified_signature;
  }

  public async recordEvent(event: {
    eventType: string;
    severity: 'INFO' | 'WARNING' | 'CRITICAL' | 'SECURITY';
    message: string;
    details?: Record<string, unknown>;
  }): Promise<AuditEvent> {
    return this.withTransaction(async (client) => {
      // Serialize audit event writes to maintain strict hash chain
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('authoritative_audit_chain_lock'))`);

      const prevHash = await this.getLatestHash(client);
      const id = `audit-${crypto.randomUUID()}`;
      const payloadToSign = `${id}|${event.eventType}|${event.severity}|${event.message}|${prevHash}`;
      const signature = crypto.createHmac('sha256', this.getAuditSecret()).update(payloadToSign).digest('hex');

      const res = await client.query(
        `INSERT INTO audit_events (id, event_type, severity, message, details, prev_hash, verified_signature, created_at)
         VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           GREATEST(clock_timestamp(), COALESCE((SELECT MAX(created_at) + interval '1 microsecond' FROM audit_events), clock_timestamp()))
         )
         RETURNING id, event_type as "eventType", severity, message, details, prev_hash as "prevHash",
                   verified_signature as "verifiedSignature", created_at as "createdAt"`,
        [
          id,
          event.eventType,
          event.severity,
          event.message,
          event.details ? JSON.stringify(event.details) : null,
          prevHash,
          signature
        ]
      );
      return res.rows[0];
    });
  }

  public async verifyChainIntegrity(limit: number = 5000): Promise<{ valid: boolean; inspectedCount: number; brokenAt?: string }> {
    const res = await this.query(
      `SELECT id, event_type as "eventType", severity, message, prev_hash as "prevHash",
              verified_signature as "verifiedSignature", created_at as "createdAt"
       FROM audit_events
       ORDER BY created_at ASC, id ASC
       LIMIT $1`,
      [limit]
    );

    if (res.rows.length === 0) {
      return { valid: true, inspectedCount: 0 };
    }

    let expectedPrevHash = 'GENESIS_AUDIT_SIGNATURE_00000000000000000000000000000000';
    for (const row of res.rows) {
      if (row.prevHash !== expectedPrevHash) {
        return { valid: false, inspectedCount: res.rows.length, brokenAt: row.id };
      }
      const payloadToSign = `${row.id}|${row.eventType}|${row.severity}|${row.message}|${row.prevHash}`;
      const expectedSig = crypto.createHmac('sha256', this.getAuditSecret()).update(payloadToSign).digest('hex');
      if (row.verifiedSignature !== expectedSig) {
        return { valid: false, inspectedCount: res.rows.length, brokenAt: row.id };
      }
      expectedPrevHash = row.verifiedSignature;
    }

    return { valid: true, inspectedCount: res.rows.length };
  }

  public async getChainSummary(limit: number = 5000): Promise<{
    valid: boolean;
    totalBlocks: number;
    inspectedCount: number;
    latestHash: string;
    genesisHash: string;
    merkleRoot: string;
    brokenAt?: string;
  }> {
    const genesisHash = 'GENESIS_AUDIT_SIGNATURE_00000000000000000000000000000000';
    const res = await this.query(
      `SELECT id, event_type as "eventType", severity, message, prev_hash as "prevHash",
              verified_signature as "verifiedSignature", created_at as "createdAt"
       FROM audit_events
       ORDER BY created_at ASC, id ASC
       LIMIT $1`,
      [limit]
    );

    if (res.rows.length === 0) {
      return {
        valid: true,
        totalBlocks: 0,
        inspectedCount: 0,
        latestHash: genesisHash,
        genesisHash,
        merkleRoot: crypto.createHash('sha256').update(genesisHash).digest('hex')
      };
    }

    let expectedPrevHash = genesisHash;
    let valid = true;
    let brokenAt: string | undefined;
    const signatures: string[] = [];

    for (const row of res.rows) {
      signatures.push(row.verifiedSignature);
      if (valid) {
        if (row.prevHash !== expectedPrevHash) {
          valid = false;
          brokenAt = row.id;
        } else {
          const payloadToSign = `${row.id}|${row.eventType}|${row.severity}|${row.message}|${row.prevHash}`;
          const expectedSig = crypto.createHmac('sha256', this.getAuditSecret()).update(payloadToSign).digest('hex');
          if (row.verifiedSignature !== expectedSig) {
            valid = false;
            brokenAt = row.id;
          }
        }
      }
      expectedPrevHash = row.verifiedSignature;
    }

    const latestHash = res.rows[res.rows.length - 1].verifiedSignature || genesisHash;
    const merkleRoot = crypto.createHash('sha256').update(signatures.join('|')).digest('hex');

    return {
      valid,
      totalBlocks: res.rows.length,
      inspectedCount: res.rows.length,
      latestHash,
      genesisHash,
      merkleRoot,
      brokenAt
    };
  }

  public async getRecentEvents(limit: number = 100): Promise<AuditEvent[]> {
    const res = await this.query(
      `SELECT id, event_type as "eventType", severity, message, details, prev_hash as "prevHash",
              verified_signature as "verifiedSignature", created_at as "createdAt"
       FROM audit_events ORDER BY created_at DESC, id DESC LIMIT $1`,
      [limit]
    );
    return res.rows;
  }
}

export class ReconciliationRepository extends BasePostgresRepository {
  public async recordRun(run: {
    provider: string;
    asset: string;
    externalBalance: number;
    internalBalance: number;
    discrepancy: number;
    status: 'RECONCILED' | 'MISMATCH' | 'ERROR';
    reason?: string | null;
  }): Promise<ReconciliationRun> {
    const id = `rec-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const res = await this.query(
      `INSERT INTO reconciliation_runs (id, provider, asset, external_balance, internal_balance, discrepancy, status, reason, reconciled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       RETURNING id, provider, asset, external_balance::float as "externalBalance",
                 internal_balance::float as "internalBalance", discrepancy::float as discrepancy,
                 status, reason, reconciled_at as "reconciledAt"`,
      [id, run.provider, run.asset, run.externalBalance, run.internalBalance, run.discrepancy, run.status, run.reason || null]
    );
    return res.rows[0];
  }

  public async getLatestRun(provider: string, asset: string): Promise<ReconciliationRun | null> {
    const res = await this.query(
      `SELECT id, provider, asset, external_balance::float as "externalBalance",
              internal_balance::float as "internalBalance", discrepancy::float as discrepancy,
              status, reason, reconciled_at as "reconciledAt"
       FROM reconciliation_runs
       WHERE provider = $1 AND asset = $2
       ORDER BY reconciled_at DESC
       LIMIT 1`,
      [provider, asset]
    );
    return res.rows[0] || null;
  }
}

export type KillSwitchType =
  | 'GLOBAL_KILL_SWITCH'
  | 'NEW_CUSTOMER_PAYMENTS_KILL_SWITCH'
  | 'NEW_PROVISIONING_KILL_SWITCH'
  | 'BINANCE_OUTFLOW_KILL_SWITCH'
  | 'PROVIDER_REBALANCING_KILL_SWITCH'
  | 'AUTONOMOUS_EXECUTION_KILL_SWITCH';

export const ALL_KILL_SWITCH_TYPES: KillSwitchType[] = [
  'GLOBAL_KILL_SWITCH',
  'NEW_CUSTOMER_PAYMENTS_KILL_SWITCH',
  'NEW_PROVISIONING_KILL_SWITCH',
  'BINANCE_OUTFLOW_KILL_SWITCH',
  'PROVIDER_REBALANCING_KILL_SWITCH',
  'AUTONOMOUS_EXECUTION_KILL_SWITCH'
];

export class KillSwitchRepository extends BasePostgresRepository {
  public async isKillSwitchActive(switchId: KillSwitchType = 'GLOBAL_KILL_SWITCH'): Promise<{ active: boolean; reason?: string; switchId?: KillSwitchType }> {
    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        // 1. If checking any domain-specific switch, check GLOBAL_KILL_SWITCH first
        if (switchId !== 'GLOBAL_KILL_SWITCH') {
          const globalRes = await this.query(
            `SELECT is_active as "isActive", reason FROM kill_switch_state WHERE id = 'GLOBAL_KILL_SWITCH'`
          );
          if (globalRes.rows.length > 0 && globalRes.rows[0].isActive) {
            return { active: true, reason: `GLOBAL_KILL_SWITCH is active: ${globalRes.rows[0].reason}`, switchId: 'GLOBAL_KILL_SWITCH' };
          }
        }

        // 2. Check the specific switch requested
        const res = await this.query(
          `SELECT is_active as "isActive", reason FROM kill_switch_state WHERE id = $1`,
          [switchId]
        );
        if (res.rows.length > 0 && res.rows[0].isActive) {
          return { active: true, reason: res.rows[0].reason, switchId };
        }
        return { active: false, switchId };
      } catch {
        if (process.env.NODE_ENV === 'production') {
          return { active: true, reason: 'Database error: Kill switch fails closed in production.', switchId };
        }
      }
    }

    // In-memory fallback check
    const globalFallback = this.fallbackStates.get('GLOBAL_KILL_SWITCH');
    if (switchId !== 'GLOBAL_KILL_SWITCH' && globalFallback?.active) {
      return { active: true, reason: globalFallback.reason || 'Global kill switch active', switchId: 'GLOBAL_KILL_SWITCH' };
    }
    const specific = this.fallbackStates.get(switchId);
    if (specific) {
      return { active: specific.active, reason: specific.reason, switchId };
    }

    if (process.env.NODE_ENV === 'production') {
      return { active: true, reason: 'Database offline: Kill switch fails closed.', switchId };
    }

    return { active: false, switchId };
  }

  private fallbackStates = new Map<KillSwitchType, { active: boolean; reason?: string; activatedAt?: string; activatedBy?: string }>();

  public async getAllKillSwitches(): Promise<Array<{
    switchId: KillSwitchType;
    description: string;
    active: boolean;
    reason?: string;
    activatedAt?: string;
    activatedBy?: string;
  }>> {
    const descriptions: Record<KillSwitchType, string> = {
      GLOBAL_KILL_SWITCH: 'Master emergency kill switch — immediately halts all customer payments, provisioning, outbox events, and capital flows.',
      NEW_CUSTOMER_PAYMENTS_KILL_SWITCH: 'Blocks new customer escrow payment intent creation and settlements.',
      NEW_PROVISIONING_KILL_SWITCH: 'Blocks new compute hardware reservations and provisioning calls to Vast, RunPod, and Lambda.',
      BINANCE_OUTFLOW_KILL_SWITCH: 'Blocks any withdrawal, conversion, or outbound fund movement from Binance Spot treasury.',
      PROVIDER_REBALANCING_KILL_SWITCH: 'Blocks automated capital top-ups and rebalancing to compute provider floats.',
      AUTONOMOUS_EXECUTION_KILL_SWITCH: 'Halts autonomous arbitrage deal selection and execution; manual owner authorization required.'
    };

    const list = ALL_KILL_SWITCH_TYPES.map(id => {
      const fb = this.fallbackStates.get(id);
      return {
        switchId: id,
        description: descriptions[id],
        active: fb?.active || false,
        reason: fb?.reason,
        activatedAt: fb?.activatedAt,
        activatedBy: fb?.activatedBy
      };
    });

    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        const res = await this.query(`SELECT id, is_active as "isActive", reason, activated_at as "activatedAt", activated_by as "activatedBy" FROM kill_switch_state`);
        const map = new Map(res.rows.map(r => [r.id, r]));
        for (const item of list) {
          const row = map.get(item.switchId);
          if (row) {
            item.active = Boolean(row.isActive);
            item.reason = row.reason;
            item.activatedAt = row.activatedAt;
            item.activatedBy = row.activatedBy;
          }
        }
      } catch (err) {
        console.warn('[KILL SWITCH] Could not fetch all kill switch states:', err);
      }
    }
    return list;
  }

  public async setKillSwitch(switchId: KillSwitchType, active: boolean, reason?: string, activatedBy?: string): Promise<void> {
    this.fallbackStates.set(switchId, {
      active,
      reason,
      activatedAt: active ? new Date().toISOString() : undefined,
      activatedBy
    });

    if (pgDbService.isLiveDatabaseConnected()) {
      try {
        await this.query(
          `INSERT INTO kill_switch_state (id, is_active, reason, activated_by, activated_at, updated_at)
           VALUES ($1, $2, $3, $4, CASE WHEN $2 = TRUE THEN NOW() ELSE NULL END, NOW())
           ON CONFLICT (id) DO UPDATE
           SET is_active = $2,
               reason = $3,
               activated_by = $4,
               activated_at = CASE WHEN $2 = TRUE THEN NOW() ELSE kill_switch_state.activated_at END,
               updated_at = NOW()`,
          [switchId, active, reason || null, activatedBy || null]
        );
      } catch (err) {
        console.warn('[KILL SWITCH] Error persisting kill switch state:', err);
      }
    }
  }

  public async activateKillSwitch(switchId: KillSwitchType | string = 'GLOBAL_KILL_SWITCH', reason: string = 'Emergency halt', activatedBy: string = 'system'): Promise<void> {
    const target = ALL_KILL_SWITCH_TYPES.includes(switchId as any) ? (switchId as KillSwitchType) : 'GLOBAL_KILL_SWITCH';
    await this.setKillSwitch(target, true, reason, activatedBy);
  }

  public async deactivateKillSwitch(switchId: KillSwitchType | string = 'GLOBAL_KILL_SWITCH', deactivatedBy: string = 'system'): Promise<void> {
    const target = ALL_KILL_SWITCH_TYPES.includes(switchId as any) ? (switchId as KillSwitchType) : 'GLOBAL_KILL_SWITCH';
    await this.setKillSwitch(target, false, 'Deactivated', deactivatedBy);
  }
}
