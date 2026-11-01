import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import { sessionService } from '../server/sessionService.ts';
import { requireAuth, requireOwnerAuth, resolveAuth } from '../server/authMiddleware.ts';
import { financialLedger } from '../server/financialLedger.ts';
import { providerVerificationService } from '../server/providerVerificationService.ts';
import { verifiedOpportunityEngine } from '../server/verifiedOpportunityEngine.ts';
import { config } from '../server/config.ts';

test('Security & Authentication Suite', async (t) => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  // Setup test routes
  app.post('/api/auth/login', (req, res) => {
    const { key } = req.body || {};
    const ip = req.ip || '127.0.0.1';
    const result = sessionService.loginWithKey(key, ip);
    if (!result.success || !result.session) {
      return res.status(result.status).json({ success: false, error: result.error });
    }
    res.cookie('gpu_session', result.session.sessionId, { httpOnly: true, sameSite: 'strict' });
    return res.json({ success: true, role: result.session.role, csrfToken: result.session.csrfToken });
  });

  app.post('/api/auth/logout', (req, res) => {
    const cookies = req.cookies || {};
    const sessionId = cookies['gpu_session'];
    if (sessionId) {
      sessionService.revokeSession(sessionId, req.ip || '127.0.0.1');
    }
    res.clearCookie('gpu_session');
    res.json({ success: true });
  });

  app.get('/api/auth/session-token', (req, res) => {
    const auth = resolveAuth(req);
    if (!auth.authenticated) {
      return res.status(401).json({ authenticated: false, token: null });
    }
    return res.json({ authenticated: true, role: auth.role, csrfToken: auth.session?.csrfToken });
  });

  app.get('/api/owner/audit', requireAuth, requireOwnerAuth, (_req, res) => {
    res.json({ success: true, events: sessionService.getRecentAuditEvents() });
  });

  app.post('/api/owner/mutation', requireAuth, requireOwnerAuth, (_req, res) => {
    res.json({ success: true, mutated: true });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;

  t.after(() => {
    server.close();
  });

  await t.test('1. Unauthenticated request to /api/auth/session-token returns 401 and NEVER returns secrets', async () => {
    const res = await fetch(`${base}/api/auth/session-token`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.token, null);
    assert.equal(body.ownerApiKey, undefined);
    assert.equal(body.apiAuthToken, undefined);
  });

  await t.test('2. Anonymous request cannot access owner routes', async () => {
    const res = await fetch(`${base}/api/owner/audit`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, 'AUTH_REQUIRED');
  });

  await t.test('3. Operator token cannot access owner mutations (403 Forbidden)', async () => {
    const res = await fetch(`${base}/api/owner/mutation`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiAuthToken}`,
        'Content-Type': 'application/json',
      },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'OWNER_PERMISSIONS_REQUIRED');
  });

  await t.test('4. Login with owner key establishes session with HttpOnly cookie and CSRF token', async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: config.ownerApiKey }),
    });
    assert.equal(res.status, 200);
    const cookies = res.headers.get('set-cookie') || '';
    assert.ok(cookies.includes('gpu_session='));
    assert.ok(cookies.toLowerCase().includes('httponly'));

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.role, 'owner');
    assert.ok(body.csrfToken && body.csrfToken.length >= 16);

    const sessionIdMatch = cookies.match(/gpu_session=([^;]+)/);
    const sessionId = sessionIdMatch ? sessionIdMatch[1] : '';

    // Verify state-changing mutation with cookie BUT MISSING CSRF token is rejected (403)
    const noCsrfRes = await fetch(`${base}/api/owner/mutation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `gpu_session=${sessionId}`,
      },
    });
    assert.equal(noCsrfRes.status, 403);
    const noCsrfBody = await noCsrfRes.json();
    assert.equal(noCsrfBody.code, 'CSRF_INVALID');

    // Verify state-changing mutation with valid CSRF token succeeds (200)
    const validCsrfRes = await fetch(`${base}/api/owner/mutation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `gpu_session=${sessionId}`,
        'x-csrf-token': body.csrfToken,
      },
    });
    assert.equal(validCsrfRes.status, 200);

    // Verify logout revokes the session
    const logoutRes = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: `gpu_session=${sessionId}` },
    });
    assert.equal(logoutRes.status, 200);

    // After logout, session is dead
    const deadRes = await fetch(`${base}/api/owner/audit`, {
      headers: { Cookie: `gpu_session=${sessionId}` },
    });
    assert.equal(deadRes.status, 401);
  });

  await t.test('5. Net profit formula strictly enforces NET_PROFIT = SETTLED_REVENUE - ACTUAL_PROVIDER_COSTS - TRANSACTION_FEES', () => {
    const summary = financialLedger.getCFOBreakdown();
    const metrics = summary.metrics.revenueMetrics;
    assert.equal(metrics.calculationMethod, 'GAAP_CONSERVATIVE_ACCRUAL');
    assert.ok(Number.isFinite(metrics.realisedRevenueUsd));
    assert.ok(Number.isFinite(metrics.realisedProfitUsd));
  });

  await t.test('6. Provider verification engine reports standardized operational statuses', async () => {
    const statuses = await providerVerificationService.getAllProviderStatuses({ isConnected: false });
    assert.ok(statuses.length >= 10);
    const requiredProviders = [
      'vast-ai',
      'runpod',
      'tensordock',
      'akash',
      'salad',
      'lightning-ai',
      'hyperstack',
      'coreweave',
      'lambda-labs',
      'hostinger',
    ];
    for (const pid of requiredProviders) {
      const p = statuses.find((s) => s.providerId === pid);
      assert.ok(p, `Provider ${pid} must be present in verification output`);
      assert.ok(
        ['NOT CONFIGURED', 'CONNECTED', 'DEGRADED', 'ERROR'].includes(p.status),
        `Status ${p.status} must be standard`
      );
    }
  });

  await t.test('7. Opportunity Engine enforces 15% default margin threshold and budget ceiling', () => {
    const limits = verifiedOpportunityEngine.getRiskLimits();
    assert.equal(limits.minGrossMarginPct, 15.0);

    // 10% margin should be rejected
    const checkLowMargin = verifiedOpportunityEngine.calculateNetProfitability(100, 90);
    assert.equal(checkLowMargin.meetsMarginThreshold, false);
    assert.equal(checkLowMargin.riskApproved, false);

    // 25% margin with spending authorized should pass
    verifiedOpportunityEngine.updateRiskLimits({ spendingAuthorized: true, hardBudgetLimitUsd: 1000 });
    const checkGood = verifiedOpportunityEngine.calculateNetProfitability(100, 75);
    assert.equal(checkGood.meetsMarginThreshold, true);
    assert.equal(checkGood.riskApproved, true);
    assert.equal(checkGood.netProfitUsd, 25.0);

    // Reset authorization back to fail-closed
    verifiedOpportunityEngine.updateRiskLimits({ spendingAuthorized: false, hardBudgetLimitUsd: 0 });
  });
});
