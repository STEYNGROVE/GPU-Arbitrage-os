# Blocker repair report

Reviewed attachment: gpu-compute-arbitrage-os-v13 (9).zip.
Repair date: 27 October 2026, South Africa.

## Result

The source installs, typechecks, builds and passes 17 automated tests. It now exposes an authenticated dashboard with honest dependency states and a profit scenario calculator. It is not commercially production-ready, and this repair did not deploy it or perform a live transaction.

The original dashboard contained local-only execution, elapsed-time profit accrual, fixed account claims and unverified transfer destinations. Those screens were replaced with evidence-focused views: Overview, Quotes, Treasury, Calculator, AI & connections, System and Logs. Retired component source and the nested older app ZIP were removed from this repaired package. The original uploaded version remains available through version history.

## Blockers fixed

| Finding | Repair |
| --- | --- |
| npm install failed on the root esbuild version versus Vite's peer requirement | Removed the unused root esbuild pin; generated package-lock.json; npm install succeeded without force or legacy-peer-deps |
| Compose referenced an absent Dockerfile | Added Dockerfile and .dockerignore; fixed the production start command to use the TypeScript loader |
| Healthcheck targeted a protected AI route | Healthcheck now uses public HTTP liveness |
| Published port 443 had no TLS listener/certificate | Removed the misleading port mapping; documented real HTTPS ingress as required |
| API routes did not mount their authorization middleware | Authenticated all API routes except liveness; owner checks protect mutations |
| Browser-controlled origin, hostname and forwarded IP could be treated as identity | Removed origin/Host shortcuts; direct forwarding headers are ignored unless an explicit proxy chain is trusted |
| IP guard automatically trusted unknown clients and had built-in cloud exceptions | Removed implicit trust, broad IP exceptions and default auto-whitelisting |
| Bridge endpoint returned owner/bridge secrets and allowed credential replacement | Removed secret readback and runtime owner-key reassignment; configure independent server secrets instead |
| Browser had no working credential entry path | Added a masked sign-in form and a same-origin API wrapper with memory-only access keys |
| Saved browser state could alter financial/security state | Save endpoint accepts only UI preferences; restore/import flows are blocked; legacy balance hydration is retired |
| Fixed prices were stamped with the refresh time | Quotes now have no verified retrieval date, no established availability and are always non-executable |
| Caller-supplied quote flags could imply execution permission | Spread evaluation cannot make any supplied quote executable |
| Seeded customers, contracts, balances, workers and logs looked operational | Removed active-state seeds and initialization examples from the deployed dashboard |
| Profit rose simply as clock time elapsed | Retired clock-derived profit and fabricated settlement; calculator results remain estimates |
| Borrow, sweep and deposit operations could mutate local balances without settlement | Blocked unsupported endpoints and internal movement methods; no optimistic balance updates |
| Reconciliation forced matching balances and default addresses were treated as verified | Retired automatic capital correction and verified-vault seeds; no destination is displayed as provider-verified |
| Groq status and fallback text could claim live AI without a response | Configured-unverified/offline states; real response required; measured latency, five-minute status expiry and explicit errors; no fabricated fallback |
| Manual invoice payment marker could establish collected revenue | Requires a matching independently confirmed, non-simulated ledger receipt; new invoices are drafts |
| Payment checkout/webhook had incomplete invoice and provider verification | Kept these flows unavailable until a durable verified invoice adapter exists; they cannot credit funds |
| Simulated ledger entries counted as actual revenue; losses were clamped to zero | Excluded simulated/unverified confirmations and preserved negative results; removed arbitrary revenue growth multiplier |
| Ledger accepted invalid inputs and swallowed write errors | Finite positive amount/fee validation, idempotency payload checks, atomic file replacement and rollback on failed commits |
| Provider funding and absent credit balances were assumed | Missing keys/balances remain unverified; failed reads do not turn a missing amount into a verified zero |
| Compute credits were added to liquid exchange cash | Kept provider credits separate from cash |
| Background source publishing was enabled automatically | Disabled background publishing and blocked legacy sync/config mutations |
| Legacy purge script reintroduced fictional balances and persisted secrets | Retired script with an explicit failure message |
| Unknown API paths returned the SPA page | Return JSON 404 instead |

## Checks actually performed

- Dependency installation: passed, 212 packages installed at the time of verification.
- TypeScript: `npm run lint` passed.
- Frontend bundle: `npm run build` passed.
- Static security checks: `npm run security:check` passed. These are limited regression checks, not a full security certification.
- Automated tests: 17 passed, 0 failed. Coverage includes authorization, owner permissions, quote flags, missing Groq configuration, payment rejection, simulated revenue exclusion, real losses, idempotency conflicts, disk-write rollback, recursive redaction and full local HTTP startup/API behavior.
- npm audit: 0 advisories reported at the time of the check. This does not establish absence of all vulnerabilities.
- Compose YAML: parsed successfully with Python YAML.
- Tests used generated ephemeral credentials and temporary data directories. No funds were moved and no customers were contacted.

## Not validated

- Browser UI: Playwright was present, but its browser binary was absent and the Chromium download failed. No visual/interaction pass is claimed.
- Docker image build, Nginx runtime and real PostgreSQL migrations: Docker/PostgreSQL executables were unavailable. Tests deliberately exercise an unavailable database state.
- Groq, Binance, RunPod, Lightning AI and other provider endpoints: no actual customer credentials were supplied or used. API compatibility and permissions still need live verification.
- Customer acquisition, GPU provisioning, completed workloads, payment settlement, withdrawals and bank receipts: not demonstrated.

## Remaining business release gates

1. Implement one real GPU quote and order adapter, including fresh capacity checks, provider job ID, cancellation and usage evidence.
2. Implement a real customer acceptance/order pipeline. A higher price on another provider is not proof of a willing buyer or a right to resell capacity.
3. Move money-related records and invoice matching into transactional database storage with enforced unique references, durable state transitions and crash/replay recovery. Atomic JSON files are an interim single-process store, not settlement infrastructure.
4. Integrate provider-verified payments against invoice amount, currency, account and unique transaction ID. Configure the correct South African payout provider; no bank API capability is established by a partner ID or proof-of-account document.
5. Run staging with HTTPS, real database migrations, service-issued read credentials and controlled end-to-end jobs/payment tests before enabling financial writes.

Readiness intentionally returns 503 until these gates are implemented and independently evidenced. Merely adding credentials does not remove the missing business adapters.
