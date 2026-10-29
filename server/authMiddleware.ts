import type { Request, Response, NextFunction } from 'express';
import { config } from './config.ts';
import crypto from 'crypto';

// In-memory token bucket rate limiter
interface RateLimitRecord {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitRecord>();

export function rateLimiter(maxRequests: number = 60, windowMs: number = 60000) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const key = ip;
    if (rateLimitStore.size > 10000) {
      for (const [oldKey, value] of rateLimitStore) if (value.resetAt < now) rateLimitStore.delete(oldKey);
      if (rateLimitStore.size > 10000 && !rateLimitStore.has(key)) return res.status(429).json({ error: 'Rate limiter capacity reached' });
    }

    const record = rateLimitStore.get(key);
    if (!record || now > record.resetAt) {
      rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (record.count >= maxRequests) {
      return res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded for this endpoint. Please slow down.',
        retryAfterMs: Math.max(0, record.resetAt - now),
      });
    }

    record.count++;
    return next();
  };
}

export function isAuthorizedPassToken(token: string | null): boolean {
  if (!token) return false;
  const clean = token.trim();
  if (!clean) return false;
  const validTokens = [config.apiAuthToken, config.ownerApiKey, config.ownerOverrideKey, config.bridgeToken]
    .filter((value) => typeof value === 'string' && value.length >= 32);
  return validTokens.some((value) => cryptoSafeEqual(clean, value));
}

function cryptoSafeEqual(a: string, b: string): boolean {
  // Compare fixed-size digests to avoid leaking token length or prefix through timing.
  const da = crypto.createHash('sha256').update(a).digest();
  const db = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(da, db);
}

export function extractAuthToken(req: Request): string | null {
  const bridgeHeader = req.headers['x-bridge-token'];
  if (typeof bridgeHeader === 'string' && bridgeHeader.trim()) {
    return bridgeHeader.trim();
  }

  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }

  const apiKeyHeader = req.headers['x-api-key'] || req.headers['x-arbitrage-auth'];
  if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim()) {
    return apiKeyHeader.trim();
  }

  return null;
}

/**
 * Validates request authorization.
 * Allows safe read operations while strictly requiring authorization for mutations.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (isAuthorizedPassToken(extractAuthToken(req))) return next();
  return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
}

/**
 * Require Owner-level authorization for sensitive treasury operations,
 * withdrawals, database resets, and IP whitelist modifications.
 */
export function requireOwnerAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractAuthToken(req);

  const ownerTokens = [config.ownerApiKey, config.ownerOverrideKey].filter((value) => value && value.length >= 32);
  const isOwner = Boolean(token && ownerTokens.some((value) => cryptoSafeEqual(token.trim(), value)));

  if (isOwner) return next();

  // Audit log failed authorization attempt
  console.warn(`[Security Alert 403] Unauthorized access attempt to ${req.method} ${req.path} from IP: ${req.ip}`);
  return res.status(403).json({
    error: 'Forbidden: Owner Authorization Required',
    code: 'OWNER_PERMISSIONS_REQUIRED',
    message: 'This operation requires verified owner authorization (OWNER_API_KEY or OWNER_OVERRIDE_KEY).',
  });
}

/**
 * Validates numeric inputs against NaN, Infinity, negative values, and integer overflows.
 */
export function validatePositiveNumber(val: any, fieldName: string): number {
  const num = Number(val);
  if (typeof val === 'undefined' || val === null || isNaN(num) || !isFinite(num) || num <= 0) {
    throw new Error(`Field '${fieldName}' must be a valid positive number greater than 0.`);
  }
  if (num > 1_000_000_000) {
    throw new Error(`Field '${fieldName}' exceeds maximum allowed transaction threshold.`);
  }
  return num;
}

/**
 * Validates safe string inputs to prevent injection and path traversal.
 */
export function sanitizeString(val: any, maxLength: number = 256): string {
  if (typeof val !== 'string') return '';
  // Disallow null bytes and directory traversal
  const cleaned = val.replace(/\0/g, '').replace(/\.\.\//g, '').trim();
  return cleaned.substring(0, maxLength);
}
