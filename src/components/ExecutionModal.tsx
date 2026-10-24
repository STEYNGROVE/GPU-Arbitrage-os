import React, { useState, useEffect } from 'react';
import { ArbitrageOpportunity, ArbitrageOrderRequest } from '../types/arbitrage';
import {
  X,
  Zap,
  ShieldCheck,
  Cpu,
  ArrowRight,
  Lock,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';

interface ExecutionModalProps {
  opportunity: ArbitrageOpportunity | null;
  isOpen: boolean;
  onClose: () => void;
  onConfirmOrder: (req: ArbitrageOrderRequest) => void;
}

export const ExecutionModal: React.FC<ExecutionModalProps> = ({
  opportunity,
  isOpen,
  onClose,
  onConfirmOrder,
}) => {
  const [nodeCount, setNodeCount] = useState<number>(opportunity?.recommendedNodes || 4);
  const [durationHours, setDurationHours] = useState<number>(168); // 7 days
  const [enableSlaInsurance, setEnableSlaInsurance] = useState<boolean>(true);
  const [enableAutoFailover, setEnableAutoFailover] = useState<boolean>(true);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [fundingSource, setFundingSource] = useState<'BINANCE_MARGIN' | 'INTERNAL_ESCROW'>('BINANCE_MARGIN');

  useEffect(() => {
    if (opportunity?.recommendedNodes) {
      setNodeCount(opportunity.recommendedNodes);
    }
  }, [opportunity?.id]);

  if (!isOpen || !opportunity) return null;

  const totalGpus = nodeCount * 8;
  const grossHourlyBuy = opportunity.buyPricePerHour * nodeCount;
  const grossHourlySell = opportunity.sellPricePerHour * nodeCount;
  const insuranceHourly = enableSlaInsurance ? opportunity.slaInsuranceCostPerHour * nodeCount : 0;
  const netHourlyProfit = grossHourlySell - grossHourlyBuy - insuranceHourly;
  const totalProjectedPnL = netHourlyProfit * durationHours;
  const totalCommittedCapital = grossHourlyBuy * durationHours;

  const handleConfirm = () => {
    setIsSubmitting(true);
    setTimeout(() => {
      onConfirmOrder({
        opportunityId: opportunity.id,
        gpuName: opportunity.gpuName,
        nodeCount,
        buyProvider: opportunity.buyProvider,
        sellCounterparty: opportunity.sellCounterparty,
        buyRate: opportunity.buyPricePerHour,
        sellRate: opportunity.sellPricePerHour,
        durationHours,
        enableSlaInsurance,
        enableAutoFailover,
        fundingSource,
      });
      setIsSubmitting(false);
      onClose();
    }, 600);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="w-full max-w-xl bg-[#0b0f19] border border-slate-800 rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/60">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded bg-cyan-950 flex items-center justify-center text-cyan-400 border border-cyan-800">
              <Zap className="w-4 h-4 fill-current" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Execute Arbitrage Spread Lease</h3>
              <p className="text-[11px] text-slate-400 font-mono">
                Relaying Spot Inbound Liquidity to Enterprise SLA Outbound
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Content */}
        <div className="p-6 space-y-4 text-xs">
          {/* Opportunity Highlight */}
          <div className="p-3.5 bg-slate-900/80 border border-slate-800 rounded-lg space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-100 text-sm">{opportunity.gpuName}</span>
              <span className="font-mono text-cyan-400 font-semibold">{opportunity.contractType}</span>
            </div>
            <div className="flex items-center justify-between text-slate-400">
              <span>{opportunity.architecture} · {opportunity.vram}</span>
              <span className="text-emerald-400 font-mono font-bold">
                Net Spread: +${opportunity.netSpreadPerHour.toFixed(2)}/hr per node
              </span>
            </div>
          </div>

          {/* Funding Source Selector (Binance Connected) */}
          <div className="space-y-1.5">
            <label className="text-slate-300 font-medium flex items-center justify-between">
              <span>Funding Collateral Source</span>
              <span className="text-[10px] text-amber-400 font-mono">BINANCE VIP 3 CONNECTED</span>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setFundingSource('BINANCE_MARGIN')}
                className={`p-2.5 rounded border text-left transition-colors cursor-pointer ${
                  fundingSource === 'BINANCE_MARGIN'
                    ? 'bg-amber-950/40 border-amber-500/60 text-amber-200'
                    : 'bg-slate-950 border-slate-800 text-slate-400'
                }`}
              >
                <div className="font-bold text-xs flex items-center gap-1.5 text-white">
                  <span>Binance Cross-Margin</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">
                  Avail: $118.4k USDT @ 4.2% APR
                </div>
              </button>

              <button
                type="button"
                onClick={() => setFundingSource('INTERNAL_ESCROW')}
                className={`p-2.5 rounded border text-left transition-colors cursor-pointer ${
                  fundingSource === 'INTERNAL_ESCROW'
                    ? 'bg-cyan-950/40 border-cyan-500/60 text-cyan-200'
                    : 'bg-slate-950 border-slate-800 text-slate-400'
                }`}
              >
                <div className="font-bold text-xs text-white">Internal Escrow Wallet</div>
                <div className="text-[10px] text-slate-400 mt-0.5">
                  Pre-funded balance (USDC/USDT)
                </div>
              </button>
            </div>
          </div>

          {/* Route Legs Comparison */}
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 bg-slate-950 border border-slate-800 rounded">
              <div className="text-[11px] text-slate-400 font-medium">Leg A: Spot Acquisition</div>
              <div className="mt-1 font-semibold text-slate-200">{opportunity.buyProvider}</div>
              <div className="mt-0.5 text-slate-400 text-[11px]">{opportunity.buyRegion}</div>
              <div className="mt-2 font-mono text-emerald-400 font-bold tabular-nums">
                ${opportunity.buyPricePerHour.toFixed(2)}/hr per node
              </div>
            </div>

            <div className="p-3 bg-slate-950 border border-slate-800 rounded">
              <div className="text-[11px] text-slate-400 font-medium">Leg B: Enterprise Demand</div>
              <div className="mt-1 font-semibold text-slate-200">{opportunity.sellCounterparty}</div>
              <div className="mt-0.5 text-slate-400 text-[11px]">{opportunity.sellRegion}</div>
              <div className="mt-2 font-mono text-cyan-300 font-bold tabular-nums">
                ${opportunity.sellPricePerHour.toFixed(2)}/hr per node
              </div>
            </div>
          </div>

          {/* Node Count & Duration controls */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-slate-300 font-medium">Node Allocation</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="1"
                  max={opportunity.buyAvailabilityNodes}
                  value={nodeCount}
                  onChange={(e) => setNodeCount(Math.min(opportunity.buyAvailabilityNodes, Math.max(1, Number(e.target.value))))}
                  className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded text-slate-100 font-mono text-xs focus:outline-none focus:border-cyan-500"
                />
              </div>
              <p className="text-[10px] text-slate-500 font-mono">
                {totalGpus} GPUs (max {opportunity.buyAvailabilityNodes} nodes available)
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-slate-300 font-medium">Lease Horizon</label>
              <select
                value={durationHours}
                onChange={(e) => setDurationHours(Number(e.target.value))}
                className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded text-slate-100 font-mono text-xs focus:outline-none focus:border-cyan-500 cursor-pointer"
              >
                <option value={24}>24 Hours (Spot Relay)</option>
                <option value={72}>72 Hours (3 Days)</option>
                <option value={168}>168 Hours (7 Days)</option>
                <option value={720}>720 Hours (30 Days)</option>
              </select>
              <p className="text-[10px] text-slate-500 font-mono">Automatic rollover available</p>
            </div>
          </div>

          {/* Protection toggles */}
          <div className="p-3 bg-slate-950/60 border border-slate-800 rounded space-y-2">
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-slate-300">SLA Preemption Insurance (-${(opportunity.slaInsuranceCostPerHour * nodeCount).toFixed(2)}/hr)</span>
              <input
                type="checkbox"
                checked={enableSlaInsurance}
                onChange={(e) => setEnableSlaInsurance(e.target.checked)}
                className="rounded border-slate-700 bg-slate-900 text-cyan-500 focus:ring-0"
              />
            </label>

            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-slate-300">Automated Hot-Standby Failover Quorum</span>
              <input
                type="checkbox"
                checked={enableAutoFailover}
                onChange={(e) => setEnableAutoFailover(e.target.checked)}
                className="rounded border-slate-700 bg-slate-900 text-cyan-500 focus:ring-0"
              />
            </label>
          </div>

          {/* Financial Summary */}
          <div className="p-3.5 bg-slate-900 border border-slate-800 rounded-lg space-y-2">
            <div className="flex justify-between text-slate-300">
              <span>Total Capital Committed:</span>
              <span className="font-mono text-slate-200">${totalCommittedCapital.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-slate-300">
              <span>Net Hourly Cashflow:</span>
              <span className="font-mono text-emerald-400 font-bold">+${netHourlyProfit.toFixed(2)}/hr</span>
            </div>
            <div className="flex justify-between text-slate-200 font-bold border-t border-slate-800 pt-2">
              <span>Projected Net Profit ({durationHours}h):</span>
              <span className="font-mono text-emerald-400 text-sm tabular-nums">
                +${totalProjectedPnL.toFixed(2)}
              </span>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-800 bg-slate-900/60">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-slate-400 hover:text-white rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={isSubmitting}
            className="inline-flex items-center gap-2 px-5 py-2 text-xs font-semibold text-slate-950 bg-gradient-to-r from-cyan-400 to-teal-400 hover:from-cyan-300 hover:to-teal-300 rounded shadow-md transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
          >
            <Lock className="w-3.5 h-3.5" />
            <span>{isSubmitting ? 'Routing Escrow...' : 'Confirm & Lock Arbitrage Lease'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
