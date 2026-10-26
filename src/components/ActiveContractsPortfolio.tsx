import React from 'react';
import { ActiveContract } from '../types/arbitrage';
import { computeContractAccruedPnL } from '../services/arbitrageEngine';
import {
  ShieldCheck,
  TrendingUp,
  Cpu,
  RefreshCw,
  Power,
  Zap,
  ArrowRight,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Play,
  Pause,
  ExternalLink
} from 'lucide-react';

interface ActiveContractsPortfolioProps {
  contracts: ActiveContract[];
  onToggleStatus: (contractId: string) => void;
  onToggleAutoRenew: (contractId: string) => void;
  onToggleProtection: (contractId: string) => void;
  onSettleContract: (contractId: string) => void;
  onOpenQuickDeploy: () => void;
}

export const ActiveContractsPortfolio: React.FC<ActiveContractsPortfolioProps> = ({
  contracts,
  onToggleStatus,
  onToggleAutoRenew,
  onToggleProtection,
  onSettleContract,
  onOpenQuickDeploy,
}) => {
  const totalPnL = contracts.reduce((sum, c) => sum + computeContractAccruedPnL(c), 0);
  const totalGpus = contracts.reduce((sum, c) => sum + (c.status === 'ACTIVE_ROUTING' ? c.totalGpus : 0), 0);
  const totalHourlyCashflow = contracts.reduce(
    (sum, c) => (c.status === 'ACTIVE_ROUTING' ? sum + c.netSpreadPerHour * c.nodeCount : sum),
    0
  );
  const avgUptime = contracts.length > 0
    ? contracts.reduce((sum, c) => sum + c.uptimeSla, 0) / contracts.length
    : 100;

  return (
    <div className="space-y-6">
      {/* Portfolio Overview KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-lg">
          <div className="text-xs text-slate-400 font-medium">Accumulated Net PnL</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-emerald-400 tabular-nums">
              +${totalPnL.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
          <div className="mt-2 text-[11px] text-slate-400 flex items-center gap-1.5">
            <span>Escrow settled in real-time</span>
            <span aria-hidden="true">·</span>
            <span>Zero unpaid counterparty risk</span>
          </div>
        </div>

        <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-lg">
          <div className="text-xs text-slate-400 font-medium">Net Real-Time Cashflow</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-cyan-300 tabular-nums">
              +${totalHourlyCashflow.toFixed(2)}/hr
            </span>
          </div>
          <div className="mt-2 text-[11px] text-slate-400 flex items-center gap-1.5">
            <span className="font-mono text-slate-300">~${(totalHourlyCashflow * 24).toFixed(0)}/day</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono text-slate-300">~${(totalHourlyCashflow * 720).toFixed(0)}/mo</span>
          </div>
        </div>

        <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-lg">
          <div className="text-xs text-slate-400 font-medium">Active Compute Capacity</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-white tabular-nums">
              {totalGpus} GPUs
            </span>
            <span className="text-xs text-slate-500 font-mono">
              ({contracts.filter((c) => c.status === 'ACTIVE_ROUTING').length} active leases)
            </span>
          </div>
          <div className="mt-2 text-[11px] text-slate-400 flex items-center gap-1.5">
            <span>H100 SXM5 / B200 / H200</span>
            <span aria-hidden="true">·</span>
            <span>NVLink clusters</span>
          </div>
        </div>

        <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-lg">
          <div className="text-xs text-slate-400 font-medium">Fleet Weighted SLA Uptime</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-emerald-400 tabular-nums">
              {avgUptime.toFixed(2)}%
            </span>
          </div>
          <div className="mt-2 text-[11px] text-slate-400 flex items-center gap-1.5">
            <span>Automated failover standby active</span>
            <span aria-hidden="true">·</span>
            <span>Zero SLA breaches</span>
          </div>
        </div>
      </div>

      {/* Contracts Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-slate-100">Live Compute Arbitrage Contracts</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Active spot-to-contract leases routed by Autonomous Discovery Fleet and Yield Optimizers.
          </p>
        </div>
        <button
          onClick={onOpenQuickDeploy}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded transition-colors whitespace-nowrap cursor-pointer"
        >
          <Zap className="w-3.5 h-3.5 fill-current" />
          <span>Deploy New Position</span>
        </button>
      </div>

      {/* Contracts List */}
      <div className="space-y-4">
        {contracts.length === 0 ? (
          <div className="p-12 text-center bg-slate-900/60 border border-slate-800 rounded-lg">
            <p className="text-sm font-medium text-slate-300">No active arbitrage contracts currently running.</p>
            <p className="text-xs text-slate-500 mt-1">
              Select an opportunity from the Market Spreads tab to execute an arbitrage lease.
            </p>
            <button
              onClick={onOpenQuickDeploy}
              className="mt-4 px-4 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded transition-colors cursor-pointer"
            >
              Deploy Arbitrage Position
            </button>
          </div>
        ) : (
          contracts.map((contract) => {
            const hoursElapsed = Math.max(1, Math.floor((Date.now() - contract.startTime) / (3600 * 1000)));
            const progressPct = Math.min(100, Math.round((hoursElapsed / contract.durationHours) * 100));

            return (
              <div
                key={contract.id}
                className="p-5 bg-slate-900/80 border border-slate-800 hover:border-slate-700 rounded-lg transition-all space-y-4"
              >
                {/* Top Row: Contract ID, GPU Name, Status */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs font-bold text-cyan-400 bg-cyan-950/60 border border-cyan-800/60 px-2 py-0.5 rounded">
                      {contract.id}
                    </span>
                    <span className="text-sm font-bold text-slate-100">{contract.gpuName}</span>
                    <span className="text-xs text-slate-400 font-mono">
                      {contract.nodeCount} Nodes ({contract.totalGpus} GPUs)
                    </span>
                  </div>

                  <div className="flex items-center gap-3">
                    <span
                      className={`inline-flex items-center gap-1.5 text-xs font-mono font-medium px-2 py-0.5 rounded ${
                        contract.status === 'ACTIVE_ROUTING'
                          ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-800/60'
                          : contract.status === 'HEDGING_FAILOVER'
                          ? 'bg-amber-950/60 text-amber-400 border border-amber-800/60'
                          : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {contract.status === 'ACTIVE_ROUTING' && <Zap className="w-3 h-3 fill-current" />}
                      {contract.status === 'HEDGING_FAILOVER' && <AlertTriangle className="w-3 h-3" />}
                      {contract.status === 'PAUSED' && <Pause className="w-3 h-3" />}
                      <span>{contract.status.replace('_', ' ')}</span>
                    </span>

                    <span className="text-xs font-mono text-emerald-400 font-bold tabular-nums">
                      +${computeContractAccruedPnL(contract).toFixed(2)} Accrued PnL
                    </span>
                  </div>
                </div>

                {/* Middle Row: Arbitrage Route Details */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                  {/* Buy Leg */}
                  <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded">
                    <div className="text-[11px] text-slate-400 font-medium">Buy Leg (Inbound Spot)</div>
                    <div className="mt-1 font-semibold text-slate-200">{contract.buyProvider}</div>
                    <div className="mt-1 flex items-center justify-between text-slate-400 font-mono">
                      <span>{contract.buyRegion}</span>
                      <span className="text-emerald-400 font-semibold tabular-nums">
                        ${contract.buyRate.toFixed(2)}/hr
                      </span>
                    </div>
                  </div>

                  {/* Resell Leg */}
                  <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded">
                    <div className="text-[11px] text-slate-400 font-medium">Sell Leg (Enterprise SLA Resell)</div>
                    <div className="mt-1 font-semibold text-slate-200">{contract.sellCounterparty}</div>
                    <div className="mt-1 flex items-center justify-between text-slate-400 font-mono">
                      <span>{contract.sellRegion}</span>
                      <span className="text-cyan-300 font-semibold tabular-nums">
                        ${contract.sellRate.toFixed(2)}/hr
                      </span>
                    </div>
                  </div>

                  {/* Net Cashflow & SLA */}
                  <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded">
                    <div className="text-[11px] text-slate-400 font-medium">Net Realized Margin</div>
                    <div className="mt-1 font-bold text-emerald-400 text-sm font-mono tabular-nums">
                      +${(contract.netSpreadPerHour * contract.nodeCount).toFixed(2)}/hr net
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[11px] text-slate-400">
                      <span>Audit Uptime: {contract.uptimeSla}%</span>
                      <span>PUE: {contract.datacenterPUE}</span>
                    </div>
                  </div>
                </div>

                {/* Progress bar */}
                <div>
                  <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono mb-1">
                    <span>
                      Lease Term: {hoursElapsed}h elapsed / {contract.durationHours}h committed
                    </span>
                    <span>{progressPct}% Completed</span>
                  </div>
                  <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-cyan-500 to-emerald-400 rounded-full transition-all duration-500"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                </div>

                {/* Bottom Row: Controls */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-slate-800/60 text-xs">
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-1.5 cursor-pointer text-slate-300 hover:text-white">
                      <input
                        type="checkbox"
                        checked={contract.autoRenew}
                        onChange={() => onToggleAutoRenew(contract.id)}
                        className="rounded border-slate-700 bg-slate-950 text-cyan-500 focus:ring-0"
                      />
                      <span>Auto-renew lease</span>
                    </label>

                    <label className="flex items-center gap-1.5 cursor-pointer text-slate-300 hover:text-white">
                      <input
                        type="checkbox"
                        checked={contract.preemptionProtection}
                        onChange={() => onToggleProtection(contract.id)}
                        className="rounded border-slate-700 bg-slate-950 text-cyan-500 focus:ring-0"
                      />
                      <span>Hot failover protection</span>
                    </label>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => onToggleStatus(contract.id)}
                      className="px-2.5 py-1 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded transition-colors"
                    >
                      {contract.status === 'ACTIVE_ROUTING' ? 'Pause Routing' : 'Resume Routing'}
                    </button>

                    <button
                      onClick={() => onSettleContract(contract.id)}
                      className="px-2.5 py-1 text-xs font-medium text-rose-400 hover:text-rose-300 bg-rose-950/40 hover:bg-rose-950/70 border border-rose-900/60 rounded transition-colors"
                    >
                      Settle & Close Lease
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
