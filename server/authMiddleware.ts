import type { Request, Response, NextFunction } from 'express';
import { config } from './config.ts';
import crypto from 'node:crypto';
import { sessionService, type UserSession } from './sessionService.ts';

// In-memory token bucket rate limiter for general routes
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

export function cryptoSafeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
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

  const ownerHeader = req.headers['x-owner-key'] || req.headers['x-owner-override-key'];
  if (typeof ownerHeader === 'string' && ownerHeader.trim()) {
    return ownerHeader.trim();
  }

  const apiKeyHeader = req.headers['x-api-key'] || req.headers['x-arbitrage-auth'] || req.headers['x-operator-key'];
  if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim()) {
    return apiKeyHeader.trim();
  }

  return null;
}

export function extractSessionId(req: Request): string | null {
  // Check signed/unsigned cookies first
  const cookies = req.cookies || {};
  const cookieSession = cookies['__Host-gpu_session'] || cookies['gpu_session'];
  if (typeof cookieSession === 'string' && cookieSession.trim()) {
    return cookieSession.trim();
  }

  const customHeader = req.headers['x-session-id'];
  if (typeof customHeader === 'string' && customHeader.trim()) {
    return customHeader.trim();
  }

  return null;
}

export interface AuthContext {
  authenticated: boolean;
  role: 'owner' | 'operator' | 'anonymous';
  isOwner: boolean;
  authMethod: 'SESSION_COOKIE' | 'BEARER_TOKEN' | 'STATIC_KEY' | 'NONE';
  session?: UserSession;
}

/**
 * Resolves current authentication context from cookies, sessions, and headers.
 * NEVER uses client IP alone to authenticate!
 */
export function resolveAuth(req: Request): AuthContext {
  // 1. Check Session Cookie or Session ID header
  const sessionId = extractSessionId(req);
  if (sessionId) {
    const session = sessionService.getSession(sessionId);
    if (session) {
      return {
        authenticated: true,
        role: session.role,
        isOwner: session.role === 'owner',
        authMethod: 'SESSION_COOKIE',
        session,
      };
    }
  }

  // 2. Check Bearer / API token
  const token = extractAuthToken(req);
  if (token) {
    // 2a. Token might be an active ephemeral sessionId passed via Bearer header
    const tokenSession = sessionService.getSession(token);
    if (tokenSession) {
      return {
        authenticated: true,
        role: tokenSession.role,
        isOwner: tokenSession.role === 'owner',
        authMethod: 'BEARER_TOKEN',
        session: tokenSession,
      };
    }

    // 2b. Direct Static Owner Key comparison (constant-time, for automated scripts / tests)
    const ownerTokens = [config.ownerApiKey, config.ownerOverrideKey].filter(
      (v) => typeof v === 'string' && v.length >= 32
    );
    if (ownerTokens.some((tok) => cryptoSafeEqual(token, tok))) {
      return {
        authenticated: true,
        role: 'owner',
        isOwner: true,
        authMethod: 'STATIC_KEY',
      };
    }

    // 2c. Direct Static Operator / Bridge Key comparison
    const operatorTokens = [config.apiAuthToken, config.bridgeToken].filter(
      (v) => typeof v === 'string' && v.length >= 32
    );
    if (operatorTokens.some((tok) => cryptoSafeEqual(token, tok))) {
      return {
        authenticated: true,
        role: 'operator',
        isOwner: false,
        authMethod: 'STATIC_KEY',
      };
    }
  }

  // 3. Check body ownerOverrideKey (for owner authorization fallback)
  const bodyKey = typeof req.body?.ownerOverrideKey === 'string' ? req.body.ownerOverrideKey.trim() : null;
  if (bodyKey && bodyKey.length >= 32) {
    const ownerTokens = [config.ownerApiKey, config.ownerOverrideKey].filter(
      (v) => typeof v === 'string' && v.length >= 32
    );
    if (ownerTokens.some((tok) => cryptoSafeEqual(bodyKey, tok))) {
      return {
        authenticated: true,
        role: 'owner',
        isOwner: true,
        authMethod: 'STATIC_KEY',
      };
    }
  }

  return {
    authenticated: false,
    role: 'anonymous',
    isOwner: false,
    authMethod: 'NONE',
  };
}

