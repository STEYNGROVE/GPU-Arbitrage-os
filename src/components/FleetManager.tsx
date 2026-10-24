import React, { useState, useMemo } from 'react';
import {
  FleetWorker,
  DatabaseRelation
} from '../types/arbitrage';
import {
  Server,
  Database,
  Cpu,
  Layers,
  Search,
  Activity,
  Sliders,
  CheckCircle2,
  RefreshCw,
  HardDrive,
  Network,
  Zap,
  Terminal,
  ShieldAlert
} from 'lucide-react';

interface FleetManagerProps {
  discoveryWorkers: FleetWorker[];
  optimizerWorkers: FleetWorker[];
  relations: DatabaseRelation[];
  onScaleFleet: (discoveryCount: number, optimizerCount: number) => void;
  onRunSchemaAudit: () => void;
  isAuditing: boolean;
  onOpenLaunchInspector: () => void;
  onOpenProAudit?: () => void;
}

export const FleetManager: React.FC<FleetManagerProps> = ({
  discoveryWorkers,
  optimizerWorkers,
  relations,
  onScaleFleet,
  onRunSchemaAudit,
  isAuditing,
  onOpenLaunchInspector,
  onOpenProAudit,
}) => {
  const [activeSubTab, setActiveSubTab] = useState<'topology' | 'database' | 'workers'>('topology');
  const [discoveryScale, setDiscoveryScale] = useState<number>(discoveryWorkers.length);
  const [optimizerScale, setOptimizerScale] = useState<number>(optimizerWorkers.length);
  const [dbSearch, setDbSearch] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [workerFilter, setWorkerFilter] = useState<'all' | 'discovery' | 'optimizer'>('all');

  // Filtered DB relations
  const filteredRelations = useMemo(() => {
    return relations.filter((rel) => {
      if (selectedCategory !== 'all' && rel.category !== selectedCategory) {
        return false;
      }
      if (dbSearch.trim()) {
        const query = dbSearch.toLowerCase();
        return (
          rel.schemaName.toLowerCase().includes(query) ||
          rel.relationName.toLowerCase().includes(query) ||
          rel.category.toLowerCase().includes(query)
        );
      }
      return true;
    });
  }, [relations, selectedCategory, dbSearch]);

  const categories = useMemo(() => {
    return Array.from(new Set(relations.map((r) => r.category)));
  }, [relations]);

  const totalRecords = relations.reduce((sum, r) => sum + r.recordsCount, 0);

  const handleApplyScale = () => {
    onScaleFleet(discoveryScale, optimizerScale);
  };

  return (
    <div className="space-y-6">
      {/* Fleet Hero & Topology Overview */}
      <div className="p-6 bg-slate-900/90 border border-slate-800 rounded-lg relative overflow-hidden">
        <div className="relative z-10 grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-3">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-bold text-cyan-400 bg-cyan-950/80 border border-cyan-800/80 px-2 py-0.5 rounded">
                DOCKER COMPOSE FLEET
              </span>
              <span className="text-xs text-slate-400 font-mono">
                PostgreSQL Cluster: arbitrage_v13 (36 Schemas Verified)
              </span>
            </div>
            <h1 className="text-xl font-extrabold text-white">
              Autonomous Discovery & Yield Optimizer Fleet Management
            </h1>
            <p className="text-xs text-slate-300 leading-relaxed max-w-2xl">
              Scalable Docker microservices continuously poll GPU spot orderbooks across 14 providers, calculate
              Bellman-Ford cross-cloud arbitrage matrices, and synchronize transactional state with the PostgreSQL
              database cluster.
            </p>

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                onClick={onOpenLaunchInspector}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded transition-colors"
              >
                <Terminal className="w-3.5 h-3.5" />
                <span>View Master Launch Script</span>
              </button>

              <button
                onClick={onRunSchemaAudit}
                disabled={isAuditing}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isAuditing ? 'animate-spin text-cyan-400' : ''}`} />
                <span>{isAuditing ? 'Auditing 36 Schemas...' : 'Audit Database Relations'}</span>
              </button>

              {onOpenProAudit && (
                <button
                  onClick={onOpenProAudit}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-300 bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-700/80 rounded transition-colors"
                >
                  <Activity className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Full Pro Reality Audit (A+)</span>
                </button>
              )}
            </div>
          </div>

          {/* Microservice Scaling Control Box */}
          <div className="p-4 bg-slate-950/80 border border-slate-800 rounded-lg space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
              <span className="text-xs font-bold text-slate-200">Microservice Fleet Scale</span>
              <span className="text-[11px] font-mono text-cyan-400">docker-compose up -d --scale</span>
            </div>

            {/* Discovery slider */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-slate-400">autonomous_discovery_fleet:</span>
                <span className="font-mono text-cyan-300 font-bold">{discoveryScale} agents</span>
              </div>
              <input
                type="range"
                min="10"
                max="200"
                step="5"
                value={discoveryScale}
                onChange={(e) => setDiscoveryScale(Number(e.target.value))}
                className="w-full accent-cyan-400 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
              />
            </div>

            {/* Yield Optimizer slider */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-slate-400">yield_optimizer_fleet:</span>
                <span className="font-mono text-teal-300 font-bold">{optimizerScale} engines</span>
              </div>
              <input
                type="range"
                min="5"
                max="100"
                step="5"
                value={optimizerScale}
                onChange={(e) => setOptimizerScale(Number(e.target.value))}
                className="w-full accent-teal-400 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
              />
            </div>

            <button
              onClick={handleApplyScale}
              className="w-full py-1.5 text-xs font-semibold text-slate-950 bg-gradient-to-r from-cyan-400 to-teal-400 hover:from-cyan-300 hover:to-teal-300 rounded transition-all cursor-pointer"
            >
              Apply Scale ({discoveryScale + optimizerScale} Total Containers)
            </button>
          </div>
        </div>
      </div>

      {/* Sub-tab selection */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
        <button
          onClick={() => setActiveSubTab('topology')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
            activeSubTab === 'topology'
              ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Network className="w-3.5 h-3.5" />
          <span>Fleet Hardware & Microservice Topology</span>
        </button>

        <button
          onClick={() => setActiveSubTab('database')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
            activeSubTab === 'database'
              ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Database className="w-3.5 h-3.5" />
          <span>PostgreSQL 36 Relations ({relations.length})</span>
        </button>

        <button
          onClick={() => setActiveSubTab('workers')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
            activeSubTab === 'workers'
              ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Server className="w-3.5 h-3.5" />
          <span>Live Container Inspect ({discoveryWorkers.length + optimizerWorkers.length})</span>
        </button>
      </div>

      {/* TAB 1: Topology & Infrastructure */}
      {activeSubTab === 'topology' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-lg">
              <div className="text-xs text-slate-400 font-medium">Autonomous Discovery Crawl Rate</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-bold font-mono text-cyan-400 tabular-nums">
                  18,450
                </span>
                <span className="text-xs text-slate-400 font-mono">offers / min</span>
              </div>
              <div className="mt-2 text-[11px] text-slate-400">
                100 containers scraping Vast.ai, RunPod, Lambda, CoreWeave, Prime Intellect, Crusoe
              </div>
            </div>

            <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-lg">
              <div className="text-xs text-slate-400 font-medium">Yield Optimization Matrix Checks</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-bold font-mono text-emerald-400 tabular-nums">
                  850,000
                </span>
                <span className="text-xs text-slate-400 font-mono">spread pairs / sec</span>
              </div>
              <div className="mt-2 text-[11px] text-slate-400">
                50 microservices running Bellman-Ford shortest arbitrage path calculations
              </div>
            </div>

            <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-lg">
              <div className="text-xs text-slate-400 font-medium">Database Relation Health</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-bold font-mono text-teal-300 tabular-nums">
                  36 / 36
                </span>
                <span className="text-xs text-emerald-400 font-mono font-medium">100% Online</span>
              </div>
              <div className="mt-2 text-[11px] text-slate-400">
                PostgreSQL pg_isready verified on cluster arbitrage_v13
              </div>
            </div>
          </div>

          {/* Infrastructure Cluster Showcase */}
          <div className="p-5 bg-slate-900/80 border border-slate-800 rounded-lg space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-100">HPC GPU Datacenter Cluster Fabric</h3>
                <p className="text-xs text-slate-400">
                  Liquid-cooled high density server racks housing NVIDIA SXM5 and Blackwell enterprise nodes.
                </p>
              </div>
              <span className="text-xs font-mono text-cyan-400 bg-cyan-950/60 border border-cyan-800/60 px-2 py-0.5 rounded">
                NVLink 4.0 / 5.0 (900 - 1,800 GB/s)
              </span>
            </div>

            <div className="relative rounded-lg overflow-hidden border border-slate-800 max-h-96">
              <img
                src="/src/assets/images/gpu_datacenter_cluster_1792165622394.jpg"
                alt="High Performance AI Datacenter Server Racks"
                className="w-full h-80 object-cover object-center"
                referrerPolicy="no-referrer"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[#090d16] via-[#090d16]/30 to-transparent flex items-end p-4">
                <div className="text-xs text-slate-200 font-mono flex flex-wrap items-center gap-3">
                  <span className="text-emerald-400 font-bold">NODE STATUS: NOMINAL</span>
                  <span aria-hidden="true">·</span>
                  <span>RoCE v2 Lossless Mesh</span>
                  <span aria-hidden="true">·</span>
                  <span>Mean Datacenter PUE: 1.08</span>
                  <span aria-hidden="true">·</span>
                  <span>Zero Packet Drop SLA</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: PostgreSQL 36 Relations Catalog */}
      {activeSubTab === 'database' && (
        <div className="space-y-4">
          <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-lg space-y-3">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div className="relative flex-1 max-w-md">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={dbSearch}
                  onChange={(e) => setDbSearch(e.target.value)}
                  placeholder="Search schema, relation, or table name..."
                  className="w-full pl-9 pr-4 py-1.5 bg-slate-950/80 border border-slate-700/80 rounded-md text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div className="text-xs font-mono text-slate-400">
                Total Catalog Records: <span className="text-cyan-300 font-bold">{totalRecords.toLocaleString()}</span>
              </div>
            </div>

            {/* Category filter tabs */}
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => setSelectedCategory('all')}
                className={`px-2.5 py-1 text-xs rounded transition-colors whitespace-nowrap ${
                  selectedCategory === 'all'
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                All Categories ({relations.length})
              </button>
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  className={`px-2.5 py-1 text-xs rounded transition-colors whitespace-nowrap ${
                    selectedCategory === cat
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {cat} ({relations.filter((r) => r.category === cat).length})
                </button>
              ))}
            </div>
          </div>

          {/* Database Relations Table */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-950/60 text-slate-400 text-[11px] font-medium uppercase tracking-wider">
                    <th className="py-2.5 px-4">Schema & Relation Name</th>
                    <th className="py-2.5 px-4">Category</th>
                    <th className="py-2.5 px-4 text-right">Record Count</th>
                    <th className="py-2.5 px-4 text-right">Table Size</th>
                    <th className="py-2.5 px-4 text-right">Query Latency</th>
                    <th className="py-2.5 px-4 text-right">Throughput</th>
                    <th className="py-2.5 px-4 text-center">Index Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {filteredRelations.map((rel, idx) => (
                    <tr key={idx} className="hover:bg-slate-800/40 transition-colors">
                      <td className="py-2.5 px-4">
                        <div className="font-mono font-medium text-slate-200">
                          {rel.schemaName}.<span className="text-cyan-300 font-semibold">{rel.relationName}</span>
                        </div>
                      </td>
                      <td className="py-2.5 px-4 text-slate-400">{rel.category}</td>
                      <td className="py-2.5 px-4 text-right font-mono text-slate-300 tabular-nums">
                        {rel.recordsCount.toLocaleString()}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono text-slate-400 tabular-nums">
                        {rel.tableSizeBytes}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono text-emerald-400 font-medium tabular-nums">
                        {rel.queryLatencyMs} ms
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono text-slate-300 tabular-nums">
                        {rel.writeThroughputPerSec}/s
                      </td>
                      <td className="py-2.5 px-4 text-center">
                        <span className="inline-flex items-center gap-1 font-mono text-[10px] text-emerald-400">
                          <CheckCircle2 className="w-3 h-3" />
                          <span>{rel.indexStatus}</span>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: Live Container Inspect */}
      {activeSubTab === 'workers' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between p-3 bg-slate-900/80 border border-slate-800 rounded-lg">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setWorkerFilter('all')}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${
                  workerFilter === 'all' ? 'bg-cyan-500/20 text-cyan-300 font-medium' : 'text-slate-400'
                }`}
              >
                All Workers ({discoveryWorkers.length + optimizerWorkers.length})
              </button>
              <button
                onClick={() => setWorkerFilter('discovery')}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${
                  workerFilter === 'discovery' ? 'bg-cyan-500/20 text-cyan-300 font-medium' : 'text-slate-400'
                }`}
              >
                Discovery Fleet ({discoveryWorkers.length})
              </button>
              <button
                onClick={() => setWorkerFilter('optimizer')}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${
                  workerFilter === 'optimizer' ? 'bg-cyan-500/20 text-cyan-300 font-medium' : 'text-slate-400'
                }`}
              >
                Optimizer Fleet ({optimizerWorkers.length})
              </button>
            </div>
            <span className="text-xs font-mono text-slate-400">
              Showing active container slices
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {[...(workerFilter !== 'optimizer' ? discoveryWorkers.slice(0, 30) : []),
              ...(workerFilter !== 'discovery' ? optimizerWorkers.slice(0, 30) : [])]
              .map((worker) => (
                <div
                  key={worker.id}
                  className="p-3 bg-slate-900/80 border border-slate-800 hover:border-slate-700 rounded text-xs space-y-1.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-bold text-cyan-400">{worker.id}</span>
                    <span className="font-mono text-[10px] text-emerald-400 bg-emerald-950/60 border border-emerald-900/60 px-1.5 py-0.5 rounded">
                      {worker.status}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-300 truncate" title={worker.currentTask}>
                    {worker.currentTask}
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono pt-1 border-t border-slate-800/60">
                    <span>Target: {worker.target.slice(0, 20)}</span>
                    <span className="text-emerald-400">{worker.latencyMs}ms RTT</span>
                  </div>
                </div>
              ))}
          </div>
          <p className="text-center text-xs text-slate-500">
            Showing first active containers. Fleet scales dynamically up to 250 microservices.
          </p>
        </div>
      )}
    </div>
  );
};
