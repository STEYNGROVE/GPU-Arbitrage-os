# GPU Compute Arbitrage OS — deployment without GitHub

This package fixes a malformed PostgreSQL migration and improves connection diagnostics. It does not enable real compute workers, trading, or payouts.

## Render configuration

The existing Render web service currently deploys from GitHub. Render connector tools cannot directly upload this ZIP to that service. A new deployment source (such as a container image registry) or a manual Render-supported source migration is required. Do not click **Manual Deploy** expecting this ZIP to be deployed; it redeploys the existing source.

Keep `SYSTEM_OPERATING_MODE=SIMULATION`, `PAYFAST_SANDBOX=true`, and `GOTYME_SANDBOX=true`.

On the **web service**, configure `PGHOST` using the **Internal Database Hostname** from the existing Render PostgreSQL instance, `PGPORT=5432`, `PGDATABASE=willem_steyn_grove`, `PGUSER=willem_steyn_grove_user`, and `PGPASSWORD` from the database dashboard. Do not paste passwords into chat. For internal Render connections, leave `PGSSLMODE` unset unless your provider specifically requires TLS.

When the corrected code is deployed, verify startup logs show successful PostgreSQL migration and inspect the database for actual tables. A successful build alone does not prove the database is connected.

## Local validation

Run `npm ci`, `npm run lint`, `npm run security:check`, `npm test`, and `npm run build` in this directory.

## Caution

The free Render PostgreSQL database is currently scheduled to expire 2026-11-27; arrange backups/migration before that date.
