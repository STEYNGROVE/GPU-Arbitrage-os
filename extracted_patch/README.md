# GPU Compute Arbitrage OS — blocker repair

This version is an authenticated operations dashboard and scenario calculator. It does not establish an autonomous income business. Live provider orders, customer acceptance and financial settlement are blocked until real adapters and independent evidence exist.

## Start locally

Requires Node.js 22.12 or newer (Node.js 24 recommended).

```bash
npm ci
node scripts/setup-local.mjs
npm run dev
```

Open `http://localhost:3000`. Open the newly generated `.env` privately and enter its `OWNER_API_KEY` in the sign-in screen. `API_AUTH_TOKEN` allows API reads; mutations require an owner key. The setup script generates independent secrets and never prints them. It refuses to overwrite an existing `.env`.

The browser holds its access key only in memory. Refreshing signs you out. Use a separate browser tab rather than pasting secrets into chat, source code or URLs.

The local dashboard can start without PostgreSQL or external service keys. Their status remains unavailable. Local mode does not create fictional contracts, balances, workers or revenue.

## Credential spaces

Edit `.env` or the hosting platform's server-side secrets:

| Name | Purpose |
| --- | --- |
| `API_AUTH_TOKEN` | Operator read access; at least 32 characters |
| `OWNER_API_KEY` | Owner mutations; independent secret |
| `OWNER_OVERRIDE_KEY` | Independent recovery credential |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | PostgreSQL connection |
| `GROQ_API_KEY`, `GROQ_PRIMARY_MODEL` | Advisory AI; a successful response is required for connected status |
| `BINANCE_API_KEY`, `BINANCE_SECRET_KEY` | Authenticated account reads; use read-only permissions |
| `RUNPOD_API_KEY` | Existing provider credit verification adapter |
| `LIGHTNING_AI_API_KEY` | Existing provider verification adapter; endpoint compatibility needs live validation |
| `VAST_AI_API_KEY` | Reserved configuration; live quote/order adapter is not implemented |
| `APP_DATA_DIR` | Optional absolute directory for mutable runtime files |

The AI & connections tab accepts Groq, RunPod and Lightning AI keys over the authenticated session. These overrides stay in server process memory and are lost at restart. Deployment secrets are the persistent route. No real service key is included in this archive.

## Validation

```bash
npm test
npm run lint
npm run build
npm run security:check
npm audit
```

The `lint` command performs TypeScript checking. Tests use temporary data directories and local HTTP servers; they do not contact exchanges or move funds.

## Container deployment

The ZIP now includes the missing Dockerfile and a matching npm lockfile. Configure `.env` with production mode, four independent strong production secrets, database details and the correct application URL. Then:

```bash
docker compose -f docker-compose.prod.yml up --build -d
```

Compose keeps PostgreSQL private and stores mutable app data in a volume. Its proxy listens on HTTP port 80. Use a real HTTPS ingress before external access; this ZIP does not contain TLS certificates or an HTTPS listener. The proxy overwrites incoming forwarding headers, and the app trusts only its configured proxy subnet. Adjust the subnet if it conflicts with your network.

`/api/health` is public HTTP liveness. Authenticated `/api/readiness` returns 503 while business execution requirements remain unmet. A healthy container does not certify an operational money-making business.

Docker itself was unavailable in the repair environment, so container startup and real PostgreSQL migrations were not tested. Compose YAML parsing passed. Browser automation was unavailable because the Chromium download failed; no browser UI pass is claimed.

See `BLOCKER_REPAIR_REPORT.md` for the verified changes, test results and remaining release gates.
