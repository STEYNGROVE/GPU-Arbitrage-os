# Security and financial-integrity repair notes

This patch prioritizes fail-closed behavior. It is not a declaration of production readiness.

## Changes in this repair

- Removed known fixed bridge/auth tokens and embedded database credentials from tracked source/configuration.
- Production mode now refuses to start without independent, strong API, owner and database secrets.
- Owner-only authorization protects IP-whitelist and bridge mutation endpoints; mutating API calls are rate-limited and authenticated.
- Bridge credentials are never returned by settings/status endpoints.
- Benchmark GPU quotes are explicitly non-executable until a provider supplies verified live pricing/availability.
- Ledger transactions reject invalid amounts and fees; failed disk persistence throws rather than silently reporting a durable write.
- PayFast notifications fail closed if provider-side validation cannot be reached.
- Removed the fixed USD/ZAR conversion assumption; conversion requires an explicitly configured rate.
- Added a production Dockerfile and removed public host port publication for PostgreSQL.
- Added `npm run security:check` for a small static regression check.

## Required before any live use

1. Generate independent secrets of at least 32 characters and place them only in deployment secrets / `.env` (never Git).
2. Rotate every credential that has ever been committed or shared.
3. Add a proper authenticated owner session/token-entry flow for the UI; do not restore secrets in browser code.
4. Move financial ledger writes to PostgreSQL transactions with durable idempotency constraints and tamper-evident audit history.
5. Verify PayFast notification amount/currency/invoice matching, merchant ID, replay behavior and successful provider validation in staging.
6. Implement and test official live provider quote/order adapters; a quote is executable only after freshness, availability, customer contract and full costs are verified.
7. Verify Binance account reads and GoTyme payout integration with provider-issued credentials and a controlled, approved test transaction.
8. Run dependency installation, TypeScript checks, build, integration tests, Docker Compose validation and a staging deployment. These were not completed in this environment because dependency installation timed out.

No balance, revenue, payment, provider availability or withdrawal is certified by these source changes.
