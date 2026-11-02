# Render deployment and verification

This source package is not automatically deployed. Upload or commit the source through a supported Render deployment source; do not assume a Render API key can upload a ZIP to a Git-backed service.

## Existing Render PostgreSQL
In the **web service** Environment settings, set PGHOST to the **internal hostname only**, PGPORT=5432, PGDATABASE to the exact Render database name, PGUSER to the exact database user, and PGPASSWORD to the current database password. Keep credentials out of source control. Use PGSSLMODE=require only for a server that supports TLS and has a trusted certificate. Never set NODE_TLS_REJECT_UNAUTHORIZED=0.

Keep SYSTEM_OPERATING_MODE=SIMULATION, PAYFAST_SANDBOX=true and GOTYME_SANDBOX=true. Do not enable live paid GPU provisioning, trading or payouts.

After deployment inspect Render logs for successful database migration, then verify the actual PostgreSQL schemas/tables in the database dashboard. A live HTTP website is not proof of database connectivity.

The existing Render free PostgreSQL instance is scheduled to expire on 2026-11-27 unless changed; plan migration/backups.

## Local verification
Run `npm ci`, `npm run lint`, `npm run security:check`, `npm test`, `npm run build`. Any failed step must be resolved before production.
