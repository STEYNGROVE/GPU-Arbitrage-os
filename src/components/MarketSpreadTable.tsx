import React, { useState, useMemo } from 'react';
import {
  ArbitrageOpportunity,
  GPUHardware
} from '../types/arbitrage';
import {
  ArrowRight,
  TrendingUp,
  Search,
  Filter,
  Zap,
  Globe,
  Shield,
  Layers,
  ArrowUpDown,
  Cpu,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';

interface MarketSpreadTableProps {
  opportunities: ArbitrageOpportunity[];
  hardwareCatalog: GPUHardware[];
  onSelectExecute: (opp: ArbitrageOpportunity) => void;
  onGroqAnalyze?: (opp: ArbitrageOpportunity) => void;
  onRefreshPrices: () => void;
  isRefreshing: boolean;
}

export const MarketSpreadTable: React.FC<MarketSpreadTableProps> = ({
  opportunities,
  hardwareCatalog,
  onSelectExecute,
  onGroqAnalyze,
  onRefreshPrices,
  isRefreshing,
}) => {
  const [selectedGpuFilter, setSelectedGpuFilter] = useState<string>('all');
  const [selectedContractType, setSelectedContractType] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortBy, setSortBy] = useState<'netSpread' | 'spreadPercent' | 'apr' | 'buyPrice'>('netSpread');
  const [sortDirection, setSortDirection] = useState<'desc' | 'asc'>('desc');

  // Filtered and sorted opportunities
  const filteredOpportunities = useMemo(() => {
    return opportunities
      .filter((opp) => {
        if (selectedGpuFilter !== 'all' && opp.gpuId !== selectedGpuFilter) {
          return false;
        }
        if (selectedContractType !== 'all' && opp.contractType !== selectedContractType) {
          return false;
        }
        if (searchQuery.trim()) {
          const query = searchQuery.toLowerCase();
          return (
            opp.gpuName.toLowerCase().includes(query) ||
            opp.buyProvider.toLowerCase().includes(query) ||
            opp.sellCounterparty.toLowerCase().includes(query) ||
            opp.buyRegion.toLowerCase().includes(query)
          );
        }
        return true;
      })
      .sort((a, b) => {
        let diff = 0;
        if (sortBy === 'netSpread') diff = a.netSpreadPerHour - b.netSpreadPerHour;
        if (sortBy === 'spreadPercent') diff = a.spreadPercent - b.spreadPercent;
        if (sortBy === 'apr') diff = a.annualizedYieldApr - b.annualizedYieldApr;
        if (sortBy === 'buyPrice') diff = a.buyPricePerHour - b.buyPricePerHour;
        return sortDirection === 'desc' ? -diff : diff;
      });
  }, [opportunities, selectedGpuFilter, selectedContractType, searchQuery, sortBy, sortDirection]);

  // Aggregate stats
  const aggregateStats = useMemo(() => {
    const totalNodes = opportunities.reduce((acc, curr) => acc + curr.buyAvailabilityNodes, 0);
    const maxSpread = opportunities.reduce((max, curr) => Math.max(max, curr.netSpreadPerHour), 0);
    const avgApr = opportunities.reduce((acc, curr) => acc + curr.annualizedYieldApr, 0) / opportunities.length;
    return {
      totalNodes,
      maxSpread,
      avgApr: Math.round(avgApr),
    };
  }, [opportunities]);

  const handleSort = (field: 'netSpread' | 'spreadPercent' | 'apr' | 'buyPrice') => {
    if (sortBy === field) {
      setSortDirection((prev) => (prev === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortBy(field);
      setSortDirection('desc');
    }
  };

  return (
    <div className="space-y-6">
      {/* KPI Summary strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-lg">
          <div className="text-xs text-slate-400 font-medium">Top Net Spread</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-emerald-400 tabular-nums">
              +${aggregateStats.maxSpread.toFixed(2)}/hr
            </span>
            <span className="text-xs text-slate-500 font-mono">per GPU node</span>
          </div>
          <div className="mt-2 text-[11px] text-slate-400 flex items-center gap-1.5">
            <span>B200 Blackwell Clean Flare Arb</span>
            <span aria-hidden="true">·</span>
            <span>68.8% margin</span>
          </div>
        </div>

        <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-lg">
          <div className="text-xs text-slate-400 font-medium">Scanned Pool Liquidity</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-cyan-400 tabular-nums">
              {aggregateStats.totalNodes} Nodes
            </span>
            <span className="text-xs text-slate-500 font-mono">1,480 GPUs</span>
          </div>
          <div className="mt-2 text-[11px] text-slate-400 flex items-center gap-1.5">
            <span>100 Discovery agents live</span>
            <span aria-hidden="true">·</span>
            <span>14 cloud providers</span>
          </div>
        </div>

        <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-lg">
          <div className="text-xs text-slate-400 font-medium">Mean Arbitrage APR</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-teal-300 tabular-nums">
              {aggregateStats.avgApr}%
            </span>
            <span className="text-xs text-slate-500 font-mono">annualized yield</span>
          </div>
          <div className="mt-2 text-[11px] text-slate-400 flex items-center gap-1.5">
            <span>Non-directional spot hedge</span>
            <span aria-hidden="true">·</span>
            <span>Full SLA insured</span>
          </div>
        </div>

        <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-lg">
          <div className="text-xs text-slate-400 font-medium">Optimizer Solver Latency</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-white tabular-nums">
              2.8 ms
            </span>
            <span className="text-xs text-slate-500 font-mono">Bellman-Ford matrix</span>
          </div>
          <div className="mt-2 text-[11px] text-slate-400 flex items-center gap-1.5">
            <span>PostgreSQL relations sync</span>
            <span aria-hidden="true">·</span>
            <span>36 schemas online</span>
          </div>
        </div>
      </div>

      {/* Filter and Control Toolbar */}
      <div className="p-4 bg-slate-900/60 border border-slate-800 rounded-lg space-y-3">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          {/* Search bar */}
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search GPU model, buy provider, or resell counterparty..."
              className="w-full pl-9 pr-4 py-1.5 bg-slate-950/80 border border-slate-700/80 rounded-md text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500"
            />
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <button
              onClick={onRefreshPrices}
              disabled={isRefreshing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-800/90 hover:bg-slate-700 border border-slate-700 rounded-md transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
            >
              <ArrowUpDown className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-cyan-400' : ''}`} />
              <span>{isRefreshing ? 'Crawling Providers...' : 'Trigger Market Rescan'}</span>
            </button>
          </div>
        </div>

        {/* Model Filter Pills (functional segmented buttons) */}
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <span className="text-xs text-slate-500 font-medium mr-1 flex items-center gap-1">
            <Cpu className="w-3.5 h-3.5" /> Silicon:
          </span>
          <button
            onClick={() => setSelectedGpuFilter('all')}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              selectedGpuFilter === 'all'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                : 'text-slate-400 hover:text-slate-200 bg-slate-950/40 border border-transparent'
            }`}
          >
            All GPUs ({opportunities.length})
          </button>
          {hardwareCatalog.map((hw) => {
            const count = opportunities.filter((o) => o.gpuId === hw.id).length;
            return (
              <button
                key={hw.id}
                onClick={() => setSelectedGpuFilter(hw.id)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  selectedGpuFilter === hw.id
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                    : 'text-slate-400 hover:text-slate-200 bg-slate-950/40 border border-transparent'
                }`}
              >
                {hw.name.replace('NVIDIA ', '').replace('AMD Instinct ', '')} ({count})
              </button>
            );
          })}
        </div>

        {/* Contract Type Segmented Filter */}
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <span className="text-xs text-slate-500 font-medium mr-1 flex items-center gap-1">
            <Layers className="w-3.5 h-3.5" /> Structure:
          </span>
          {[
            { id: 'all', label: 'All Structures' },
            { id: 'On-Demand Spot Arb', label: 'On-Demand Spot Arb' },
            { id: '7-Day Reserve Relay', label: '7-Day Reserve Relay' },
            { id: '30-Day Cluster Resell', label: '30-Day Cluster Resell' },
            { id: 'Fractional Slice Swap', label: 'Fractional Slice Swap' },
          ].map((type) => (
            <button
              key={type.id}
              onClick={() => setSelectedContractType(type.id)}
              className={`px-2.5 py-0.5 text-xs rounded transition-colors whitespace-nowrap ${
                selectedContractType === type.id
                  ? 'bg-slate-700 text-white font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {type.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main High-Density Arbitrage Table */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950/60 text-slate-400 text-[11px] font-medium uppercase tracking-wider">
                <th className="py-3 px-4">GPU Silicon & Arch</th>
                <th className="py-3 px-4 cursor-pointer hover:text-white" onClick={() => handleSort('buyPrice')}>
                  <div className="flex items-center gap-1">
                    <span>Buy Leg (Spot Inbound)</span>
                    <ArrowUpDown className="w-3 h-3" />
                  </div>
                </th>
                <th className="py-3 px-4">Sell Leg (Outbound Demand)</th>
                <th className="py-3 px-4 text-right cursor-pointer hover:text-white" onClick={() => handleSort('netSpread')}>
                  <div className="flex items-center justify-end gap-1">
                    <span>Net Spread ($/hr)</span>
                    <ArrowUpDown className="w-3 h-3" />
                  </div>
                </th>
                <th className="py-3 px-4 text-right cursor-pointer hover:text-white" onClick={() => handleSort('apr')}>
                  <div className="flex items-center justify-end gap-1">
                    <span>Est. APR Yield</span>
                    <ArrowUpDown className="w-3 h-3" />
                  </div>
                </th>
                <th className="py-3 px-4 text-center">Preemption Risk</th>
                <th className="py-3 px-4 text-right">Arbitrage Route</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-xs">
              {filteredOpportunities.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-500">
                    <AlertCircle className="w-8 h-8 mx-auto text-slate-600 mb-2" />
                    <p className="text-sm font-medium text-slate-300">No arbitrage spreads match your active filter.</p>
                    <p className="text-xs text-slate-500 mt-1">Try resetting the GPU model or search query.</p>
                  </td>
                </tr>
              ) : (
                filteredOpportunities.map((opp) => (
                  <tr
                    key={opp.id}
                    className="hover:bg-slate-800/40 transition-colors group"
                  >
                    {/* GPU Model Column */}
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-slate-200 flex items-center gap-1.5">
                        <span>{opp.gpuName}</span>
                      </div>
                      <div className="text-[11px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                        <span>{opp.architecture}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">{opp.vram}</span>
                        <span aria-hidden="true">·</span>
                        <span className="text-cyan-400/90">{opp.contractType}</span>
                      </div>
                    </td>

                    {/* Buy Leg Column */}
                    <td className="py-3.5 px-4">
                      <div className="font-medium text-slate-200">
                        {opp.buyProvider}
                      </div>
                      <div className="text-[11px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                        <span>{opp.buyRegion}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono text-emerald-400 font-medium tabular-nums">
                          ${opp.buyPricePerHour.toFixed(2)}/hr
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="text-slate-500 font-mono">{opp.buyAvailabilityNodes} nodes</span>
                      </div>
                    </td>

                    {/* Sell Leg Column */}
                    <td className="py-3.5 px-4">
                      <div className="font-medium text-slate-200">
                        {opp.sellCounterparty}
                      </div>
                      <div className="text-[11px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                        <span>{opp.sellRegion}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono text-cyan-300 font-medium tabular-nums">
                          ${opp.sellPricePerHour.toFixed(2)}/hr
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono text-slate-500">RTT: {opp.latencyDeltaMs}ms</span>
                      </div>
                    </td>

                    {/* Net Spread Column */}
                    <td className="py-3.5 px-4 text-right">
                      <div className="font-mono font-bold text-emerald-400 text-sm tabular-nums">
                        +${opp.netSpreadPerHour.toFixed(2)}/hr
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 flex items-center justify-end gap-1 mt-0.5">
                        <span>Gross +${opp.spreadPerHour.toFixed(2)}</span>
                        <span>({opp.spreadPercent.toFixed(1)}%)</span>
                      </div>
                    </td>

                    {/* Yield APR Column */}
                    <td className="py-3.5 px-4 text-right">
                      <div className="font-mono font-bold text-teal-300 text-sm tabular-nums">
                        {opp.annualizedYieldApr.toFixed(1)}%
                      </div>
                      <div className="text-[10px] font-mono text-slate-500 mt-0.5">
                        Insured SLA (-${opp.slaInsuranceCostPerHour.toFixed(2)}/hr)
                      </div>
                    </td>

                    {/* Risk Column */}
                    <td className="py-3.5 px-4 text-center">
                      <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${
                        opp.preemptionRisk === 'Guaranteed SLA'
                          ? 'text-cyan-400'
                          : opp.preemptionRisk === 'Minimal'
                          ? 'text-emerald-400'
                          : 'text-amber-400'
                      }`}>
                        {opp.preemptionRisk === 'Guaranteed SLA' && <Shield className="w-3 h-3" />}
                        {opp.preemptionRisk === 'Minimal' && <CheckCircle2 className="w-3 h-3" />}
                        {opp.preemptionRisk === 'Moderate' && <AlertCircle className="w-3 h-3" />}
                        <span>{opp.preemptionRisk}</span>
                      </span>
                    </td>

                    {/* Action Column */}
                    <td className="py-3.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {onGroqAnalyze && (
                          <button
                            onClick={() => onGroqAnalyze(opp)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold text-orange-200 bg-orange-950/70 hover:bg-orange-900 border border-orange-500/70 rounded transition-all cursor-pointer shadow-sm hover:shadow-orange-500/20 active:scale-95 whitespace-nowrap"
                            title="Instant Groq LPU Spread Analysis (~520 T/s)"
                          >
                            <Zap className="w-3 h-3 fill-current text-orange-400" />
                            <span>Groq AI</span>
                          </button>
                        )}
                        <button
                          onClick={() => onSelectExecute(opp)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded transition-all cursor-pointer shadow-sm hover:shadow-cyan-500/20 active:scale-95 whitespace-nowrap"
                        >
                          <Zap className="w-3 h-3 fill-current" />
                          <span>Lock Spread</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
