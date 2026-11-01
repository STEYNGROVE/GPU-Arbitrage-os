import crypto from 'node:crypto';
import { config } from './config.ts';

export interface UserSession {
  sessionId: string;
  role: 'owner' | 'operator';
  createdAt: number;
  expiresAt: number;
  lastActivityAt: number;
  ip: string;
  userAgent: string;
  csrfToken: string;
}

export interface SecurityAuditEvent {
  id: string;
  timestamp: string;
  event:
    | 'LOGIN_SUCCESS'
    | 'LOGIN_FAILED'
    | 'LOGIN_RATE_LIMITED'
    | 'LOGOUT'
    | 'SESSION_EXPIRED'
    | 'SESSION_REVOKED'
    | 'ALL_SESSIONS_REVOKED'
    | 'CSRF_VALIDATION_FAILED'
    | 'UNAUTHORIZED_ACCESS_ATTEMPT';
  ip: string;
  details: string;
  role?: string;
}

interface LoginAttemptRecord {
  count: number;
  firstAttemptAt: number;
  lockedUntil?: number;
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours max session lifetime
const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour inactivity timeout
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes window
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes lockout

export class SessionService {
  private sessions = new Map<string, UserSession>();
  private loginAttempts = new Map<string, LoginAttemptRecord>();
  private auditEvents: SecurityAuditEvent[] = [];
  private maxAuditEvents = 200;

  constructor() {
    // Periodic session cleanup every 5 minutes
    const timer = setInterval(() => this.cleanupExpiredSessions(), 5 * 60 * 1000);
    if (timer.unref) timer.unref();
  }

