# Customer Acquisition — conservative first release

This candidate restores a missing `server.ts` entrypoint from an earlier repository snapshot and wires the hardened commercial intake and a new evidence-backed lead-discovery API. **Not deployed or end-to-end tested.** Validate against latest GitHub `server.ts` before merging; the historical entrypoint may differ.

Set `LEAD_RSS_FEEDS` to a comma-separated list of up to five trusted public HTTPS RSS/Atom feeds; leave blank to disable discovery. Run `POST /api/acquisition/discover` with owner authentication to discover and deduplicate public demand signals into PostgreSQL. Read with `GET /api/acquisition/leads`. Owner can mark leads REVIEWING, QUALIFIED or REJECTED via PATCH. Leads are candidates, never customers. No unsolicited outreach, spending, provisioning or payments.

Security: feeds must be curated; URL validation is only a first line of defense, and production egress restrictions and DNS rebinding protections should be added before enabling arbitrary feed configuration. Do not expose the scan endpoint publicly. Do not schedule unattended execution until tests pass.

Deployment blockers: GitHub write integration currently returns 403; no push or Render deploy was performed. This archive is a development candidate, not a production-certified release.
