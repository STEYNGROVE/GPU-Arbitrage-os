import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VerifiedOpportunityEngine } from '../server/verifiedOpportunityEngine.ts';

const source = {
  sourceUrl: 'https://example.org/jobs/123',
  sourceName: 'Example listing',
  observedAt: '2026-10-29T08:00:00Z',
  title: 'GPU job',
  description: 'Public opportunity',
  advertisedBudgetUsd: 200
};

test('deduplicates real-source listings', () => {
  const e = new VerifiedOpportunityEngine();
  assert.equal(e.ingest(source).id, e.ingest(source).id);
});

test('budget is never funding evidence', () => {
  const e = new VerifiedOpportunityEngine();
  const r = e.ingest(source);
  assert.equal(r.state, 'DISCOVERED');
  assert.throws(() => e.transition(r.id, 'FUNDED', { verifiedPaymentReference: 'any' }));
});

test('funding and provider quote required before execution', () => {
  const e = new VerifiedOpportunityEngine();
  const r = e.ingest(source);
  e.transition(r.id, 'QUALIFIED');
  e.transition(r.id, 'ORDERED', { customerOrderId: 'order-1' });
  assert.throws(() => e.transition(r.id, 'FUNDED'));
  e.transition(r.id, 'FUNDED', { verifiedPaymentReference: 'verified-receipt-1' });
  assert.throws(() => e.transition(r.id, 'EXECUTING', { verifiedProviderQuoteId: 'quote-1', estimatedProviderCostUsd: 100, estimatedMarginUsd: 0 }));
  assert.equal(e.transition(r.id, 'EXECUTING', { verifiedProviderQuoteId: 'quote-1', estimatedProviderCostUsd: 100, estimatedMarginUsd: 50 }).state, 'EXECUTING');
});

test('rejects insecure sources and negative budgets', () => {
  const e = new VerifiedOpportunityEngine();
  assert.throws(() => e.ingest({ ...source, sourceUrl: 'http://example.org' }));
  assert.throws(() => e.ingest({ ...source, advertisedBudgetUsd: -1 }));
});
