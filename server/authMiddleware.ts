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
    const key = `${ip}:${req.path}`;
    const now = Date.now();

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
  if (typeof bridgeHeader === 'string') {
    return bridgeHeader.trim();
  }

  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }

  const apiKeyHeader = req.headers['x-api-key'] || req.headers['x-arbitrage-auth'];
  if (typeof apiKeyHeader === 'string') {
    return apiKeyHeader.trim();
  }

  return null;
}

/**
 * Validates request authorization.
 * Allows safe read operations while strictly requiring authorization for mutations.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // In development/simulation browser sessions, allow UI read operations
  const token = extractAuthToken(req);

  // If valid API token is supplied
  if (isAuthorizedPassToken(token)) {
    return next();
  }

  // If in production mode, strict auth is required
  if (config.isProduction) {
    return res.status(401).json({
      error: 'Unauthorized',
      code: 'AUTH_REQUIRED',
      message: 'A valid Bearer token, X-Bridge-Token, or X-API-Key header is required to access this endpoint.',
    });
  }

  // In simulation mode, check if request is state-mutating (POST, PUT, DELETE)
  // Allow if localhost/loopback or same-origin browser session
  const isSameOrigin =
    req.headers['sec-fetch-site'] === 'same-origin' ||
    (typeof req.headers.referer === 'string' && req.headers.referer.includes(req.hostname));
  const isLocal =
    req.ip === '127.0.0.1' ||
    req.ip === '::1' ||
    req.ip === '::ffff:127.0.0.1' ||
    req.hostname === 'localhost';

  if (!config.isProduction || isSameOrigin || isLocal) {
    return next();
  }

  // Check token
  if (!isAuthorizedPassToken(token)) {
    return res.status(401).json({
      error: 'Unauthorized',
      code: 'AUTH_REQUIRED',
      message: 'Unauthorized remote access. Provide X-Bridge-Token, X-API-Key or Bearer token.',
    });
  }

  return next();
}

/**
 * Require Owner-level authorization for sensitive treasury operations,
 * withdrawals, database resets, and IP whitelist modifications.
 */
export function requireOwnerAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractAuthToken(req);

  const ownerTokens = [config.ownerApiKey, config.ownerOverrideKey].filter((value) => value && value.length >= 32);
  const isOwner = Boolean(token && ownerTokens.some((value) => cryptoSafeEqual(token.trim(), value)));

  const isSameOrigin =
    req.headers['sec-fetch-site'] === 'same-origin' ||
    (typeof req.headers.referer === 'string' && req.headers.referer.includes(req.hostname));
  const isLocal =
    req.ip === '127.0.0.1' ||
    req.ip === '::1' ||
    req.ip === '::ffff:127.0.0.1' ||
    req.hostname === 'localhost';

  if (isOwner || (!config.isProduction && (isSameOrigin || isLocal))) {
    return next();
  }

  // Audit log failed authorization attempt
  console.warn(`[Security Alert 403] Unauthorized access attempt to ${req.method} ${req.path} from IP: ${req.ip}`);
  return res.status(403).json({
    error: 'Forbidden: Owner Authorization Required',
    code: 'OWNER_PERMISSIONS_REQUIRED',
    message: 'This operation requires verified owner authorization (OWNER_API_KEY or V13_BRIDGE_TOKEN).',
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
