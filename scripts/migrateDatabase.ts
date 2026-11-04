import '../server/bootstrap.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pgDbService } from '../server/pgDatabase.js';

/**
 * Offline / CI Versioned PostgreSQL Migration Runner.
 * CRITICAL PRODUCTION POLICY:
 * Schema migrations (CREATE TABLE, ALTER TABLE, ADD CONSTRAINT, DROP CONSTRAINT, ALTER COLUMN)
 * are executed EXCLUSIVELY via this versioned migration script (`npm run db:migrate`)
 * and NEVER during application startup or runtime.
 */
async function runVersionedMigrations() {
  console.log('=== GPU Compute Arbitrage OS — Versioned PostgreSQL Migration Runner ===');
  const initRes = await pgDbService.initialize({ skipSchemaCheck: true });
  if (!pgDbService.isLiveDatabaseConnected()) {
    console.error(`[MIGRATE] Cannot connect to PostgreSQL: ${initRes.error || 'Disconnected'}`);
    process.exit(1);
  }

  const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const client = await pgDbService.getClient();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(64) PRIMARY KEY,
        checksum VARCHAR(128) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      const checksum = crypto.createHash('sha256').update(sql.trim()).digest('hex');

      const existing = await client.query(
        'SELECT version, checksum FROM schema_migrations WHERE version = $1',
        [version]
      );

      if (existing.rows.length === 0) {
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            'INSERT INTO schema_migrations (version, checksum, applied_at) VALUES ($1, $2, NOW())',
            [version, checksum]
          );
          await client.query('COMMIT');
          console.log(`[MIGRATE] Applied migration ${version} (checksum: ${checksum.substring(0, 12)}...)`);
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      } else {
        const storedChecksum = String(existing.rows[0].checksum || '').trim();
        if (storedChecksum !== checksum) {
          throw new Error(
            `MIGRATION_INTEGRITY_FAILURE: Applied financial migration '${version}' checksum mismatch! Stored checksum (${storedChecksum}) !== current file checksum (${checksum}). Modifying already-applied financial migrations is forbidden; startup and deployment refused.`
          );
        }
        console.log(`[MIGRATE] Verified already applied migration: ${version} (checksum match: ${checksum.substring(0, 12)}...)`);
      }
    }
    console.log('=== All versioned PostgreSQL migrations verified and up to date ===');
    process.exit(0);
  } finally {
    client.release();
  }
}

runVersionedMigrations().catch(err => {
  console.error('[MIGRATE FATAL]:', err);
  process.exit(1);
});
