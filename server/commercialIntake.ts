import type { Express, Request, Response } from 'express';
import { Pool } from 'pg';
import crypto from 'crypto';
import { getSuppliersConnectivityReport } from './supplierConnectivity.js';

export interface CommercialQuoteRecord {
  id: string;
  created_at: string;
  company: string;
  contact_name: string;
  email: string;
  workload: string;
  gpu_model: string;
  gpu_count: number;
  hours: number;
  notes: string;
  status: 'NEW' | 'REVIEWING' | 'QUOTED' | 'CLOSED';
}

// In-memory test store for test harnesses and offline verification
export const inMemoryQuoteStore: CommercialQuoteRecord[] = [];

// Separate, untrusted customer-intake channel. Never triggers procurement or payment.
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? undefined : { rejectUnauthorized: false },
      max: 2
    })
  : null;

let initialized: Promise<void> | undefined;

async function ready() {
  if (pool) {
    if (!initialized) {
      initialized = pool
        .query(
          `CREATE TABLE IF NOT EXISTS commercial_quote_requests (
            id uuid PRIMARY KEY,
            created_at timestamptz NOT NULL DEFAULT now(),
            company text NOT NULL,
            contact_name text NOT NULL,
            email text NOT NULL,
            workload text NOT NULL,
            gpu_model text NOT NULL,
            gpu_count integer NOT NULL,
            hours integer NOT NULL,
            notes text NOT NULL,
            status text NOT NULL DEFAULT 'NEW',
            CONSTRAINT quote_request_status_check CHECK (status IN ('NEW','REVIEWING','QUOTED','CLOSED'))
          )`
        )
        .then(() => undefined)
        .catch((e) => {
          initialized = undefined;
          throw e;
        });
    }
    await initialized;
    return;
  }

  // In test harness or sandbox without DATABASE_URL, allow in-memory storage
  if (process.env.NODE_ENV === 'test' && process.env.DISABLE_JSON_PERSISTENCE === 'true') {
    return;
  }

  // Strict production behavior: fail closed if DATABASE_URL is not configured
  throw new Error('DATABASE_URL_NOT_CONFIGURED');
}

const allowedModels = ['ANY', 'RTX 4090', 'RTX 5090', 'A100', 'H100', 'H200', 'L40S', 'B200'];
const allowedWorkloads = ['AI_INFERENCE', 'AI_TRAINING', 'RENDERING', 'DATA_PROCESSING', 'OTHER'];
const rate = new Map<string, { count: number; until: number }>();

function publicRateLimit(req: Request, res: Response): boolean {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const item = rate.get(ip);
  const next = !item || item.until < now
    ? { count: 1, until: now + 3600000 }
    : { count: item.count + 1, until: item.until };
  rate.set(ip, next);
  if (next.count > 8) {
    res.status(429).json({ error: 'TOO_MANY_REQUESTS' });
    return false;
  }
  return true;
}

function stringField(v: unknown, max: number) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export function registerCommercialIntake(app: Express, requireOwnerAuth: any) {
  // Public quote parameters and market boundaries
  app.get('/api/public/quote-info', (_req, res) =>
    res.json({
      status: 'ENQUIRIES_ONLY',
      currency: 'USD',
      priceStatus: 'NOT_QUOTED',
      supplierVerification: 'PENDING',
      purchasingEnabled: false,
      paymentEnabled: false,
      availableModels: allowedModels,
      workloads: allowedWorkloads
    })
  );

  // Public customer quote intake
  app.post('/api/public/quote-request', async (req, res) => {
    if (!publicRateLimit(req, res)) return;
    if (req.body?.website) return res.status(202).json({ accepted: true }); // honeypot

    const company = stringField(req.body?.company, 120);
    const contact = stringField(req.body?.contactName, 120);
    const email = stringField(req.body?.email, 254).toLowerCase();
    const notes = stringField(req.body?.notes, 1000);
    const workload = stringField(req.body?.workload, 40);
    const gpu = stringField(req.body?.gpuModel, 40);
    const count = Number(req.body?.gpuCount);
    const hours = Number(req.body?.hours);

    if (
      !company ||
      !contact ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !allowedWorkloads.includes(workload) ||
      !allowedModels.includes(gpu) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 256 ||
      !Number.isInteger(hours) ||
      hours < 1 ||
      hours > 8760
    ) {
      return res.status(400).json({ error: 'INVALID_REQUEST' });
    }

    try {
      await ready();
      const id = crypto.randomUUID();

      if (pool) {
        await pool.query(
          'INSERT INTO commercial_quote_requests (id,company,contact_name,email,workload,gpu_model,gpu_count,hours,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [id, company, contact, email, workload, gpu, count, hours, notes]
        );
      } else {
        inMemoryQuoteStore.unshift({
          id,
          created_at: new Date().toISOString(),
          company,
          contact_name: contact,
          email,
          workload,
          gpu_model: gpu,
          gpu_count: count,
          hours,
          notes,
          status: 'NEW'
        });
      }

      res.status(201).json({
        accepted: true,
        reference: id,
        status: 'AWAITING_MANUAL_REVIEW',
        price: null,
        paymentRequired: false
      });
    } catch (err) {
      console.error('[QUOTE INTAKE] Storage unavailable', err instanceof Error ? err.message : 'error');
      res.status(503).json({ error: 'INTAKE_TEMPORARILY_UNAVAILABLE' });
    }
  });

  // Owner enquiry list
  app.get('/api/commercial/requests', requireOwnerAuth, async (_req, res) => {
    try {
      await ready();
      if (pool) {
        const result = await pool.query(
          'SELECT id,created_at,company,contact_name,email,workload,gpu_model,gpu_count,hours,notes,status FROM commercial_quote_requests ORDER BY created_at DESC LIMIT 100'
        );
        return res.json({ status: 'ok', requests: result.rows });
      }
      return res.json({ status: 'ok', requests: inMemoryQuoteStore });
    } catch {
      res.status(503).json({ error: 'DATABASE_UNAVAILABLE' });
    }
  });

  // Owner status update
  app.patch('/api/commercial/requests/:id', requireOwnerAuth, async (req, res) => {
    const status = stringField(req.body?.status, 20);
    if (!['NEW', 'REVIEWING', 'QUOTED', 'CLOSED'].includes(status) || !/^[0-9a-f-]{36}$/i.test(req.params.id)) {
      return res.status(400).json({ error: 'INVALID_STATUS_OR_ID' });
    }

    try {
      await ready();
      if (pool) {
        const result = await pool.query(
          'UPDATE commercial_quote_requests SET status=$1 WHERE id=$2 RETURNING id,status',
          [status, req.params.id]
        );
        if (!result.rowCount) return res.status(404).json({ error: 'NOT_FOUND' });
        return res.json(result.rows[0]);
      }

      const match = inMemoryQuoteStore.find((r) => r.id === req.params.id);
      if (!match) return res.status(404).json({ error: 'NOT_FOUND' });
      match.status = status as any;
      return res.json({ id: match.id, status: match.status });
    } catch {
      res.status(503).json({ error: 'DATABASE_UNAVAILABLE' });
    }
  });

  // Read-only Vast.ai and RunPod supplier connectivity check
  app.get('/api/suppliers/connectivity-check', requireOwnerAuth, async (_req, res) => {
    try {
      const report = await getSuppliersConnectivityReport();
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: 'CONNECTIVITY_CHECK_FAILED', message: err.message });
    }
  });
}
