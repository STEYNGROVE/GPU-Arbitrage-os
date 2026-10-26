import pg from 'pg';
const { Pool } = pg;

export interface MigrationResult {
  success: boolean;
  database: string;
  relationsMigrated: number;
  totalSchemas: number;
  appliedAt: string;
  executionTimeMs: number;
  tables: Array<{ schema: string; table: string; status: string }>;
  error?: string;
}

// Global pool instance to prevent connection leaks across reload
let poolInstance: pg.Pool | null = null;

export function getPgPool(): pg.Pool {
  if (!poolInstance) {
    const host = process.env.PGHOST || 'localhost';
    const port = Number(process.env.PGPORT) || 5432;
    const database = process.env.PGDATABASE || 'arbitrage_v13';
    const user = process.env.PGUSER || 'postgres';
    const password = process.env.PGPASSWORD || process.env.DB_PASSWORD || 'your_secure_password';

    poolInstance = new Pool({
      host,
      port,
      database,
      user,
      password,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    poolInstance.on('error', (err) => {
      console.warn('[PostgreSQL Pool Warning]', err.message);
    });
  }
  return poolInstance;
}

// 36 Schemas and Relations DDL Definitions for PostgreSQL arbitrage_v13
export const SCHEMA_MIGRATIONS_DDL = `
-- 1. Create Core Schemas
CREATE SCHEMA IF NOT EXISTS market_microstructure;
CREATE SCHEMA IF NOT EXISTS hardware_topology;
CREATE SCHEMA IF NOT EXISTS contract_escrows;
CREATE SCHEMA IF NOT EXISTS cross_cloud_routing;
CREATE SCHEMA IF NOT EXISTS fleet_orchestration;

-- 2. market_microstructure Relations (6 tables)
CREATE TABLE IF NOT EXISTS market_microstructure.raw_spot_ticks_partitioned (
  id BIGSERIAL,
  provider_id VARCHAR(64) NOT NULL,
  gpu_model VARCHAR(64) NOT NULL,
  spot_bid_usd NUMERIC(10, 4) NOT NULL,
  spot_ask_usd NUMERIC(10, 4) NOT NULL,
  available_nodes INT DEFAULT 1,
  recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);

CREATE TABLE IF NOT EXISTS market_microstructure.raw_spot_ticks_default
  PARTITION OF market_microstructure.raw_spot_ticks_partitioned DEFAULT;

CREATE TABLE IF NOT EXISTS market_microstructure.orderbook_bids_snapshot (
  bid_id VARCHAR(64) PRIMARY KEY,
  buyer_entity VARCHAR(128) NOT NULL,
  gpu_silicon VARCHAR(64) NOT NULL,
  max_price_per_hr NUMERIC(10, 4) NOT NULL,
  required_nodes INT NOT NULL,
  min_duration_hours INT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_microstructure.orderbook_asks_snapshot (
  ask_id VARCHAR(64) PRIMARY KEY,
  provider_name VARCHAR(128) NOT NULL,
  gpu_silicon VARCHAR(64) NOT NULL,
  spot_rate_per_hr NUMERIC(10, 4) NOT NULL,
  region VARCHAR(64) NOT NULL,
  preemption_risk VARCHAR(32) DEFAULT 'LOW',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_microstructure.spread_arbitrage_candidates (
  candidate_id VARCHAR(64) PRIMARY KEY,
  gpu_silicon VARCHAR(64) NOT NULL,
  buy_provider VARCHAR(64) NOT NULL,
  sell_counterparty VARCHAR(128) NOT NULL,
  gross_spread_per_hr NUMERIC(10, 4) NOT NULL,
  net_spread_per_hr NUMERIC(10, 4) NOT NULL,
  annualized_apr NUMERIC(10, 2) NOT NULL,
  status VARCHAR(32) DEFAULT 'DISCOVERED',
  discovered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_microstructure.historical_volatility_bands (
  gpu_silicon VARCHAR(64) PRIMARY KEY,
  twap_24h NUMERIC(10, 4) NOT NULL,
  realized_volatility NUMERIC(8, 4) NOT NULL,
  spread_z_score NUMERIC(6, 2) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_microstructure.synthetic_derivative_curves (
  curve_id VARCHAR(64) PRIMARY KEY,
  underlying_gpu VARCHAR(64) NOT NULL,
  term_days INT NOT NULL,
  implied_compute_rate NUMERIC(10, 4) NOT NULL,
  basis_differential NUMERIC(10, 4) NOT NULL,
  calculated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. hardware_topology Relations (6 tables)
CREATE TABLE IF NOT EXISTS hardware_topology.gpu_silicon_specs (
  silicon_id VARCHAR(64) PRIMARY KEY,
  brand VARCHAR(32) NOT NULL,
  model_name VARCHAR(128) NOT NULL,
  architecture VARCHAR(64) NOT NULL,
  vram_gb INT NOT NULL,
  memory_bandwidth_tb NUMERIC(6, 2) NOT NULL,
  fp16_tflops INT NOT NULL,
  tdp_watts INT NOT NULL,
  interconnect VARCHAR(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS hardware_topology.pcie_nvlink_matrix (
  id SERIAL PRIMARY KEY,
  source_node VARCHAR(64) NOT NULL,
  gpu_a INT NOT NULL,
  gpu_b INT NOT NULL,
  nvlink_gen INT NOT NULL,
  bi_bandwidth_gb_s INT NOT NULL
);

CREATE TABLE IF NOT EXISTS hardware_topology.numa_node_affinities (
  id SERIAL PRIMARY KEY,
  server_uuid VARCHAR(64) NOT NULL,
  numa_socket INT NOT NULL,
  pcie_root_port VARCHAR(64) NOT NULL,
  cpu_cores_pinned VARCHAR(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS hardware_topology.infiniband_roce_interfaces (
  hca_id VARCHAR(64) PRIMARY KEY,
  adapter_type VARCHAR(64) NOT NULL,
  speed_gbps INT NOT NULL,
  lossless_pfc_enabled BOOLEAN DEFAULT TRUE,
  ecn_marking_enabled BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS hardware_topology.datacenter_pue_thermal_logs (
  log_id BIGSERIAL PRIMARY KEY,
  datacenter_code VARCHAR(32) NOT NULL,
  cooling_type VARCHAR(64) NOT NULL,
  pue_factor NUMERIC(4, 2) NOT NULL,
  rack_inlet_celsius NUMERIC(5, 2) NOT NULL,
  recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hardware_topology.power_grid_marginal_emissions (
  grid_iso_code VARCHAR(32) PRIMARY KEY,
  region_name VARCHAR(64) NOT NULL,
  power_tariff_per_kwh NUMERIC(6, 4) NOT NULL,
  clean_energy_percentage NUMERIC(5, 2) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. contract_escrows Relations (6 tables)
CREATE TABLE IF NOT EXISTS contract_escrows.active_leases_ledger (
  contract_id VARCHAR(64) PRIMARY KEY,
  gpu_silicon VARCHAR(64) NOT NULL,
  node_count INT NOT NULL,
  buy_provider VARCHAR(64) NOT NULL,
  sell_counterparty VARCHAR(128) NOT NULL,
  net_hourly_spread NUMERIC(10, 4) NOT NULL,
  accrued_pnl_usd NUMERIC(12, 2) DEFAULT 0.00,
  lease_status VARCHAR(32) DEFAULT 'ACTIVE_ROUTING',
  start_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  duration_hours INT NOT NULL,
  auto_renew BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS contract_escrows.escrow_smart_locks (
  escrow_id VARCHAR(64) PRIMARY KEY,
  contract_id VARCHAR(64) REFERENCES contract_escrows.active_leases_ledger(contract_id) ON DELETE CASCADE,
  locked_capital_usd NUMERIC(12, 2) NOT NULL,
  collateral_source VARCHAR(64) DEFAULT 'BINANCE_MARGIN',
  locked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  settlement_status VARCHAR(32) DEFAULT 'LOCKED'
);

CREATE TABLE IF NOT EXISTS contract_escrows.slas_uptime_audit_pings (
  ping_id BIGSERIAL PRIMARY KEY,
  contract_id VARCHAR(64) NOT NULL,
  response_time_ms NUMERIC(6, 2) NOT NULL,
  packet_loss_pct NUMERIC(5, 2) DEFAULT 0.00,
  sla_breached BOOLEAN DEFAULT FALSE,
  pinged_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contract_escrows.preemption_hedge_positions (
  hedge_id VARCHAR(64) PRIMARY KEY,
  contract_id VARCHAR(64) NOT NULL,
  standby_provider VARCHAR(64) NOT NULL,
  hot_standby_node_id VARCHAR(64) NOT NULL,
  failover_latency_sec NUMERIC(4, 2) DEFAULT 1.2
);

CREATE TABLE IF NOT EXISTS contract_escrows.settlement_pnl_records (
  settlement_id VARCHAR(64) PRIMARY KEY,
  contract_id VARCHAR(64) NOT NULL,
  settled_profit_usd NUMERIC(12, 2) NOT NULL,
  destination_account VARCHAR(64) NOT NULL,
  settled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contract_escrows.counterparty_reputation_scores (
  counterparty_id VARCHAR(64) PRIMARY KEY,
  display_name VARCHAR(128) NOT NULL,
  reputation_score INT DEFAULT 100,
  total_volume_settled_usd NUMERIC(14, 2) DEFAULT 0.00,
  default_rate_pct NUMERIC(5, 2) DEFAULT 0.00
);

-- 5. cross_cloud_routing Relations (6 tables)
CREATE TABLE IF NOT EXISTS cross_cloud_routing.datacenter_rtt_latencies (
  route_id VARCHAR(64) PRIMARY KEY,
  source_region VARCHAR(64) NOT NULL,
  dest_region VARCHAR(64) NOT NULL,
  mean_rtt_ms NUMERIC(6, 2) NOT NULL,
  jitter_ms NUMERIC(5, 2) NOT NULL,
  tested_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cross_cloud_routing.packet_jitter_sdn_routes (
  sdn_id VARCHAR(64) PRIMARY KEY,
  source_asn INT NOT NULL,
  target_asn INT NOT NULL,
  optimal_hops INT NOT NULL,
  packet_drop_rate NUMERIC(6, 4) DEFAULT 0.0001
);

CREATE TABLE IF NOT EXISTS cross_cloud_routing.bgp_asn_interconnects (
  asn_id INT PRIMARY KEY,
  provider_name VARCHAR(64) NOT NULL,
  ixp_location VARCHAR(64) NOT NULL,
  peering_capacity_tbps INT NOT NULL
);

CREATE TABLE IF NOT EXISTS cross_cloud_routing.wireguard_tunnel_endpoints (
  tunnel_id VARCHAR(64) PRIMARY KEY,
  endpoint_ip VARCHAR(45) NOT NULL,
  public_key VARCHAR(64) NOT NULL,
  listen_port INT NOT NULL,
  mtu_bytes INT DEFAULT 1420
);

CREATE TABLE IF NOT EXISTS cross_cloud_routing.nat_gateway_proxy_relays (
  relay_id VARCHAR(64) PRIMARY KEY,
  region VARCHAR(64) NOT NULL,
  bandwidth_limit_gbps INT NOT NULL,
  active_sessions INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cross_cloud_routing.geographic_latency_penalties (
  geo_pair_id VARCHAR(64) PRIMARY KEY,
  region_a VARCHAR(64) NOT NULL,
  region_b VARCHAR(64) NOT NULL,
  incurred_cost_per_hr NUMERIC(6, 4) NOT NULL
);

-- 6. fleet_orchestration Relations (12 tables)
CREATE TABLE IF NOT EXISTS fleet_orchestration.discovery_fleet_agents (
  agent_id VARCHAR(64) PRIMARY KEY,
  container_id VARCHAR(64) NOT NULL,
  target_provider VARCHAR(64) NOT NULL,
  offers_crawled_per_sec INT DEFAULT 65,
  status VARCHAR(32) DEFAULT 'ACTIVE',
  last_heartbeat TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fleet_orchestration.yield_optimizer_engines (
  engine_id VARCHAR(64) PRIMARY KEY,
  solver_type VARCHAR(64) DEFAULT 'BELLMAN_FORD_GPU',
  matrix_evals_per_sec INT DEFAULT 850000,
  status VARCHAR(32) DEFAULT 'ACTIVE',
  last_heartbeat TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fleet_orchestration.rpc_distributed_heartbeats (
  hb_id BIGSERIAL PRIMARY KEY,
  worker_id VARCHAR(64) NOT NULL,
  worker_type VARCHAR(32) NOT NULL,
  latency_ms NUMERIC(6, 2) NOT NULL,
  cpu_usage_pct NUMERIC(5, 2) NOT NULL,
  memory_mb INT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fleet_orchestration.rate_limit_token_buckets (
  provider_id VARCHAR(64) PRIMARY KEY,
  tokens_remaining INT NOT NULL,
  max_capacity INT NOT NULL,
  refill_rate_per_sec INT NOT NULL,
  last_refill TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fleet_orchestration.api_crawler_fingerprints (
  fingerprint_id VARCHAR(64) PRIMARY KEY,
  target_api VARCHAR(64) NOT NULL,
  user_agent VARCHAR(128) NOT NULL,
  success_rate_pct NUMERIC(5, 2) DEFAULT 99.8
);

CREATE TABLE IF NOT EXISTS fleet_orchestration.failover_consensus_quorum (
  quorum_id VARCHAR(64) PRIMARY KEY,
  total_votes INT NOT NULL,
  threshold INT NOT NULL,
  leader_worker_id VARCHAR(64) NOT NULL,
  epoch_term INT DEFAULT 1
);

CREATE TABLE IF NOT EXISTS fleet_orchestration.docker_compose_daemon_state (
  service_name VARCHAR(64) PRIMARY KEY,
  replica_count INT NOT NULL,
  healthy_count INT NOT NULL,
  restart_policy VARCHAR(32) DEFAULT 'unless-stopped',
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fleet_orchestration.prometheus_metric_exporters (
  metric_name VARCHAR(128) PRIMARY KEY,
  metric_type VARCHAR(32) NOT NULL,
  current_value NUMERIC(16, 4) NOT NULL,
  scrape_interval_sec INT DEFAULT 5
);

CREATE TABLE IF NOT EXISTS fleet_orchestration.ipc_shared_memory_buffers (
  shm_id VARCHAR(64) PRIMARY KEY,
  segment_size_bytes BIGINT NOT NULL,
  mapped_processes INT DEFAULT 150,
  lock_contention_pct NUMERIC(5, 2) DEFAULT 0.02
);

CREATE TABLE IF NOT EXISTS fleet_orchestration.kernel_io_uring_rings (
  ring_id VARCHAR(64) PRIMARY KEY,
  sqe_depth INT DEFAULT 1024,
  cqe_overflow_count BIGINT DEFAULT 0,
  mode VARCHAR(32) DEFAULT 'POLL_SQPOLL'
);

CREATE TABLE IF NOT EXISTS fleet_orchestration.wal_replication_slots (
  slot_name VARCHAR(64) PRIMARY KEY,
  active BOOLEAN DEFAULT TRUE,
  restart_lsn VARCHAR(32) NOT NULL
);

CREATE TABLE IF NOT EXISTS fleet_orchestration.dead_letter_queue_quarantine (
  item_id VARCHAR(64) PRIMARY KEY,
  originating_worker VARCHAR(64) NOT NULL,
  payload_json TEXT NOT NULL,
  error_message TEXT NOT NULL,
CREATE TABLE IF NOT EXISTS contract_escrows.immutable_financial_ledger (
  id VARCHAR(64) PRIMARY KEY,
  idempotency_key VARCHAR(128) UNIQUE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  transaction_type VARCHAR(64) NOT NULL,
  state VARCHAR(32) NOT NULL,
  account_type VARCHAR(32) NOT NULL,
  asset VARCHAR(16) NOT NULL,
  amount NUMERIC(16, 4) NOT NULL,
  fee NUMERIC(16, 4) DEFAULT 0,
  net_amount NUMERIC(16, 4) NOT NULL,
  debit_credit VARCHAR(16) NOT NULL,
  provider VARCHAR(64) NOT NULL,
  provider_tx_id VARCHAR(128),
  tx_hash VARCHAR(128),
  is_simulated BOOLEAN DEFAULT FALSE,
  metadata JSONB
);
`;

export async function checkDatabaseReadiness(): Promise<{
  isReady: boolean;
  database: string;
  latencyMs: number;
  error?: string;
}> {
  const startTime = Date.now();
  const database = process.env.PGDATABASE || 'arbitrage_v13';
  const pool = getPgPool();

  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1;');
      return {
        isReady: true,
        database,
        latencyMs: Date.now() - startTime,
      };
    } finally {
      client.release();
    }
  } catch (err: any) {
    return {
      isReady: false,
      database,
      latencyMs: Date.now() - startTime,
      error: err.message,
    };
  }
}

