import type { Express, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import crypto from 'crypto';

// Evidence-backed discovery: candidate URLs are not customers, contracts or revenue.
// Explicitly configured public RSS/Atom feeds only; no scraping, spam or outbound email.
export interface AcquisitionLeadRecord {
  id: string;
  title: string;
  source_url: string;
  source_feed: string;
  discovered_at: string;
  status: 'CANDIDATE' | 'REVIEWING' | 'QUALIFIED' | 'REJECTED';
}

export const inMemoryLeadsStore: AcquisitionLeadRecord[] = [];

const db = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? undefined : { rejectUnauthorized: false },
      max: 2
    })
  : null;

const MAX_FEEDS = 5,
  MAX_ENTRIES = 40;
const terms = /\b(gpu|cuda|machine learning|deep learning|model training|render farm|h100|a100|compute cluster|inference)\b/i;

const xmlDecode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const field = (xml: string, name: string) =>
  xml.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'))?.[1]?.trim() || '';

const feeds = () =>
  (process.env.LEAD_RSS_FEEDS || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, MAX_FEEDS);

export function safeFeed(u: string) {
  try {
    const x = new URL(u);
    return (
      x.protocol === 'https:' &&
      !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|::1|\[)/i.test(x.hostname) &&
      !x.hostname.endsWith('.local') &&
      !x.hostname.endsWith('.internal')
    );
  } catch {
    return false;
  }
}

let initialized: Promise<void> | undefined;

async function ready() {
  if (db) {
    if (!initialized) {
      initialized = db
        .query(
          `CREATE TABLE IF NOT EXISTS acquisition_leads (
            id text PRIMARY KEY,
            title text NOT NULL,
            source_url text NOT NULL UNIQUE,
            source_feed text NOT NULL,
            discovered_at timestamptz NOT NULL DEFAULT now(),
            status text NOT NULL DEFAULT 'CANDIDATE',
            CHECK(status IN ('CANDIDATE','REVIEWING','QUALIFIED','REJECTED'))
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

  // Only explicit test harness allows in-memory test fallback
  if (process.env.NODE_ENV === 'test' && process.env.DISABLE_JSON_PERSISTENCE === 'true') {
    return;
  }

  throw Error('DATABASE_URL_NOT_CONFIGURED');
}

async function scan() {
  await ready();
  const results = [] as Array<{ feed: string; inserted: number; error?: string }>;
  const feedList = feeds();

  if (feedList.length === 0) {
    return {
      mode: 'DISCOVERY_ONLY',
      outreachEnabled: false,
      purchasingEnabled: false,
      message: 'No feeds configured. Set LEAD_RSS_FEEDS to enable discovery.',
      results: []
    };
  }

  for (const feed of feedList) {
    if (!safeFeed(feed)) {
      results.push({ feed, inserted: 0, error: 'UNSAFE_FEED_URL' });
      continue;
    }
    let inserted = 0;
    try {
      const r = await fetch(feed, {
        headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml' },
        signal: AbortSignal.timeout(9000),
        redirect: 'error'
      });
      if (!r.ok) throw Error('FEED_HTTP_' + r.status);
      const length = Number(r.headers.get('content-length') || 0);
      if (length > 1024 * 1024) throw Error('FEED_TOO_LARGE');
      const xml = (await r.text()).slice(0, 1024 * 1024);
      const entries = Array.from(xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)).slice(0, MAX_ENTRIES);
      for (const m of entries) {
        const entry = m[2];
        const title = xmlDecode(field(entry, 'title'))
          .replace(/<[^>]+>/g, '')
          .slice(0, 240);
        const description = xmlDecode(field(entry, 'description') || field(entry, 'summary'))
          .replace(/<[^>]+>/g, '')
          .slice(0, 600);
        if (!terms.test(title + ' ' + description)) continue;
        let url = xmlDecode(field(entry, 'link'));
        if (!url) {
          url = entry.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] || '';
        }
        if (!safeFeed(url)) continue;
        const id = crypto.createHash('sha256').update(url).digest('hex');

        if (db) {
          const q = await db.query(
            'INSERT INTO acquisition_leads(id,title,source_url,source_feed) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
            [id, title, url, feed]
          );
          inserted += q.rowCount || 0;
        } else {
          const exists = inMemoryLeadsStore.some((l) => l.id === id || l.source_url === url);
          if (!exists) {
            inMemoryLeadsStore.unshift({
              id,
              title,
              source_url: url,
              source_feed: feed,
              discovered_at: new Date().toISOString(),
              status: 'CANDIDATE'
            });
            inserted += 1;
          }
        }
      }
      results.push({ feed, inserted });
    } catch (e: any) {
      results.push({ feed, inserted, error: String(e.message || e).slice(0, 120) });
    }
  }
  return { mode: 'DISCOVERY_ONLY', outreachEnabled: false, purchasingEnabled: false, results };
}

export function registerLeadDiscovery(app: Express, owner: (req: Request, res: Response, next: NextFunction) => void) {
  app.post('/api/acquisition/discover', owner, async (_req, res) => {
    try {
      res.json(await scan());
    } catch (e: any) {
      res.status(503).json({ error: String(e.message || e) });
    }
  });

  app.get('/api/acquisition/leads', owner, async (_req, res) => {
    try {
      await ready();
      if (db) {
        const r = await db.query(
          'SELECT id,title,source_url,source_feed,discovered_at,status FROM acquisition_leads ORDER BY discovered_at DESC LIMIT 100'
        );
        return res.json({ leads: r.rows, verifiedCustomers: 0, realizedRevenueUsd: 0 });
      }
      return res.json({ leads: inMemoryLeadsStore, verifiedCustomers: 0, realizedRevenueUsd: 0 });
    } catch (e: any) {
      res.status(503).json({ error: String(e.message || e) });
    }
  });

  app.patch('/api/acquisition/leads/:id', owner, async (req, res) => {
    const status = req.body?.status;
    if (!['REVIEWING', 'QUALIFIED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ error: 'INVALID_STATUS' });
    }
    try {
      await ready();
      if (db) {
        const r = await db.query('UPDATE acquisition_leads SET status=$1 WHERE id=$2 RETURNING id,status', [
          status,
          req.params.id
        ]);
        return res.status(r.rowCount ? 200 : 404).json(r.rows[0] || { error: 'NOT_FOUND' });
      }
      const match = inMemoryLeadsStore.find((l) => l.id === req.params.id);
      if (!match) return res.status(404).json({ error: 'NOT_FOUND' });
      match.status = status;
      return res.status(200).json({ id: match.id, status: match.status });
    } catch (e: any) {
      res.status(503).json({ error: String(e.message || e) });
    }
  });
}
