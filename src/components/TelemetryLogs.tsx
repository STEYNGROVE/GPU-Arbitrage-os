import React, { useState, useMemo } from 'react';
import { ExecutionLog } from '../types/arbitrage';
import {
  Terminal,
  Search,
  Filter,
  Download,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  Zap,
  Cpu,
  Layers
} from 'lucide-react';

interface TelemetryLogsProps {
  logs: ExecutionLog[];
  onClearLogs: () => void;
  onAddSimulatedLog: () => void;
}

export const TelemetryLogs: React.FC<TelemetryLogsProps> = ({
  logs,
  onClearLogs,
  onAddSimulatedLog,
}) => {
  const [levelFilter, setLevelFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (levelFilter !== 'all' && log.level !== levelFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          log.message.toLowerCase().includes(q) ||
          log.service.toLowerCase().includes(q) ||
          log.level.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [logs, levelFilter, searchQuery]);

  const handleExportCsv = () => {
    const csvContent =
      'data:text/csv;charset=utf-8,' +
      ['Timestamp,Level,Service,LatencyMs,Message'].join(',') +
      '\n' +
      logs
        .map((l) => `"${l.timestamp}","${l.level}","${l.service}",${l.latencyMs},"${l.message.replace(/"/g, '""')}"`)
        .join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `gpu_arbitrage_v13_logs_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-4">
      {/* Log Toolbar */}
      <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-cyan-400" />
          <span className="text-xs font-bold text-slate-200">Microservice Fleet Execution Telemetry</span>
          <span className="text-[11px] font-mono text-slate-500">
            ({logs.length} events logged)
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onAddSimulatedLog}
            className="px-2.5 py-1 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded transition-colors"
          >
            Trigger Fleet Probe
          </button>
          <button
            onClick={handleExportCsv}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded transition-colors"
          >
            <Download className="w-3 h-3" />
            <span>Export CSV</span>
          </button>
          <button
            onClick={onClearLogs}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-400 hover:text-slate-200 bg-slate-850 hover:bg-slate-800 rounded transition-colors"
          >
            <Trash2 className="w-3 h-3" />
            <span>Clear</span>
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter logs by keyword or worker ID..."
            className="w-full pl-9 pr-3 py-1.5 bg-slate-950/80 border border-slate-700/80 rounded-md text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500"
          />
        </div>

        {/* Level filter tabs */}
        <div className="flex flex-wrap items-center gap-1 text-xs">
          {[
            { id: 'all', label: 'All Levels' },
            { id: 'SPREAD_ALERT', label: 'Spread Alerts' },
            { id: 'ORDER_EXEC', label: 'Order Execs' },
            { id: 'FLEET_SYNC', label: 'Fleet Sync' },
            { id: 'PREEMPTION_HEDGE', label: 'Preemption Hedge' },
            { id: 'SYSTEM_INFO', label: 'System' },
          ].map((lvl) => (
            <button
              key={lvl.id}
              onClick={() => setLevelFilter(lvl.id)}
              className={`px-2.5 py-1 rounded transition-colors ${
                levelFilter === lvl.id
                  ? 'bg-cyan-500/20 text-cyan-300 font-medium border border-cyan-500/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {lvl.label}
            </button>
          ))}
        </div>
      </div>

      {/* Logs Console Box */}
      <div className="bg-[#060910] border border-slate-800 rounded-lg p-4 font-mono text-xs overflow-x-auto max-h-[580px] overflow-y-auto space-y-2">
        {filteredLogs.length === 0 ? (
          <div className="py-8 text-center text-slate-500">
            No logs match the current criteria.
          </div>
        ) : (
          filteredLogs.map((log) => {
            let levelColor = 'text-cyan-400';
            if (log.level === 'SPREAD_ALERT') levelColor = 'text-emerald-400 font-bold';
            if (log.level === 'ORDER_EXEC') levelColor = 'text-amber-300 font-bold';
            if (log.level === 'PREEMPTION_HEDGE') levelColor = 'text-purple-400';
            if (log.level === 'FLEET_SYNC') levelColor = 'text-teal-400';

            return (
              <div
                key={log.id}
                className="flex items-start gap-3 py-1 px-2 rounded hover:bg-slate-900/60 transition-colors border-b border-slate-900/50"
              >
                <span className="text-slate-500 shrink-0 tabular-nums">[{log.timestamp}]</span>
                <span className={`shrink-0 w-32 ${levelColor}`}>[{log.level}]</span>
                <span className="text-slate-400 shrink-0 w-44 truncate text-[11px]">
                  @{log.service}
                </span>
                <span className="text-slate-200 flex-1 leading-relaxed">{log.message}</span>
                <span className="text-slate-500 shrink-0 text-[11px] tabular-nums">
                  {log.latencyMs.toFixed(1)}ms
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
