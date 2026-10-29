import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-blocker-tests-'));
process.env.APP_DATA_DIR = directory;
process.env.SYSTEM_OPERATING_MODE = 'SIMULATION';
process.env.API_AUTH_TOKEN = 'a'.repeat(48);
process.env.OWNER_API_KEY = 'b'.repeat(48);
process.env.OWNER_OVERRIDE_KEY = 'c'.repeat(48);
process.env.GROQ_API_KEY = '';
const { requireAuth, requireOwnerAuth } = await import('../server/authMiddleware.ts');
const { gpuArbitrageService } = await import('../server/gpuArbitrageService.ts');
const { financialLedger } = await import('../server/financialLedger.ts');
const { customerRevenueService } = await import('../server/revenuePipeline.ts');
const { paymentsService } = await import('../server/paymentsService.ts');
const { groqAiService } = await import('../server/groqAiService.ts');
const { redact } = await import('../server/redact.ts');
const { computeContractAccruedPnL, INITIAL_ACTIVE_CONTRACTS, generateInitialFleetWorkers } = await import('../src/services/arbitrageEngine.ts');

const app = express();
app.get('/read', requireAuth, (_req, res) => res.json({ ok: true }));
app.post('/owner', requireAuth, requireOwnerAuth, (_req, res) => res.json({ ok: true }));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.on('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => { server.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('Origin, Referer, Host and loopback cannot substitute for an access key', async () => {
  assert.equal((await fetch(base + '/read', { headers: { 'sec-fetch-site': 'same-origin', Referer: base, 'x-forwarded-for': '127.0.0.1' } })).status, 401);
  assert.equal((await fetch(base + '/read', { headers: { Authorization: `Bearer ${process.env.API_AUTH_TOKEN}` } })).status, 200);
});
test('Operator token cannot perform owner mutations', async () => {
  assert.equal((await fetch(base + '/owner', { method: 'POST', headers: { Authorization: `Bearer ${process.env.API_AUTH_TOKEN}` } })).status, 403);
  assert.equal((await fetch(base + '/owner', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OWNER_API_KEY}` } })).status, 200);
});
test('Catalogue quotes remain non-executable and retain source date across refreshes', async () => {
  const first = await gpuArbitrageService.getQuotes();
  const second = await gpuArbitrageService.fetchLiveQuotes();
  assert.ok(first.length > 0);
  assert.ok(first.every(q => !q.isExecutable && q.quoteSource === 'BENCHMARK_CATALOG'));
  assert.equal(first[0].retrievedAt, second[0].retrievedAt);
  const result = gpuArbitrageService.evaluateSpread({ buyQuote: first[0], sellCounterpartyName: 'Hypothetical', sellRegion: 'x', sellRatePerHour: 3 });
  assert.equal(result.isExecutable, false);
  assert.equal(result.realisedProfitUsd, 0);
  const forged = gpuArbitrageService.evaluateSpread({ buyQuote: { ...first[0], quoteSource: 'LIVE_API', isExecutable: true, retrievedAt: new Date().toISOString() }, sellCounterpartyName: 'Unverified buyer', sellRegion: 'x', sellRatePerHour: 3 });
  assert.equal(forged.isExecutable, false);
  assert.throws(() => gpuArbitrageService.evaluateSpread({ buyQuote: first[0], sellCounterpartyName: 'x', sellRegion: 'x', sellRatePerHour: Infinity }));
});
const baseEntry = { idempotencyKey: 'test-one', type: 'CUSTOMER_INVOICE_RECEIPT' as const, accountType: 'SPOT' as const, asset: 'USD', amount: 20, debitCredit: 'CREDIT' as const, provider: 'BINANCE' as const, isSimulated: true };
test('Invalid amounts and conflicting idempotency payloads are rejected', () => {
  assert.throws(() => financialLedger.createTransaction({ ...baseEntry, amount: NaN }));
  assert.throws(() => financialLedger.createTransaction({ ...baseEntry, fee: -1 }));
  const first = financialLedger.createTransaction(baseEntry);
  assert.equal(financialLedger.createTransaction(baseEntry).id, first.id);
  assert.throws(() => financialLedger.createTransaction({ ...baseEntry, amount: 21 }), /conflicts/);
});
test('Sandbox confirmations never count as actual revenue', () => {
  const entry = financialLedger.createTransaction({ ...baseEntry, idempotencyKey: 'sandbox-receipt' });
  financialLedger.transitionState(entry.id, 'CONFIRMED', {});
  assert.equal(financialLedger.getCFOBreakdown().metrics.revenueMetrics.realisedRevenueUsd, 0);
});
test('Live confirmation requires provider evidence, and actual losses stay negative', () => {
  const entry = financialLedger.createTransaction({ ...baseEntry, idempotencyKey: 'actual-cost', type: 'COMPUTE_LEASE_PAYMENT', debitCredit: 'DEBIT', amount: 25, isSimulated: false });
  assert.throws(() => financialLedger.transitionState(entry.id, 'CONFIRMED', {}), /provider/);
  financialLedger.transitionState(entry.id, 'CONFIRMED', { providerTransactionId: 'test-provider-cost', verificationStatus: 'VERIFIED' });
  assert.equal(financialLedger.getCFOBreakdown().metrics.revenueMetrics.realisedProfitUsd, -25);
});
test('A manual payment reference cannot mark an invoice paid', () => {
  process.env.USD_ZAR_RATE = '18';
  const lead = customerRevenueService.createProspectLead({ name: 'Test', company: 'Test', email: 'test@example.invalid', targetGpuModel: 'GPU', nodeCount: 1, durationHours: 1, quotedRatePerHourUsd: 10 });
  const invoice = customerRevenueService.generateInvoice({ customerProspectId: lead.id });
  assert.equal(invoice.status, 'DRAFT');
  assert.throws(() => customerRevenueService.recordInvoicePayment({ invoiceId: invoice.invoiceId, paymentMethod: 'WIRE_TRANSFER', paymentReferenceId: 'invented', amountPaid: 10, currency: 'USD' }), /independently verified/);
  assert.equal(customerRevenueService.getSummary().totalCollectedRevenueUsd, 0);
});
test('Unintegrated payment webhooks and checkout cannot create money', async () => {
  const before = financialLedger.getAllEntries().length;
  const result = await paymentsService.handlePayFastITN({} as any);
  assert.equal(result.valid, false);
  assert.throws(() => paymentsService.createPayFastPayment({} as any), /adapter/);
  assert.equal(financialLedger.getAllEntries().length, before);
});
test('Missing Groq key returns an error and never a fabricated response', async () => {
  assert.equal(groqAiService.getStatus().status, 'OFFLINE');
  await assert.rejects(() => groqAiService.queryCopilot([{ role: 'user', content: 'hello' }]), /not configured/);
});
test('Secrets are removed recursively from state and snapshots', () => {
  assert.deepEqual(redact({ bridgeToken: 'secret', nested: { apiKey: 'secret', normal: 2 }, snapshots: [{ password: 'secret' }] }), { nested: { normal: 2 }, snapshots: [{}] });
});
test('Clock time does not mint profit or deploy seeded contracts/workers', () => {
  assert.equal(computeContractAccruedPnL({ startTime: 1, durationHours: 10000, netSpreadPerHour: 1000, nodeCount: 100 }), 0);
  assert.equal(INITIAL_ACTIVE_CONTRACTS.length, 0);
  assert.equal(generateInitialFleetWorkers().length, 0);
});
test('Disk commit failure rolls back in-memory financial transactions', () => {
  const original = process.env.APP_DATA_DIR!;
  const dataPath = path.join(original, 'financial_ledger.json');
  const tempPath = dataPath + '.tmp';
  fs.mkdirSync(tempPath);
  const count = financialLedger.getAllEntries().length;
  assert.throws(() => financialLedger.createTransaction({ ...baseEntry, idempotencyKey: 'must-not-commit' }), /persistence failed/);
  assert.equal(financialLedger.getAllEntries().length, count);
  fs.rmdirSync(tempPath);
});