export function isAuthorizedPassToken(token: string | null): boolean {
  if (!token) return false;
  const clean = token.trim();
  if (!clean) return false;

  // Check active session IDs
  if (sessionService.getSession(clean)) return true;

  const validTokens = [config.apiAuthToken, config.ownerApiKey, config.ownerOverrideKey, config.bridgeToken]
    .filter((value) => typeof value === 'string' && value.length >= 32);
  return validTokens.some((value) => cryptoSafeEqual(clean, value));
}

/**
 * Validates request authorization.
 * Rejects unauthenticated callers.
 * For cookie-authenticated state-changing requests (POST/PUT/DELETE/PATCH), enforces CSRF token validation.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = resolveAuth(req);
  if (!auth.authenticated) {
    sessionService.recordAuditEvent(
      'UNAUTHORIZED_ACCESS_ATTEMPT',
      req.ip || 'unknown',
      `Blocked unauthorized access to ${req.method} ${req.path}`
    );
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }

  // CSRF validation for cookie-authenticated state-changing requests
  if (auth.authMethod === 'SESSION_COOKIE' && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const csrfHeader = (req.headers['x-csrf-token'] as string) || (req.body?._csrf as string);
    if (!auth.session || !sessionService.verifyCsrf(auth.session, csrfHeader)) {
      sessionService.recordAuditEvent(
        'CSRF_VALIDATION_FAILED',
        req.ip || 'unknown',
        `CSRF validation failed on ${req.method} ${req.path}`,
        auth.role
      );
      return res.status(403).json({
        error: 'Forbidden: Invalid or missing CSRF token',
        code: 'CSRF_INVALID',
      });
    }
  }

  (req as any).auth = auth;
  return next();
}

/**
 * Require Owner-level authorization for sensitive treasury operations,
 * withdrawals, database resets, and IP whitelist modifications.
 */
export function requireOwnerAuth(req: Request, res: Response, next: NextFunction) {
  const auth = resolveAuth(req);

  if (!auth.authenticated) {
    sessionService.recordAuditEvent(
      'UNAUTHORIZED_ACCESS_ATTEMPT',
      req.ip || 'unknown',
      `Unauthenticated attempt to access owner route ${req.method} ${req.path}`
    );
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }

  if (!auth.isOwner) {
    sessionService.recordAuditEvent(
      'UNAUTHORIZED_ACCESS_ATTEMPT',
      req.ip || 'unknown',
      `Insufficient privileges (${auth.role}) for owner route ${req.method} ${req.path}`,
      auth.role
    );
    console.warn(`[Security Alert 403] Unauthorized access attempt to ${req.method} ${req.path} from IP: ${req.ip}`);
    return res.status(403).json({
      error: 'Forbidden: Owner Authorization Required',
      code: 'OWNER_PERMISSIONS_REQUIRED',
      message: 'This operation requires verified owner authorization (OWNER_API_KEY or OWNER_OVERRIDE_KEY).',
    });
  }

  // CSRF check if using session cookie
  if (auth.authMethod === 'SESSION_COOKIE' && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const csrfHeader = (req.headers['x-csrf-token'] as string) || (req.body?._csrf as string);
    if (!auth.session || !sessionService.verifyCsrf(auth.session, csrfHeader)) {
      sessionService.recordAuditEvent(
        'CSRF_VALIDATION_FAILED',
        req.ip || 'unknown',
        `CSRF validation failed on owner mutation ${req.method} ${req.path}`,
        'owner'
      );
      return res.status(403).json({
        error: 'Forbidden: Invalid or missing CSRF token',
        code: 'CSRF_INVALID',
      });
    }
  }

  (req as any).auth = auth;
  return next();
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