export async function runSchemaMigrations(): Promise<MigrationResult> {
  const startTime = Date.now();
  const database = process.env.PGDATABASE || 'arbitrage_v13';
  const pool = getPgPool();

  const relationsList: Array<{ schema: string; table: string; status: string }> = [
    { schema: 'market_microstructure', table: 'raw_spot_ticks_partitioned', status: 'SYNCHRONIZED' },
    { schema: 'market_microstructure', table: 'orderbook_bids_snapshot', status: 'SYNCHRONIZED' },
    { schema: 'market_microstructure', table: 'orderbook_asks_snapshot', status: 'SYNCHRONIZED' },
    { schema: 'market_microstructure', table: 'spread_arbitrage_candidates', status: 'SYNCHRONIZED' },
    { schema: 'market_microstructure', table: 'historical_volatility_bands', status: 'SYNCHRONIZED' },
    { schema: 'market_microstructure', table: 'synthetic_derivative_curves', status: 'SYNCHRONIZED' },
    { schema: 'hardware_topology', table: 'gpu_silicon_specs', status: 'SYNCHRONIZED' },
    { schema: 'hardware_topology', table: 'pcie_nvlink_matrix', status: 'SYNCHRONIZED' },
    { schema: 'hardware_topology', table: 'numa_node_affinities', status: 'SYNCHRONIZED' },
    { schema: 'hardware_topology', table: 'infiniband_roce_interfaces', status: 'SYNCHRONIZED' },
    { schema: 'hardware_topology', table: 'datacenter_pue_thermal_logs', status: 'SYNCHRONIZED' },
    { schema: 'hardware_topology', table: 'power_grid_marginal_emissions', status: 'SYNCHRONIZED' },
    { schema: 'contract_escrows', table: 'active_leases_ledger', status: 'SYNCHRONIZED' },
    { schema: 'contract_escrows', table: 'escrow_smart_locks', status: 'SYNCHRONIZED' },
    { schema: 'contract_escrows', table: 'slas_uptime_audit_pings', status: 'SYNCHRONIZED' },
    { schema: 'contract_escrows', table: 'preemption_hedge_positions', status: 'SYNCHRONIZED' },
    { schema: 'contract_escrows', table: 'settlement_pnl_records', status: 'SYNCHRONIZED' },
    { schema: 'contract_escrows', table: 'counterparty_reputation_scores', status: 'SYNCHRONIZED' },
    { schema: 'contract_escrows', table: 'immutable_financial_ledger', status: 'SYNCHRONIZED' },
    { schema: 'cross_cloud_routing', table: 'datacenter_rtt_latencies', status: 'SYNCHRONIZED' },
    { schema: 'cross_cloud_routing', table: 'packet_jitter_sdn_routes', status: 'SYNCHRONIZED' },
    { schema: 'cross_cloud_routing', table: 'bgp_asn_interconnects', status: 'SYNCHRONIZED' },
    { schema: 'cross_cloud_routing', table: 'wireguard_tunnel_endpoints', status: 'SYNCHRONIZED' },
    { schema: 'cross_cloud_routing', table: 'nat_gateway_proxy_relays', status: 'SYNCHRONIZED' },
    { schema: 'cross_cloud_routing', table: 'geographic_latency_penalties', status: 'SYNCHRONIZED' },
    { schema: 'fleet_orchestration', table: 'discovery_fleet_agents', status: 'SYNCHRONIZED' },
    { schema: 'fleet_orchestration', table: 'yield_optimizer_engines', status: 'SYNCHRONIZED' },
    { schema: 'fleet_orchestration', table: 'rpc_distributed_heartbeats', status: 'SYNCHRONIZED' },
    { schema: 'fleet_orchestration', table: 'rate_limit_token_buckets', status: 'SYNCHRONIZED' },
    { schema: 'fleet_orchestration', table: 'api_crawler_fingerprints', status: 'SYNCHRONIZED' },
    { schema: 'fleet_orchestration', table: 'failover_consensus_quorum', status: 'SYNCHRONIZED' },
    { schema: 'fleet_orchestration', table: 'docker_compose_daemon_state', status: 'SYNCHRONIZED' },
    { schema: 'fleet_orchestration', table: 'prometheus_metric_exporters', status: 'SYNCHRONIZED' },
    { schema: 'fleet_orchestration', table: 'ipc_shared_memory_buffers', status: 'SYNCHRONIZED' },
    { schema: 'fleet_orchestration', table: 'kernel_io_uring_rings', status: 'SYNCHRONIZED' },
    { schema: 'fleet_orchestration', table: 'wal_replication_slots', status: 'SYNCHRONIZED' },
    { schema: 'fleet_orchestration', table: 'dead_letter_queue_quarantine', status: 'SYNCHRONIZED' },
  ];

  try {
    // Attempt actual migration on PostgreSQL instance
    const client = await pool.connect();
    try {
      await client.query(SCHEMA_MIGRATIONS_DDL);
      console.log(`[PostgreSQL ✅] Database relations verified & migrated in ${database}`);
    } finally {
      client.release();
    }

    return {
      success: true,
      database,
      relationsMigrated: relationsList.length,
      totalSchemas: 5,
      appliedAt: new Date().toISOString(),
      executionTimeMs: Date.now() - startTime,
      tables: relationsList,
    };
  } catch (error: any) {
    console.warn(`[PostgreSQL ⚠️ Connection Notice] PostgreSQL live database connection offline (${error.message}).`);
    // Return honest failure result with zero fake relations migrated
    return {
      success: false,
      database,
      relationsMigrated: 0,
      totalSchemas: 0,
      appliedAt: new Date().toISOString(),
      executionTimeMs: Date.now() - startTime,
      tables: relationsList.map((t) => ({ ...t, status: 'CONNECTION_FAILED' })),
      error: error.message,
    };
  }
}
