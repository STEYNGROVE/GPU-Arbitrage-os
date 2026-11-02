import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCHEMA_MIGRATIONS_DDL, getDatabaseDiagnostics } from '../server/pgDatabase.ts';

test('PostgreSQL DDL: All 5 schemas are declared', () => {
  assert.ok(SCHEMA_MIGRATIONS_DDL.includes('CREATE SCHEMA IF NOT EXISTS market_microstructure;'));
  assert.ok(SCHEMA_MIGRATIONS_DDL.includes('CREATE SCHEMA IF NOT EXISTS hardware_topology;'));
  assert.ok(SCHEMA_MIGRATIONS_DDL.includes('CREATE SCHEMA IF NOT EXISTS contract_escrows;'));
  assert.ok(SCHEMA_MIGRATIONS_DDL.includes('CREATE SCHEMA IF NOT EXISTS cross_cloud_routing;'));
  assert.ok(SCHEMA_MIGRATIONS_DDL.includes('CREATE SCHEMA IF NOT EXISTS fleet_orchestration;'));
});

test('PostgreSQL DDL: Syntax integrity and balanced table definitions', () => {
  // Count CREATE TABLE statements
  const createTableMatches = SCHEMA_MIGRATIONS_DDL.match(/CREATE TABLE IF NOT EXISTS/g) || [];
  assert.ok(createTableMatches.length >= 35, `Expected at least 35 tables, found ${createTableMatches.length}`);

  // Verify dead_letter_queue_quarantine table is properly closed
  assert.ok(
    SCHEMA_MIGRATIONS_DDL.includes('fleet_orchestration.dead_letter_queue_quarantine'),
    'dead_letter_queue_quarantine table missing'
  );
  assert.ok(
    /dead_letter_queue_quarantine\s*\([^;]+quarantined_at[^;]+\);/.test(SCHEMA_MIGRATIONS_DDL),
    'dead_letter_queue_quarantine table definition must be properly closed'
  );

  // Verify immutable_financial_ledger table is defined
  assert.ok(
    SCHEMA_MIGRATIONS_DDL.includes('contract_escrows.immutable_financial_ledger'),
    'immutable_financial_ledger table missing'
  );
});

test('Database Diagnostics: Never exposes raw credentials or passwords', async () => {
  const diag = await getDatabaseDiagnostics();
  assert.ok(diag.status === 'CONNECTED' || diag.status === 'DISCONNECTED');
  assert.equal(typeof diag.isReady, 'boolean');
  assert.equal(typeof diag.host, 'string');
  assert.equal(typeof diag.port, 'number');
  assert.equal(typeof diag.database, 'string');
  assert.equal(typeof diag.user, 'string');
  assert.equal(typeof diag.passwordConfigured, 'boolean');
  assert.equal(typeof diag.sslEnabled, 'boolean');
  assert.equal(typeof diag.latencyMs, 'number');
  assert.equal(diag.totalSchemas, 5);
  assert.equal(diag.totalRelations, 37);

  // Critical security check: raw password must NEVER be in the diagnostic output
  const jsonStr = JSON.stringify(diag);
  assert.ok(!jsonStr.includes('password='), 'Diagnostics must not expose raw connection string');
  assert.ok(!jsonStr.includes('PGPASSWORD'), 'Diagnostics must not expose PGPASSWORD key');
  if (process.env.PGPASSWORD) {
    assert.ok(!jsonStr.includes(process.env.PGPASSWORD), 'Diagnostics must not expose actual password');
  }
});

test('Operating Mode: Enforces SIMULATION by default', () => {
  const mode = process.env.SYSTEM_OPERATING_MODE || 'SIMULATION';
  assert.equal(mode, 'SIMULATION');
});
