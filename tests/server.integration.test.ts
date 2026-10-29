import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-server-test-'));
const reservation = net.createServer().listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = (reservation.address() as net.AddressInfo).port;
await new Promise<void>(resolve => reservation.close(() => resolve()));
const operator = crypto.randomBytes(32).toString('hex');
const owner = crypto.randomBytes(32).toString('hex');
const bridge = crypto.randomBytes(32).toString('hex');
const override = crypto.randomBytes(32).toString('hex');
const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
  env: { ...process.env, NODE_ENV: 'production', SYSTEM_OPERATING_MODE: 'PRODUCTION', PORT: String(port),
    API_AUTH_TOKEN: operator, OWNER_API_KEY: owner, OWNER_OVERRIDE_KEY: override, V13_BRIDGE_TOKEN: bridge,
    PGPASSWORD: crypto.randomBytes(32).toString('hex'), PGHOST: '127.0.0.1', PGPORT: '1',
    APP_DATA_DIR: temp, BINANCE_API_KEY: '', BINANCE_SECRET_KEY: '', GROQ_API_KEY: '',
    RUNPOD_API_KEY: '', LIGHTNING_AI_API_KEY: '', TRUST_PROXY: '', TRUSTED_IPS: '127.0.0.1',
  }, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', part => { output += String(part); });
child.stderr.on('data', part => { output += String(part); });
const base = `http://127.0.0.1:${port}`;
let ready = false;
for (let attempt = 0; attempt < 150; attempt++) {
  if (child.exitCode !== null) throw new Error('Server failed to start: ' + output);
  try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch {}
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (!ready) { child.kill('SIGTERM'); throw new Error('Server startup timed out: ' + output); }
test.after(async () => { child.kill('SIGTERM'); await once(child, 'exit'); fs.rmSync(temp, { recursive: true, force: true }); });
const get = (route: string, key?: string, method = 'GET', body?: any) => fetch(base + route, {
  method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
test('HTTP liveness is public while account, memory and bridge reads require a key', async () => {
  const health = await (await get('/api/health')).json();
  assert.equal(health.status, 'UP');
  assert.equal(health.relationsStatus, 'DATABASE_UNAVAILABLE');
  for (const route of ['/api/settings/bridge', '/api/binance/account', '/api/system/memory']) {
    assert.equal((await get(route)).status, 401);
  }
});
test('Owner-only mutations, secret redaction and server-owned state are enforced end to end', async () => {
  assert.equal((await get('/api/system/memory/save', operator, 'POST', { state: { preferences: {} } })).status, 403);
  assert.equal((await get('/api/system/memory/save', owner, 'POST', { state: { binanceAccount: { usdtBalance: 999999 } } })).status, 400);
  assert.equal((await get('/api/system/memory/save', owner, 'POST', { state: { preferences: { tab: 'System' } } })).status, 200);
  const settings = await get('/api/settings/bridge', owner);
  const text = await settings.text();
  assert.equal(settings.status, 200);
  for (const secret of [operator, owner, bridge, override]) assert.ok(!text.includes(secret));
  const memory = await (await get('/api/system/memory', owner)).json();
  assert.deepEqual(memory.state.activeContracts, []);
});
test('Unsafe routes cannot claim success, including trailing-slash variants', async () => {
  for (const route of ['/api/binance/sweep', '/api/binance/deposit', '/api/binance/borrow', '/api/binance/withdraw', '/api/arbitrage/execute', '/api/github/sync', '/api/github/config/']) {
    const res = await get(route, owner, 'POST', { amount: 100000 });
    assert.equal(res.status, 503, route);
    assert.equal((await res.json()).success, false);
  }
  const ready = await get('/api/readiness', owner);
  assert.equal(ready.status, 503);
  assert.equal((await ready.json()).ready, false);
});
test('Unknown API routes return JSON 404 rather than the SPA page', async () => {
  const response = await get('/api/does-not-exist', owner);
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type') || '', /json/);
});
test('Configured but unreachable dependencies do not masquerade as connected', async () => {
  const account = await (await get('/api/binance/account', owner)).json();
  assert.equal(account.isConnected, false);
  const groq = await (await get('/api/ai/status', owner)).json();
  assert.equal(groq.status, 'OFFLINE');
  const response = await get('/api/ai/copilot', owner, 'POST', { messages: [{ role: 'user', content: 'hello' }] });
  assert.ok(response.status >= 400);
  assert.match((await response.json()).error, /not configured/);
});
