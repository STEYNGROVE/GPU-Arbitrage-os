# Reality audit and deployment notes

- Fixed the institutional audit payload to stop reporting 150 running agents when no live execution adapter exists. The fleet is reported as NOT_RUNNING until real worker telemetry is implemented.
- GitHub sync verification now requires a configured token and SYNCED state; inspect actual GitHub sync health before relying on it.
- PostgreSQL is configured using environment variables, not secrets bundled in this ZIP. The deployed Render database was separately observed to contain 38 tables across five schemas on 2026-11-03; runtime counts may change.
- Binance sandbox status is not proof of real funds, authenticated withdrawals, or profits. Do not enable treasury withdrawals based on simulated status.
- Live GPU worker execution is not implemented by this patch. Execution requires funded provider accounts, scoped credentials, verified worker APIs, and safeguards for spend.
- This ZIP is a source patch, not a guarantee of production readiness. Verify `npm install`, `npm run lint`, `npm test`, `npm run build`, and deployment logs.
