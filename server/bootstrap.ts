import { runSchemaMigrations, type MigrationResult, checkDatabaseReadiness } from './pgDatabase.ts';
import { jakeGroveCfoService, type BinanceAccountStatus } from './jakeGroveCfoService.ts';
import { githubSyncService, type GitHubSyncStatus } from './githubSyncService.ts';
import { systemMemoryService, type SystemMemoryDiagnostics } from './systemMemoryService.ts';
import { config } from './config.ts';

export interface BootstrapReport {
  operatingMode: 'PRODUCTION' | 'SIMULATION' | 'SANDBOX';
  bootstrappedAt: string;
  envValidated: boolean;
  missingEnvVars: string[];
  databaseReadiness: {
    isReady: boolean;
    database: string;
    latencyMs: number;
    error?: string;
  };
  databaseMigrations: MigrationResult;
  binanceStatus: BinanceAccountStatus;
  githubSyncStatus: GitHubSyncStatus;
  memoryDiagnostics: SystemMemoryDiagnostics;
  discoveryFleetTarget: number;
  optimizerFleetTarget: number;
  systemStatus: 'ONLINE_NOMINAL' | 'DEGRADED_SIMULATION' | 'CRITICAL_BLOCKED';
  logs: string[];
}

export async function bootstrapSystem(): Promise<BootstrapReport> {
  const logs: string[] = [];

  const logLine = (line: string) => {
    logs.push(line);
    console.log(line);
  };

  logLine('==========================================================');
  logLine(`   GPU COMPUTE ARBITRAGE OS v14 — [${config.operatingMode} MODE]   `);
  logLine('==========================================================');

  // 0. Persistent Memory Initial Load
  logLine('[Bootstrap 0/5] Loading System State Memory and Ledger from disk...');
  const memoryInit = await systemMemoryService.initialize();
  const memoryDiagnostics = systemMemoryService.getDiagnostics();
  logLine(
    `[Bootstrap 0/5] Complete Memory Active: Rehydrated=${memoryInit.rehydratedFromDisk}, BootCount=${memoryInit.bootCount}, Snapshots=${memoryDiagnostics.totalSnapshotsStored}`
  );

  // 1. Genuine Environment Validation (NO fake '|| true')
  const missingEnvVars: string[] = [];
  if (config.isProduction) {
    if (!config.postgres.hasConfiguredPassword) missingEnvVars.push('PGPASSWORD');
    if (!config.binance.hasLiveKeys) missingEnvVars.push('BINANCE_API_KEY', 'BINANCE_SECRET_KEY');
  }

  const envValidated = missingEnvVars.length === 0;
  if (envValidated) {
    logLine(`[Bootstrap 1/5] Environment Validation: PASSED for ${config.operatingMode} mode.`);
  } else {
    logLine(`[Bootstrap 1/5 ⚠️] Environment Validation: Incomplete for production. Missing: ${missingEnvVars.join(', ')}`);
  }

  // 2. Real PostgreSQL Database Check & Migrations
  logLine('[Bootstrap 2/5] Testing PostgreSQL database connection and schema migrations...');
  const dbReadiness = await checkDatabaseReadiness();
  const migrationResult = await runSchemaMigrations();

  if (dbReadiness.isReady && migrationResult.success) {
    logLine(`[Bootstrap 2/5 ✅] Database Connected: ${migrationResult.relationsMigrated} relations verified in ${dbReadiness.database} (${dbReadiness.latencyMs}ms).`);
  } else {
    logLine(`[Bootstrap 2/5 ⚠️] Database Offline (${dbReadiness.error || 'Connection Failed'}). Standby local storage active.`);
  }

  // 3. Binance Gateway & CFO Treasury Init
  logLine('[Bootstrap 3/5] Testing Binance CFO Gateway credentials...');
  const binanceStatus = await jakeGroveCfoService.getAccountStatus();
  logLine(`[Bootstrap 3/5] Binance Gateway: [${binanceStatus.connectionStatus}] UID: ${binanceStatus.binanceUid} (${binanceStatus.isSimulated ? 'SANDBOX SIMULATED' : 'LIVE AUTHENTICATED'})`);

  // Upstream GitHub Sync Check
  const gitStatus = githubSyncService.getStatus();
  logLine(`[Bootstrap Upstream] GitHub Sync: ${gitStatus.upstreamRepo} [${gitStatus.syncState}] (Token: ${gitStatus.tokenConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED'})`);

  // 4. Fleet Scaling
  logLine('[Bootstrap 4/5] No live workers launched. Execution adapter unavailable.');

  // System Status Resolution
  let systemStatus: BootstrapReport['systemStatus'] = 'CRITICAL_BLOCKED';
  if (config.isProduction && (!envValidated || !dbReadiness.isReady)) {
    systemStatus = 'CRITICAL_BLOCKED';
  } else if (config.isSimulation) {
    systemStatus = 'DEGRADED_SIMULATION';
  }

  logLine('==========================================================');
  logLine(` Bootstrap Sequence Complete. System Status: [${systemStatus}]`);
  logLine('==========================================================');

  return {
    operatingMode: config.operatingMode,
    bootstrappedAt: new Date().toISOString(),
    envValidated,
    missingEnvVars,
    databaseReadiness: dbReadiness,
    databaseMigrations: migrationResult,
    binanceStatus,
    githubSyncStatus: gitStatus,
    memoryDiagnostics,
    discoveryFleetTarget: 0,
    optimizerFleetTarget: 0,
    systemStatus,
    logs,
  };
}
