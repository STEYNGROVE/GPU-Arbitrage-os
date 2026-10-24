import React, { useState, useMemo } from 'react';
import { GPUHardware } from '../types/arbitrage';
import {
  Sliders,
  TrendingUp,
  Cpu,
  DollarSign,
  Shield,
  Zap,
  ArrowRight,
  PieChart,
  Activity,
  CheckCircle2
} from 'lucide-react';

interface YieldCalculatorProps {
  hardwareCatalog: GPUHardware[];
  onDeploySimulatedSpread: (params: {
    gpuName: string;
    nodeCount: number;
    buyRate: number;
    sellRate: number;
    durationHours: number;
  }) => void;
}

export const YieldCalculator: React.FC<YieldCalculatorProps> = ({
  hardwareCatalog,
  onDeploySimulatedSpread,
}) => {
  const [selectedGpuId, setSelectedGpuId] = useState<string>('h100-sxm5');
  const [nodeCount, setNodeCount] = useState<number>(8);
  const [buyRate, setBuyRate] = useState<number>(1.48);
  const [sellRate, setSellRate] = useState<number>(2.85);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [utilizationPct, setUtilizationPct] = useState<number>(95);
  const [pueRating, setPueRating] = useState<number>(1.12);
  const [slaInsuranceEnabled, setSlaInsuranceEnabled] = useState<boolean>(true);

  const selectedGpu = useMemo(() => {
    return hardwareCatalog.find((g) => g.id === selectedGpuId) || hardwareCatalog[0];
  }, [hardwareCatalog, selectedGpuId]);

  // When changing GPU, auto-adjust default rates
  const handleSelectGpu = (gpuId: string) => {
    setSelectedGpuId(gpuId);
    const gpu = hardwareCatalog.find((g) => g.id === gpuId);
    if (gpu) {
      const base = gpu.baseMarketAvgRate;
      setBuyRate(Number((base * 0.72).toFixed(2)));
      setSellRate(Number((base * 1.35).toFixed(2)));
    }
  };

  // Calculations
  const metrics = useMemo(() => {
    const totalHours = durationDays * 24;
    const effectiveHours = totalHours * (utilizationPct / 100);

    // Costs
    const spotBuyCost = buyRate * totalHours * nodeCount;
    const slaInsuranceCostPerHour = slaInsuranceEnabled ? buyRate * 0.08 : 0;
    const totalInsuranceCost = slaInsuranceCostPerHour * totalHours * nodeCount;

    // Gross Revenue from buyer
    const grossRevenue = sellRate * effectiveHours * nodeCount;

    // Net Profit
    const totalCost = spotBuyCost + totalInsuranceCost;
    const netProfit = grossRevenue - totalCost;
    const netMarginPct = grossRevenue > 0 ? (netProfit / grossRevenue) * 100 : 0;
    const spreadPerHourPerNode = sellRate * (utilizationPct / 100) - buyRate - slaInsuranceCostPerHour;

    // Annualized return (APR) on committed capital
    const committedCapital = spotBuyCost;
    const annualizedYieldApr = committedCapital > 0 ? (netProfit / committedCapital) * (365 / durationDays) * 100 : 0;

    // Break-even occupancy percentage
    const breakEvenOccupancyPct = sellRate > 0 ? ((buyRate + slaInsuranceCostPerHour) / sellRate) * 100 : 0;

    return {
      totalHours,
      effectiveHours,
      spotBuyCost,
      totalInsuranceCost,
      grossRevenue,
      netProfit,
      netMarginPct,
      spreadPerHourPerNode,
      annualizedYieldApr,
      breakEvenOccupancyPct,
    };
  }, [buyRate, sellRate, nodeCount, durationDays, utilizationPct, slaInsuranceEnabled]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="p-5 bg-slate-900/80 border border-slate-800 rounded-lg">
        <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
          <Sliders className="w-4 h-4 text-cyan-400" />
          <span>GPU Compute Yield & Arbitrage Margin Sandbox</span>
        </h2>
        <p className="text-xs text-slate-400 mt-1">
          Model quantitative return profiles across Spot Inbound procurement vs Enterprise Contract resell with
          dynamic occupancy rates, power grid PUE, and SLA insurance.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Interactive Inputs (7 cols) */}
        <div className="lg:col-span-7 space-y-4">
          {/* 1. Silicon Selection */}
          <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-lg space-y-3">
            <label className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-cyan-400" />
              <span>Target GPU Silicon Architecture</span>
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {hardwareCatalog.map((hw) => (
                <button
                  key={hw.id}
                  onClick={() => handleSelectGpu(hw.id)}
                  className={`p-2 rounded text-left border transition-all text-xs cursor-pointer ${
                    selectedGpuId === hw.id
                      ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-300'
                      : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="font-bold truncate">{hw.name.replace('NVIDIA ', '').replace('AMD Instinct ', '')}</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">{hw.vramGb}GB · {hw.interconnect.split(' ')[0]}</div>
                </button>
              ))}
            </div>
          </div>

          {/* 2. Rates & Nodes */}
          <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-lg space-y-4 text-xs">
            {/* Node count */}
            <div className="space-y-1.5">
              <div className="flex justify-between">
                <span className="text-slate-300 font-medium">Node Allocation (8 GPUs per node):</span>
                <span className="font-mono text-cyan-400 font-bold">{nodeCount} nodes ({nodeCount * 8} GPUs)</span>
              </div>
              <input
                type="range"
                min="1"
                max="64"
                value={nodeCount}
                onChange={(e) => setNodeCount(Number(e.target.value))}
                className="w-full accent-cyan-400 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
              />
              <div className="flex justify-between text-[10px] text-slate-500 font-mono">
                <span>1 node (8 GPUs)</span>
                <span>16 nodes (128 GPUs)</span>
                <span>64 nodes (512 GPUs)</span>
              </div>
            </div>

            {/* Buy Rate & Sell Rate */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
              <div className="space-y-1">
                <label className="text-slate-300 font-medium">Inbound Spot Buy Rate ($/hr per node)</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">$</span>
                  <input
                    type="number"
                    step="0.05"
                    min="0.10"
                    value={buyRate}
                    onChange={(e) => setBuyRate(Math.max(0.1, Number(e.target.value)))}
                    className="w-full pl-7 pr-3 py-1.5 bg-slate-950 border border-slate-700 rounded text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                  />
                </div>
                <p className="text-[10px] text-slate-500">Crawled spot floor across Vast, RunPod, Prime</p>
              </div>

              <div className="space-y-1">
                <label className="text-slate-300 font-medium">Outbound Resell Rate ($/hr per node)</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">$</span>
                  <input
                    type="number"
                    step="0.05"
                    min="0.20"
                    value={sellRate}
                    onChange={(e) => setSellRate(Math.max(0.2, Number(e.target.value)))}
                    className="w-full pl-7 pr-3 py-1.5 bg-slate-950 border border-slate-700 rounded text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                  />
                </div>
                <p className="text-[10px] text-slate-500">Enterprise SLA inference contract rate</p>
              </div>
            </div>

            {/* Term & Utilization */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300 font-medium">Lease Horizon:</span>
                  <span className="font-mono text-cyan-400 font-bold">{durationDays} Days ({durationDays * 24}h)</span>
                </div>
                <input
                  type="range"
                  min="3"
                  max="180"
                  step="3"
                  value={durationDays}
                  onChange={(e) => setDurationDays(Number(e.target.value))}
                  className="w-full accent-cyan-400 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-300 font-medium">Target Utilization:</span>
                  <span className="font-mono text-emerald-400 font-bold">{utilizationPct}%</span>
                </div>
                <input
                  type="range"
                  min="60"
                  max="100"
                  step="1"
                  value={utilizationPct}
                  onChange={(e) => setUtilizationPct(Number(e.target.value))}
                  className="w-full accent-emerald-400 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
                />
              </div>
            </div>

            {/* SLA Insurance Toggle */}
            <div className="pt-2 border-t border-slate-800 flex items-center justify-between">
              <div>
                <span className="text-slate-200 font-medium">SLA Preemption Insurance Buffer (+8%)</span>
                <p className="text-[10px] text-slate-400">Guarantees hot-standby node failover if spot provider preempts</p>
              </div>
              <input
                type="checkbox"
                checked={slaInsuranceEnabled}
                onChange={(e) => setSlaInsuranceEnabled(e.target.checked)}
                className="w-4 h-4 rounded border-slate-700 bg-slate-950 text-cyan-500 focus:ring-0 cursor-pointer"
              />
            </div>
          </div>
        </div>

        {/* Right Column: Computed Arbitrage Yield Matrix (5 cols) */}
        <div className="lg:col-span-5 space-y-4">
          <div className="p-5 bg-slate-900/90 border border-slate-800 rounded-lg space-y-5">
            <div className="border-b border-slate-800 pb-3">
              <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">
                Simulated Return Profile
              </span>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-3xl font-extrabold font-mono text-emerald-400 tabular-nums">
                  +${metrics.netProfit.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </span>
                <span className="text-xs text-slate-400 font-mono">Net Profit ({durationDays}d)</span>
              </div>
            </div>

            {/* Financial breakdown */}
            <div className="space-y-2.5 text-xs">
              <div className="flex justify-between items-center text-slate-300">
                <span>Gross Outbound Invoicing</span>
                <span className="font-mono font-bold text-slate-100 tabular-nums">
                  ${metrics.grossRevenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>

              <div className="flex justify-between items-center text-slate-400">
                <span>Inbound Spot Acquisition Cost</span>
                <span className="font-mono text-rose-400 tabular-nums">
                  -${metrics.spotBuyCost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>

              {slaInsuranceEnabled && (
                <div className="flex justify-between items-center text-slate-400">
                  <span>Preemption Failover Insurance</span>
                  <span className="font-mono text-amber-400 tabular-nums">
                    -${metrics.totalInsuranceCost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              )}

              <div className="pt-2 border-t border-slate-800 flex justify-between items-center font-medium">
                <span className="text-slate-200">Net Realized Margin</span>
                <span className="font-mono text-emerald-400 font-bold tabular-nums">
                  {metrics.netMarginPct.toFixed(1)}%
                </span>
              </div>

              <div className="flex justify-between items-center font-medium">
                <span className="text-slate-200">Annualized Yield (APR)</span>
                <span className="font-mono text-teal-300 font-bold tabular-nums">
                  {metrics.annualizedYieldApr.toFixed(1)}%
                </span>
              </div>

              <div className="flex justify-between items-center text-slate-400 text-[11px]">
                <span>Break-Even Occupancy Threshold</span>
                <span className="font-mono text-slate-300 tabular-nums">
                  {metrics.breakEvenOccupancyPct.toFixed(1)}% utilization
                </span>
              </div>

              <div className="flex justify-between items-center text-slate-400 text-[11px]">
                <span>Net Cashflow per Hour (Fleet)</span>
                <span className="font-mono text-cyan-300 tabular-nums">
                  +${(metrics.spreadPerHourPerNode * nodeCount).toFixed(2)}/hr
                </span>
              </div>
            </div>

            {/* Quick Action Button */}
            <div className="pt-2">
              <button
                onClick={() =>
                  onDeploySimulatedSpread({
                    gpuName: selectedGpu.name,
                    nodeCount,
                    buyRate,
                    sellRate,
                    durationHours: durationDays * 24,
                  })
                }
                className="w-full py-2.5 text-xs font-bold text-slate-950 bg-gradient-to-r from-cyan-400 to-teal-400 hover:from-cyan-300 hover:to-teal-300 rounded shadow-md transition-all active:scale-95 cursor-pointer flex items-center justify-center gap-2"
              >
                <Zap className="w-3.5 h-3.5 fill-current" />
                <span>Execute Modeled Arbitrage Lease</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