  public recordAuditEvent(
    event: SecurityAuditEvent['event'],
    ip: string,
    details: string,
    role?: string
  ): void {
    const record: SecurityAuditEvent = {
      id: `SEC-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      timestamp: new Date().toISOString(),
      event,
      ip,
      details,
      role,
    };
    this.auditEvents.unshift(record);
    if (this.auditEvents.length > this.maxAuditEvents) {
      this.auditEvents.pop();
    }
  }

  public getRecentAuditEvents(): SecurityAuditEvent[] {
    return [...this.auditEvents];
  }

  public createSession(
    role: 'owner' | 'operator',
    ip: string,
    userAgent: string = ''
  ): UserSession {
    const sessionId = crypto.randomBytes(32).toString('hex');
    const csrfToken = crypto.randomBytes(24).toString('hex');
    const now = Date.now();

    const session: UserSession = {
      sessionId,
      role,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      lastActivityAt: now,
      ip,
      userAgent: userAgent.slice(0, 256),
      csrfToken,
    };

    this.sessions.set(sessionId, session);
    this.recordAuditEvent('LOGIN_SUCCESS', ip, `Authenticated new ${role} session created.`, role);
    return session;
  }

  public getSession(sessionId: string | null | undefined): UserSession | null {
    if (!sessionId || typeof sessionId !== 'string') return null;
    const session = this.sessions.get(sessionId.trim());
    if (!session) return null;

    const now = Date.now();
    // Expiration checks: hard lifetime and sliding inactivity
    if (now > session.expiresAt || now - session.lastActivityAt > INACTIVITY_TIMEOUT_MS) {
      this.sessions.delete(sessionId);
      this.recordAuditEvent('SESSION_EXPIRED', session.ip, `Session ${sessionId.slice(0, 8)} expired.`, session.role);
      return null;
    }

    session.lastActivityAt = now;
    return session;
  }

  public revokeSession(sessionId: string, ip: string = 'unknown'): boolean {
    if (!sessionId) return false;
    const existing = this.sessions.get(sessionId.trim());
    const deleted = this.sessions.delete(sessionId.trim());
    if (deleted) {
      this.recordAuditEvent('LOGOUT', ip, `Session ${sessionId.slice(0, 8)} explicitly revoked.`, existing?.role);
    }
    return deleted;
  }

  public revokeAllSessions(actorIp: string = 'unknown'): number {
    const count = this.sessions.size;
    this.sessions.clear();
    this.recordAuditEvent('ALL_SESSIONS_REVOKED', actorIp, `All ${count} active sessions revoked by owner.`);
    return count;
  }

  public verifyCsrf(session: UserSession, providedToken: string | null | undefined): boolean {
    if (!providedToken || typeof providedToken !== 'string') return false;
    if (!session.csrfToken) return false;
    // Constant-time comparison
    const a = crypto.createHash('sha256').update(providedToken.trim()).digest();
    const b = crypto.createHash('sha256').update(session.csrfToken).digest();
    return crypto.timingSafeEqual(a, b);
  }

  public loginWithKey(
    key: string | null | undefined,
    ip: string,
    userAgent: string = ''
  ): { success: boolean; session?: UserSession; error?: string; status: number } {
    const now = Date.now();

    // Check rate limit and lockout for this IP
    const record = this.loginAttempts.get(ip);
    if (record) {
      if (record.lockedUntil && now < record.lockedUntil) {
        const remainingSec = Math.ceil((record.lockedUntil - now) / 1000);
        this.recordAuditEvent('LOGIN_RATE_LIMITED', ip, `Blocked by rate limiter. Lockout active for ${remainingSec}s.`);
        return {
          success: false,
          error: `Too many failed authentication attempts. Locked out for ${remainingSec} seconds.`,
          status: 429,
        };
      }
      if (now - record.firstAttemptAt > LOGIN_WINDOW_MS) {
        // Window expired, reset
        this.loginAttempts.delete(ip);
      }
    }

    if (!key || typeof key !== 'string' || key.trim().length < 16) {
      this.recordFailedAttempt(ip);
      return { success: false, error: 'Valid credential key required.', status: 401 };
    }

    const clean = key.trim();

    // Validate Owner Keys (OWNER_API_KEY or OWNER_OVERRIDE_KEY)
    const ownerTokens = [config.ownerApiKey, config.ownerOverrideKey].filter(
      (v) => typeof v === 'string' && v.length >= 32
    );
    const isOwner = ownerTokens.some((tok) => {
      const a = crypto.createHash('sha256').update(clean).digest();
      const b = crypto.createHash('sha256').update(tok).digest();
      return crypto.timingSafeEqual(a, b);
    });

    if (isOwner) {
      this.loginAttempts.delete(ip); // Clear failed attempts on success
      const session = this.createSession('owner', ip, userAgent);
      return { success: true, session, status: 200 };
    }

    // Validate Operator Key (API_AUTH_TOKEN)
    const operatorTokens = [config.apiAuthToken, config.bridgeToken].filter(
      (v) => typeof v === 'string' && v.length >= 32
    );
    const isOperator = operatorTokens.some((tok) => {
      const a = crypto.createHash('sha256').update(clean).digest();
      const b = crypto.createHash('sha256').update(tok).digest();
      return crypto.timingSafeEqual(a, b);
    });

    if (isOperator) {
      this.loginAttempts.delete(ip);
      const session = this.createSession('operator', ip, userAgent);
      return { success: true, session, status: 200 };
    }

    this.recordFailedAttempt(ip);
    return { success: false, error: 'Invalid authentication key.', status: 401 };
  }

  private recordFailedAttempt(ip: string): void {
    const now = Date.now();
    const existing = this.loginAttempts.get(ip);
    if (!existing) {
      this.loginAttempts.set(ip, { count: 1, firstAttemptAt: now });
    } else {
      existing.count++;
      if (existing.count >= MAX_LOGIN_ATTEMPTS) {
        existing.lockedUntil = now + LOCKOUT_DURATION_MS;
        this.recordAuditEvent(
          'LOGIN_RATE_LIMITED',
          ip,
          `Exceeded maximum failed login attempts (${existing.count}). Account locked for 15 minutes.`
        );
      }
    }
    this.recordAuditEvent('LOGIN_FAILED', ip, 'Invalid credential submitted.');
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now > session.expiresAt || now - session.lastActivityAt > INACTIVITY_TIMEOUT_MS) {
        this.sessions.delete(id);
      }
    }
  }

  public getActiveSessionsCount(): number {
    return this.sessions.size;
  }
}

export const sessionService = new SessionService();
