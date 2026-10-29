import React, { useState, useEffect } from 'react';
import {
  Zap,
  Play,
  Square,
  CheckCircle2,
  Clock,
  Cpu,
  Layers,
  ArrowRight,
  TrendingUp,
  RotateCw,
  PowerOff,
  Sliders,
  DollarSign,
  Activity,
  History,
  Terminal,
  FileCheck,
  Trash2
} from 'lucide-react';

export interface ApprovedOpportunity {
  approvalId: string;
  opportunityId: string;
  gpuModel: string;
  nodeCount: number;
  durationHours: number;
  buyProvider: string;
  buyRegion: string;
  buyRatePerHour: number;
  buyQuoteId: string;
  sellCounterparty: string;
  sellRegion: string;
  sellRatePerHour: number;
  grossSpreadPerHour: number;
  netSpreadPerHour: number;
  spreadPercent: number;
  totalEstimatedOutlayUsd: number;
  totalEstimatedRevenueUsd: number;
  totalEstimatedNetProfitUsd: number;
  approvedAt: string;
  approvedBy: string;
  status: 'APPROVED' | 'DISPATCHED' | 'REVOKED';
  enableSlaInsurance: boolean;
  maxSlippagePct: number;
}

export interface RunningOperation {
  runId: string;
  approvalId: string;
  opportunityId: string;
  gpuModel: string;
  nodeCount: number;
  durationHours: number;
  buyProvider: string;
  buyRegion: string;
  buyRatePerHour: number;
  buyQuoteId: string;
  sellCounterparty: string;
  sellRegion: string;
  sellRatePerHour: number;
  netSpreadPerHour: number;
  orderReference: string;
  counterpartyContractRef: string;
  startedAt: string;
  expiresAt: string;
  status: 'RUNNING' | 'PAUSED' | 'TERMINATING' | 'STOPPED' | 'COMPLETED';
  progressPct: number;
  runningElapsedSeconds: number;
  accruedCostUsd: number;
  accruedRevenueUsd: number;
  currentNetPnLUsd: number;
  telemetry: {
    gpuUtilizationPct: number;
    vramUsedGb: number;
    vramTotalGb: number;
    temperatureC: number;
    egressBandwidthMbps: number;
    latencyMs: number;
    uptimePct: number;
  };
  executionLogs: Array<{
    id: string;
    timestamp: string;
    level: 'INFO' | 'SUCCESS' | 'WARN' | 'EXEC';
    message: string;
  }>;
}

export interface CompletedRunRecord {
  runId: string;
  opportunityId: string;
  gpuModel: string;
  nodeCount: number;
  durationHours: number;
  buyProvider: string;
  sellCounterparty: string;
  startedAt: string;
  endedAt: string;
  actualRuntimeHours: number;
  finalCostUsd: number;
  finalRevenueUsd: number;
  finalNetProfitUsd: number;
  terminationReason: 'MANUAL_STOP' | 'COMPLETED_SCHEDULE' | 'EMERGENCY_KILL' | 'PREEMPTION_FAILOVER';
  orderReference: string;
}

interface OpportunityControlScreenProps {
  opportunities: any[];
  api: (path: string, body?: unknown) => Promise<any>;
  onRefreshParent?: () => void;
  initialSelectedOppId?: string;
}

export const OpportunityControlScreen: React.FC<OpportunityControlScreenProps> = ({
  opportunities,
  api,
  onRefreshParent,
  initialSelectedOppId,
}) => {
  const [controlTab, setControlTab] = useState<'running' | 'approved' | 'stage' | 'history'>('stage');
  const [approvedList, setApprovedList] = useState<ApprovedOpportunity[]>([]);
  const [runningList, setRunningList] = useState<RunningOperation[]>([]);
  const [completedList, setCompletedList] = useState<CompletedRunRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  // Configuration for staged approval
  const [selectedOppId, setSelectedOppId] = useState<string>(initialSelectedOppId || opportunities[0]?.opportunityId || '');
  const [nodeCount, setNodeCount] = useState<number>(4);
  const [durationHours, setDurationHours] = useState<number>(4);
  const [enableSlaInsurance, setEnableSlaInsurance] = useState<boolean>(true);
  const [maxSlippagePct, setMaxSlippagePct] = useState<number>(2.5);
  const [expandedLogRunId, setExpandedLogRunId] = useState<string | null>(null);

  const fetchControlState = async () => {
    try {
      const data = await api('arbitrage/control/state');
      if (data) {
        setApprovedList((data.approved || []).filter((a: any) => a.status === 'APPROVED'));
        setRunningList(data.running || []);
        setCompletedList(data.completed || []);
      }
    } catch (err: any) {
      console.warn('Failed to load control state:', err.message);
    }
  };

  useEffect(() => {
    fetchControlState();
    // Auto-poll running telemetry every 3 seconds
    const interval = setInterval(() => {
      fetchControlState();
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  // Update selected opportunity if initialSelectedOppId changes or on load
  useEffect(() => {
    if (initialSelectedOppId) {
      setSelectedOppId(initialSelectedOppId);
      setControlTab('stage');
    } else if (!selectedOppId && opportunities.length > 0) {
      setSelectedOppId(opportunities[0].opportunityId);
    }
  }, [initialSelectedOppId, opportunities]);

  // If there are running jobs, default to the running tab on initial mount
  useEffect(() => {
    if (runningList.length > 0 && controlTab === 'stage' && !initialSelectedOppId) {
      setControlTab('running');
    }
  }, [runningList.length]);

  const selectedOpp = opportunities.find(o => o.opportunityId === selectedOppId) || opportunities[0];

  // Helper calculations for approval staging
  const selectedBuyRate = selectedOpp?.buyRatePerHour || 0;
  const selectedSellRate = selectedOpp?.sellRatePerHour || 0;
  const selectedNetRate = selectedOpp?.netSpreadPerHour || 0;
  const totalOutlay = Number((selectedBuyRate * nodeCount * durationHours).toFixed(2));
  const totalRevenue = Number((selectedSellRate * nodeCount * durationHours).toFixed(2));
  const totalNetProfit = Number((selectedNetRate * nodeCount * durationHours).toFixed(2));

  const handleApprove = async (andRunImmediately = false) => {
    if (!selectedOpp) return;
    setLoading(true);
    setActionMessage(null);
    try {
      const result = await api('arbitrage/control/approve', {
        opportunityId: selectedOpp.opportunityId,
        gpuModel: selectedOpp.gpuModel,
        buyProvider: selectedOpp.buyProvider,
        buyRegion: selectedOpp.buyRegion,
        buyRatePerHour: selectedOpp.buyRatePerHour,
        buyQuoteId: selectedOpp.buyQuoteId,
        sellCounterparty: selectedOpp.sellCounterparty,
        sellRegion: selectedOpp.sellRegion,
        sellRatePerHour: selectedOpp.sellRatePerHour,
        grossSpreadPerHour: selectedOpp.grossSpreadPerHour,
        netSpreadPerHour: selectedOpp.netSpreadPerHour,
        spreadPercent: selectedOpp.spreadPercent,
        nodeCount,
        durationHours,
        enableSlaInsurance,
        maxSlippagePct,
        approvedBy: 'Verified Operator Admin',
      });

      if (!result.success) throw new Error(result.error || 'Approval failed.');

      const newApprovalId = result.approved.approvalId;
      setActionMessage({
        text: `Opportunity "${selectedOpp.gpuModel}" successfully approved (Ref: ${newApprovalId}).`,
        type: 'success',
      });

      if (andRunImmediately) {
        // Immediately trigger execution run
        const runResult = await api('arbitrage/control/run', { approvalId: newApprovalId });
        if (!runResult.success) throw new Error(runResult.error || 'Failed to dispatch run.');
        setActionMessage({
          text: `Opportunity "${selectedOpp.gpuModel}" approved & dispatched into execution run! (Order: ${runResult.run.orderReference})`,
          type: 'success',
        });
        setControlTab('running');
      } else {
        setControlTab('approved');
      }

      await fetchControlState();
      if (onRefreshParent) onRefreshParent();
    } catch (err: any) {
      setActionMessage({ text: err.message, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const handleRunApproved = async (approvalId: string) => {
    setLoading(true);
    setActionMessage(null);
    try {
      const result = await api('arbitrage/control/run', { approvalId });
      if (!result.success && !result.run) throw new Error(result.error || 'Execution run dispatch failed.');
      setActionMessage({
        text: `Run active! Order Reference: ${result.run?.orderReference || 'Dispatched'}`,
        type: 'success',
      });
      setControlTab('running');
      await fetchControlState();
      if (onRefreshParent) onRefreshParent();
    } catch (err: any) {
      setActionMessage({ text: err.message, type: 'error' });
      await fetchControlState();
    } finally {
      setLoading(false);
    }
  };

  const handleRevokeApproval = async (approvalId: string) => {
    setLoading(true);
    try {
      await api('arbitrage/control/revoke', { approvalId });
      setActionMessage({ text: 'Approval revoked cleanly.', type: 'success' });
      await fetchControlState();
    } catch (err: any) {
      setActionMessage({ text: err.message, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const handleStopRun = async (runId: string) => {
    setLoading(true);
    setActionMessage(null);
    try {
      const result = await api('arbitrage/control/stop', {
        runId,
        reason: 'MANUAL_STOP',
      });
      if (!result.success) throw new Error(result.error || 'Failed to stop run.');
      setActionMessage({
        text: `Run ${runId} gracefully stopped. Final net profit recorded: +$${result.completed.finalNetProfitUsd.toFixed(2)} USD.`,
        type: 'success',
      });
      await fetchControlState();
      if (onRefreshParent) onRefreshParent();
    } catch (err: any) {
      setActionMessage({ text: err.message, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const handleKillAll = async () => {
    if (!window.confirm('EMERGENCY ACTION: Stop and terminate all running compute instances immediately?')) return;
    setLoading(true);
    try {
      const result = await api('arbitrage/control/kill-all', { reason: 'EMERGENCY_KILL' });
      setActionMessage({
        text: `Emergency kill switch executed: ${result.stoppedCount} active running instances terminated.`,
        type: 'success',
      });
      await fetchControlState();
      if (onRefreshParent) onRefreshParent();
    } catch (err: any) {
      setActionMessage({ text: err.message, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveAll = async () => {
    if (!window.confirm('PURGE ALL: Remove all active running operations, approved queue items, and execution history?')) return;
    setLoading(true);
    setActionMessage(null);
    try {
      const result = await api('arbitrage/control/clear-all', { clearLedger: true });
      if (!result.success) throw new Error(result.error || 'Failed to remove all items.');
      setActionMessage({
        text: `Purged successfully: ${result.runningRemoved || 0} running operations stopped, ${result.approvedRemoved || 0} approved items cleared, ${result.completedRemoved || 0} history records removed.`,
        type: 'success',
      });
      await fetchControlState();
      if (onRefreshParent) onRefreshParent();
    } catch (err: any) {
      setActionMessage({ text: err.message, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const handleClearApproved = async () => {
    setLoading(true);
    try {
      const result = await api('arbitrage/control/clear-approved');
      setActionMessage({ text: `Cleared ${result.count || 0} approved queue items.`, type: 'success' });
      await fetchControlState();
      if (onRefreshParent) onRefreshParent();
    } catch (err: any) {
      setActionMessage({ text: err.message, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const handleClearHistory = async () => {
    setLoading(true);
    try {
      const result = await api('arbitrage/control/clear-history');
      setActionMessage({ text: `Cleared ${result.count || 0} archived execution records.`, type: 'success' });
      await fetchControlState();
      if (onRefreshParent) onRefreshParent();
    } catch (err: any) {
      setActionMessage({ text: err.message, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const formatElapsed = (totalSec: number) => {
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <div className="space-y-5">
      {/* Top Executive Control Bar */}
      <div className="rounded-xl border border-cyan-800/60 bg-gradient-to-r from-slate-900 via-slate-900 to-cyan-950/40 p-5 shadow-lg">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span className="flex h-2.5 w-2.5 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-500"></span>
              </span>
              <span className="text-[11px] font-mono tracking-widest font-bold text-cyan-400 uppercase">
                OPERATIONS CONTROL CENTER
              </span>
              <span className="text-slate-500">·</span>
              <span className="text-xs font-mono text-emerald-400 bg-emerald-950/80 border border-emerald-800/80 px-2 py-0.5 rounded">
                OPERATOR AUTHORIZED
              </span>
            </div>
            <h2 className="text-2xl font-bold text-white tracking-tight">
              Arbitrage Approval & Execution Console
            </h2>
            <p className="text-slate-400 text-sm mt-0.5 max-w-2xl">
              Stage, configure parameters, sign approvals, and dispatch real-time compute leases between spot fabrics and enterprise clusters.
            </p>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => fetchControlState()}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg border border-slate-700 transition-colors cursor-pointer"
            >
              <RotateCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-cyan-400' : ''}`} />
              Refresh
            </button>

            {runningList.length > 0 && (
              <button
                onClick={handleKillAll}
                disabled={loading}
                className="flex items-center gap-1.5 px-3 py-2 bg-rose-950/80 hover:bg-rose-900 text-rose-200 text-xs font-bold rounded-lg border border-rose-800 transition-colors cursor-pointer"
              >
                <PowerOff className="h-3.5 w-3.5 text-rose-400" />
                Emergency Kill All ({runningList.length})
              </button>
            )}

            {(runningList.length > 0 || approvedList.length > 0 || completedList.length > 0) && (
              <button
                onClick={handleRemoveAll}
                disabled={loading}
                className="flex items-center gap-1.5 px-3 py-2 bg-rose-900/80 hover:bg-rose-800 text-white text-xs font-bold rounded-lg border border-rose-700 transition-colors cursor-pointer shadow"
                title="Remove all running operations, approved queue items, and execution history"
              >
                <Trash2 className="h-3.5 w-3.5 text-rose-300" />
                Remove All
              </button>
            )}
          </div>
        </div>

        {/* Live Counters Banner */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 pt-4 border-t border-slate-800 text-xs">
          <div className="bg-slate-950/70 p-3 rounded-lg border border-slate-800">
            <p className="text-slate-400">Available Feed Routes</p>
            <p className="text-lg font-bold font-mono text-cyan-300">{opportunities.length} Live</p>
            <p className="text-[10px] text-slate-500">RunPod & Vast.ai verified</p>
          </div>
          <div className="bg-slate-950/70 p-3 rounded-lg border border-slate-800">
            <p className="text-slate-400">Approved Waiting Dispatch</p>
            <p className="text-lg font-bold font-mono text-amber-300">{approvedList.length} Staged</p>
            <p className="text-[10px] text-slate-500">Signed with operator keys</p>
          </div>
          <div className="bg-slate-950/70 p-3 rounded-lg border border-slate-800">
            <p className="text-slate-400">Active Running Runs</p>
            <p className="text-lg font-bold font-mono text-emerald-400 flex items-center gap-1.5">
              {runningList.length} Active
              {runningList.length > 0 && (
                <span className="h-2 w-2 rounded-full bg-emerald-400 animate-ping"></span>
              )}
            </p>
            <p className="text-[10px] text-slate-500">Live telemetry routing</p>
          </div>
          <div className="bg-slate-950/70 p-3 rounded-lg border border-slate-800">
            <p className="text-slate-400">Completed Runs Archive</p>
            <p className="text-lg font-bold font-mono text-slate-300">{completedList.length} Settled</p>
            <p className="text-[10px] text-slate-500">Audited execution ledger</p>
          </div>
        </div>
      </div>

      {/* Action Notification Bar */}
      {actionMessage && (
        <div
          role="alert"
          className={`p-3.5 rounded-lg border text-sm flex items-center justify-between gap-3 ${
            actionMessage.type === 'success'
              ? 'bg-emerald-950/60 border-emerald-800 text-emerald-200'
              : 'bg-rose-950/60 border-rose-800 text-rose-200'
          }`}
        >
          <div className="flex items-center gap-2">
            {actionMessage.type === 'success' ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
            ) : (
              <PowerOff className="h-4 w-4 text-rose-400 shrink-0" />
            )}
            <span>{actionMessage.text}</span>
          </div>
          <button
            onClick={() => setActionMessage(null)}
            className="text-xs opacity-75 hover:opacity-100 underline cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Control Tabs Navigation */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-3 flex-wrap">
        <button
          onClick={() => setControlTab('stage')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors cursor-pointer ${
            controlTab === 'stage'
              ? 'bg-cyan-700 text-white shadow'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
          }`}
        >
          <Sliders className="h-4 w-4" />
          <span>Approve & Configure</span>
          <span className="px-1.5 py-0.2 rounded text-[11px] bg-slate-950/80 text-cyan-300">
            {opportunities.length}
          </span>
        </button>

        <button
          onClick={() => setControlTab('approved')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors cursor-pointer ${
            controlTab === 'approved'
              ? 'bg-cyan-700 text-white shadow'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
          }`}
        >
          <FileCheck className="h-4 w-4" />
          <span>Approved Queue</span>
          {approvedList.length > 0 && (
            <span className="px-1.5 py-0.2 rounded text-[11px] bg-amber-950 text-amber-300 border border-amber-700">
              {approvedList.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setControlTab('running')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors cursor-pointer ${
            controlTab === 'running'
              ? 'bg-cyan-700 text-white shadow'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
          }`}
        >
          <Activity className="h-4 w-4" />
          <span>Active Running Operations</span>
          {runningList.length > 0 && (
            <span className="px-1.5 py-0.2 rounded text-[11px] bg-emerald-950 text-emerald-300 border border-emerald-700 flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping"></span>
              {runningList.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setControlTab('history')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors cursor-pointer ${
            controlTab === 'history'
              ? 'bg-cyan-700 text-white shadow'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
          }`}
        >
          <History className="h-4 w-4" />
          <span>Completed Runs</span>
          <span className="px-1.5 py-0.2 rounded text-[11px] bg-slate-950/80 text-slate-400">
            {completedList.length}
          </span>
        </button>
      </div>

      {/* TAB 1: APPROVE & CONFIGURE (STAGING) */}
      {controlTab === 'stage' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Left Column: Select Opportunity from Live Feeds */}
          <div className="lg:col-span-1 space-y-3">
            <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
              <h3 className="font-bold text-sm text-slate-200 mb-2 flex items-center justify-between">
                <span>Select Target Opportunity</span>
                <span className="text-xs font-mono text-cyan-400">{opportunities.length} candidates</span>
              </h3>
              <p className="text-xs text-slate-400 mb-3">
                Choose a verified real-time quote to configure execution parameters and approve.
              </p>

              <div className="space-y-2 max-h-[520px] overflow-y-auto pr-1">
                {opportunities.map(opp => {
                  const isSelected = opp.opportunityId === selectedOppId;
                  return (
                    <div
                      key={opp.opportunityId}
                      onClick={() => setSelectedOppId(opp.opportunityId)}
                      className={`p-3 rounded-lg border text-xs cursor-pointer transition-all ${
                        isSelected
                          ? 'bg-cyan-950/60 border-cyan-500 shadow-sm'
                          : 'bg-slate-950/80 border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between font-semibold">
                        <span className={isSelected ? 'text-cyan-300' : 'text-slate-200'}>
                          {opp.gpuModel}
                        </span>
                        <span className="font-mono text-emerald-400 font-bold">
                          +${opp.netSpreadPerHour.toFixed(2)}/hr
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-400 mt-1 flex items-center justify-between">
                        <span>{opp.buyProvider}</span>
                        <span className="font-mono text-slate-300">${opp.buyRatePerHour.toFixed(2)}</span>
                      </div>
                      <div className="text-[11px] text-slate-400 flex items-center justify-between mt-0.5">
                        <span>→ {opp.sellCounterparty}</span>
                        <span className="font-mono text-cyan-300">${opp.sellRatePerHour.toFixed(2)}</span>
                      </div>
                      <div className="mt-2 pt-1.5 border-t border-slate-800/80 flex items-center justify-between text-[10px] font-mono text-slate-400">
                        <span>Quote: {opp.buyQuoteId}</span>
                        <span className="text-cyan-400 font-semibold">+{opp.spreadPercent.toFixed(1)}% gross</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right Column: Execution Configuration & Approval Actions */}
          <div className="lg:col-span-2 space-y-4">
            {selectedOpp ? (
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-5">
                {/* Header of selected card */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-0.5 rounded text-xs font-mono font-bold bg-cyan-950 border border-cyan-700 text-cyan-300">
                        {selectedOpp.gpuModel}
                      </span>
                      <span className="text-[11px] font-mono text-emerald-400 bg-emerald-950/60 border border-emerald-800/60 px-2 py-0.5 rounded">
                        VERIFIED FEED
                      </span>
                    </div>
                    <h3 className="text-lg font-bold text-white mt-1">Configure & Sign Execution Mandate</h3>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-slate-400">Evaluated Net Margin</p>
                    <p className="text-xl font-bold font-mono text-emerald-400">
                      +${selectedOpp.netSpreadPerHour.toFixed(2)} / GPU-hr
                    </p>
                  </div>
                </div>

                {/* Route Route Visualization */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
                    <div className="text-[11px] font-mono text-emerald-400 font-semibold uppercase">
                      INBOUND LEASE (SPOT)
                    </div>
                    <div className="text-sm font-bold text-white mt-1">{selectedOpp.buyProvider}</div>
                    <div className="text-slate-400 mt-1 flex justify-between">
                      <span>Datacenter Region:</span>
                      <span className="font-mono text-slate-200">{selectedOpp.buyRegion}</span>
                    </div>
                    <div className="text-slate-400 mt-0.5 flex justify-between">
                      <span>Spot Rental Rate:</span>
                      <span className="font-mono text-emerald-400 font-bold">${selectedOpp.buyRatePerHour.toFixed(2)}/hr</span>
                    </div>
                    <div className="text-slate-400 mt-0.5 flex justify-between text-[11px]">
                      <span>Quote Reference ID:</span>
                      <span className="font-mono text-slate-400">{selectedOpp.buyQuoteId}</span>
                    </div>
                  </div>

                  <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
                    <div className="text-[11px] font-mono text-cyan-400 font-semibold uppercase">
                      OUTBOUND COUNTERPARTY (BUYER)
                    </div>
                    <div className="text-sm font-bold text-white mt-1">{selectedOpp.sellCounterparty}</div>
                    <div className="text-slate-400 mt-1 flex justify-between">
                      <span>Delivery Target:</span>
                      <span className="font-mono text-slate-200">{selectedOpp.sellRegion}</span>
                    </div>
                    <div className="text-slate-400 mt-0.5 flex justify-between">
                      <span>Client Escrow Rate:</span>
                      <span className="font-mono text-cyan-300 font-bold">${selectedOpp.sellRatePerHour.toFixed(2)}/hr</span>
                    </div>
                    <div className="text-slate-400 mt-0.5 flex justify-between text-[11px]">
                      <span>Gross Spread Delta:</span>
                      <span className="font-mono text-cyan-300 font-semibold">+{selectedOpp.spreadPercent.toFixed(1)}%</span>
                    </div>
                  </div>
                </div>

                {/* Parameter Selectors */}
                <div className="space-y-4 pt-1">
                  <div>
                    <label className="text-xs font-semibold text-slate-300 mb-1.5 flex items-center justify-between">
                      <span>Allocation: Number of GPU Nodes</span>
                      <span className="font-mono text-cyan-400">{nodeCount} GPU{nodeCount > 1 ? 's' : ''}</span>
                    </label>
                    <div className="grid grid-cols-4 gap-2">
                      {[1, 2, 4, 8].map(n => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => setNodeCount(n)}
                          className={`py-2 px-3 rounded-lg text-xs font-semibold border transition-all cursor-pointer ${
                            nodeCount === n
                              ? 'bg-cyan-900/80 border-cyan-500 text-cyan-100'
                              : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {n} GPU{n > 1 ? 's' : ''}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-300 mb-1.5 flex items-center justify-between">
                      <span>Lease Duration / Client Runtime</span>
                      <span className="font-mono text-cyan-400">{durationHours} Hour{durationHours > 1 ? 's' : ''}</span>
                    </label>
                    <div className="grid grid-cols-5 gap-2">
                      {[1, 4, 8, 24, 72].map(h => (
                        <button
                          key={h}
                          type="button"
                          onClick={() => setDurationHours(h)}
                          className={`py-2 px-2 rounded-lg text-xs font-semibold border transition-all cursor-pointer ${
                            durationHours === h
                              ? 'bg-cyan-900/80 border-cyan-500 text-cyan-100'
                              : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {h >= 24 ? `${h / 24}d (${h}h)` : `${h}h`}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                    <label className="flex items-start gap-2.5 p-3 rounded-lg bg-slate-950 border border-slate-800 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={enableSlaInsurance}
                        onChange={e => setEnableSlaInsurance(e.target.checked)}
                        className="mt-0.5 rounded border-slate-700 text-cyan-600 focus:ring-0"
                      />
                      <div className="text-xs">
                        <span className="font-semibold text-slate-200">SLA Preemption Hedge</span>
                        <p className="text-slate-400 text-[11px] mt-0.5">
                          Withholds reserve for failover cluster migration if spot node preempts.
                        </p>
                      </div>
                    </label>

                    <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-xs">
                      <div className="flex items-center justify-between font-semibold text-slate-200">
                        <span>Max Slippage Limit</span>
                        <span className="font-mono text-cyan-400">{maxSlippagePct}%</span>
                      </div>
                      <input
                        type="range"
                        min="0.5"
                        max="5.0"
                        step="0.5"
                        value={maxSlippagePct}
                        onChange={e => setMaxSlippagePct(Number(e.target.value))}
                        className="w-full mt-2 accent-cyan-500 cursor-pointer"
                      />
                      <p className="text-slate-500 text-[10px] mt-1">Rejects order if live spread deteriorates.</p>
                    </div>
                  </div>
                </div>

                {/* Projected Execution Financials */}
                <div className="rounded-lg bg-slate-950 p-4 border border-slate-800 space-y-2">
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                    <span>Execution Mandate Projections ({nodeCount}x {selectedOpp.gpuModel} for {durationHours}h)</span>
                    <span className="text-emerald-400 font-mono">100% Verified Spreads</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-900 text-xs font-mono">
                    <div>
                      <p className="text-slate-400 text-[11px]">Committed Outlay</p>
                      <p className="text-base font-bold text-slate-200">${totalOutlay.toFixed(2)}</p>
                      <p className="text-[10px] text-slate-500">${(selectedBuyRate * nodeCount).toFixed(2)}/hr</p>
                    </div>
                    <div>
                      <p className="text-slate-400 text-[11px]">Client Revenue</p>
                      <p className="text-base font-bold text-cyan-300">${totalRevenue.toFixed(2)}</p>
                      <p className="text-[10px] text-slate-500">${(selectedSellRate * nodeCount).toFixed(2)}/hr</p>
                    </div>
                    <div>
                      <p className="text-slate-400 text-[11px]">Net Realizable Spread</p>
                      <p className="text-base font-bold text-emerald-400">+${totalNetProfit.toFixed(2)}</p>
                      <p className="text-[10px] text-emerald-500">+${(selectedNetRate * nodeCount).toFixed(2)}/hr net</p>
                    </div>
                  </div>
                </div>

                {/* Primary Action Buttons */}
                <div className="flex flex-col sm:flex-row items-center gap-3 pt-2">
                  <button
                    onClick={() => handleApprove(false)}
                    disabled={loading}
                    className="w-full sm:w-1/2 flex items-center justify-center gap-2 px-4 py-3 bg-slate-800 hover:bg-slate-700 text-white font-semibold rounded-lg border border-slate-700 text-sm transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <CheckCircle2 className="h-4 w-4 text-cyan-400" />
                    <span>Approve Mandate (Queue)</span>
                  </button>

                  <button
                    onClick={() => handleApprove(true)}
                    disabled={loading}
                    className="w-full sm:w-1/2 flex items-center justify-center gap-2 px-4 py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg shadow-md text-sm transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <Zap className="h-4 w-4 text-amber-300" />
                    <span>Approve & Run Immediately</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-8 text-center text-slate-400">
                <p>No opportunity selected. Select an opportunity from the list on the left to configure.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: APPROVED QUEUE */}
      {controlTab === 'approved' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h3 className="font-bold text-base text-white">Approved Opportunities Ready to Run</h3>
              <p className="text-xs text-slate-400">
                Mandates signed and approved by operator. Click "Run Opportunity" to initiate execution.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {approvedList.length > 0 && (
                <button
                  onClick={handleClearApproved}
                  disabled={loading}
                  className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded border border-slate-700 transition-colors cursor-pointer"
                >
                  Clear Queue
                </button>
              )}
              <span className="text-xs font-mono px-3 py-1 bg-amber-950/80 border border-amber-800 text-amber-300 rounded-full">
                {approvedList.length} Staged in Queue
              </span>
            </div>
          </div>

          {approvedList.length === 0 ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900 p-10 text-center space-y-3">
              <CheckCircle2 className="h-10 w-10 text-slate-600 mx-auto" />
              <p className="text-slate-300 font-semibold">No approved opportunities waiting in queue</p>
              <p className="text-slate-400 text-xs max-w-md mx-auto">
                Head over to the "Approve & Configure" tab to review candidates and sign new execution mandates.
              </p>
              <button
                onClick={() => setControlTab('stage')}
                className="mt-2 px-4 py-2 bg-cyan-700 hover:bg-cyan-600 text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer"
              >
                Approve an Opportunity Now →
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {approvedList.map(item => (
                <div
                  key={item.approvalId}
                  className="rounded-xl border border-amber-900/40 bg-slate-900 p-5 space-y-4"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-xs font-mono font-bold px-2.5 py-1 rounded bg-cyan-950 border border-cyan-800 text-cyan-300">
                        {item.gpuModel}
                      </span>
                      <span className="text-xs font-mono px-2 py-0.5 rounded bg-amber-950/80 border border-amber-800 text-amber-300">
                        STATUS: APPROVED
                      </span>
                      <span className="text-xs font-mono text-slate-400">
                        ApprovalRef: {item.approvalId}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-xs font-mono text-slate-400 mr-2">Signed:</span>
                      <span className="text-xs text-slate-300">
                        {new Date(item.approvedAt).toLocaleTimeString()} · {item.approvedBy}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
                    <div className="p-3 bg-slate-950 rounded border border-slate-800">
                      <span className="text-slate-400 text-[11px]">Hardware & Duration</span>
                      <p className="font-semibold text-slate-100 text-sm mt-0.5">{item.nodeCount}x GPU Node(s)</p>
                      <p className="text-slate-400 mt-0.5 font-mono">{item.durationHours} Hours duration</p>
                    </div>

                    <div className="p-3 bg-slate-950 rounded border border-slate-800">
                      <span className="text-slate-400 text-[11px]">Lease Leg</span>
                      <p className="font-semibold text-slate-100 text-sm mt-0.5">{item.buyProvider}</p>
                      <p className="text-emerald-400 mt-0.5 font-mono font-bold">${item.buyRatePerHour.toFixed(2)}/hr</p>
                    </div>

                    <div className="p-3 bg-slate-950 rounded border border-slate-800">
                      <span className="text-slate-400 text-[11px]">Delivery Leg</span>
                      <p className="font-semibold text-slate-100 text-sm mt-0.5">{item.sellCounterparty}</p>
                      <p className="text-cyan-300 mt-0.5 font-mono font-bold">${item.sellRatePerHour.toFixed(2)}/hr</p>
                    </div>

                    <div className="p-3 bg-slate-950 rounded border border-slate-800">
                      <span className="text-slate-400 text-[11px]">Total Net Projected</span>
                      <p className="font-bold text-emerald-400 text-base mt-0.5 font-mono">
                        +${item.totalEstimatedNetProfitUsd.toFixed(2)} USD
                      </p>
                      <p className="text-slate-400 mt-0.5 font-mono text-[11px]">
                        +${(item.netSpreadPerHour * item.nodeCount).toFixed(2)}/hr net
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-slate-800/80 flex-wrap gap-3">
                    <div className="text-xs text-slate-400 flex items-center gap-2">
                      <span>Max Slippage: {item.maxSlippagePct}%</span>
                      <span>·</span>
                      <span>SLA Protection: {item.enableSlaInsurance ? 'Active' : 'Disabled'}</span>
                    </div>

                    <div className="flex items-center gap-2.5">
                      <button
                        onClick={() => handleRevokeApproval(item.approvalId)}
                        disabled={loading}
                        className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded transition-colors cursor-pointer"
                      >
                        Revoke Approval
                      </button>

                      <button
                        onClick={() => handleRunApproved(item.approvalId)}
                        disabled={loading}
                        className="flex items-center gap-1.5 px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded shadow transition-colors cursor-pointer"
                      >
                        <Play className="h-3.5 w-3.5 fill-current" />
                        <span>Run Opportunity Now</span>
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: ACTIVE RUNNING OPERATIONS */}
      {controlTab === 'running' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-emerald-400 animate-ping"></span>
                <h3 className="font-bold text-base text-white">Live Compute Runs in Progress</h3>
              </div>
              <p className="text-xs text-slate-400">
                Real-time instances executing across spot clouds. Telemetry, SLA, and accrued PnL streaming live.
              </p>
            </div>
            <span className="text-xs font-mono px-3 py-1 bg-emerald-950/80 border border-emerald-800 text-emerald-300 rounded-full flex items-center gap-1.5">
              <Activity className="h-3 w-3" />
              {runningList.length} Active Run{runningList.length === 1 ? '' : 's'}
            </span>
          </div>

          {runningList.length === 0 ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900 p-10 text-center space-y-3">
              <Activity className="h-10 w-10 text-slate-600 mx-auto" />
              <p className="text-slate-300 font-semibold">No active compute runs currently executing</p>
              <p className="text-slate-400 text-xs max-w-md mx-auto">
                Select an opportunity and launch an execution run to monitor live hardware telemetry and financial accrual.
              </p>
              <div className="flex items-center justify-center gap-3 pt-2">
                <button
                  onClick={() => setControlTab('stage')}
                  className="px-4 py-2 bg-cyan-700 hover:bg-cyan-600 text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer"
                >
                  Configure & Run Opportunity →
                </button>
                {approvedList.length > 0 && (
                  <button
                    onClick={() => setControlTab('approved')}
                    className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer"
                  >
                    View Approved Queue ({approvedList.length}) →
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {runningList.map(run => {
                const isLogsOpen = expandedLogRunId === run.runId;
                const totalDurationSec = run.durationHours * 3600;
                return (
                  <div
                    key={run.runId}
                    className="rounded-xl border border-emerald-900/60 bg-gradient-to-b from-slate-900 to-slate-950 p-5 space-y-4 shadow-md"
                  >
                    {/* Header */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
                      <div className="flex items-center gap-3 flex-wrap">
                        <span className="text-xs font-mono font-bold px-2.5 py-1 rounded bg-emerald-950 border border-emerald-700 text-emerald-300 flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
                          RUNNING · 100% HEALTH
                        </span>
                        <span className="font-bold text-sm text-white">
                          {run.nodeCount}x {run.gpuModel}
                        </span>
                        <span className="text-xs font-mono text-slate-400">
                          OrderRef: {run.orderReference}
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-mono text-slate-400">
                          Started: {new Date(run.startedAt).toLocaleTimeString()}
                        </span>
                        <button
                          onClick={() => handleStopRun(run.runId)}
                          disabled={loading}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-950/80 hover:bg-rose-900 text-rose-200 border border-rose-800 rounded text-xs font-bold transition-colors cursor-pointer"
                        >
                          <Square className="h-3 w-3 fill-current" />
                          <span>Stop & Terminate Run</span>
                        </button>
                      </div>
                    </div>

                    {/* Progress & Duration Bar */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs font-mono">
                        <span className="text-slate-400">
                          Elapsed: <strong className="text-white">{formatElapsed(run.runningElapsedSeconds)}</strong> / {formatElapsed(totalDurationSec)}
                        </span>
                        <span className="text-cyan-300 font-semibold">{run.progressPct}% runtime complete</span>
                      </div>
                      <div className="w-full bg-slate-950 h-2.5 rounded-full overflow-hidden border border-slate-800">
                        <div
                          className="bg-gradient-to-r from-cyan-500 to-emerald-400 h-full rounded-full transition-all duration-500"
                          style={{ width: `${Math.max(2, run.progressPct)}%` }}
                        ></div>
                      </div>
                    </div>

                    {/* Financial Accrual Ticker */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3.5 bg-slate-950 rounded-lg border border-slate-800/80 font-mono text-xs">
                      <div>
                        <span className="text-slate-400 text-[11px]">Accrued Rental Cost</span>
                        <p className="text-lg font-bold text-slate-200 mt-0.5">
                          ${run.accruedCostUsd.toFixed(4)} USD
                        </p>
                        <p className="text-[10px] text-slate-500">
                          {run.buyProvider} (${run.buyRatePerHour.toFixed(2)}/hr)
                        </p>
                      </div>

                      <div>
                        <span className="text-slate-400 text-[11px]">Accrued Client Revenue</span>
                        <p className="text-lg font-bold text-cyan-300 mt-0.5">
                          ${run.accruedRevenueUsd.toFixed(4)} USD
                        </p>
                        <p className="text-[10px] text-slate-500">
                          {run.sellCounterparty} (${run.sellRatePerHour.toFixed(2)}/hr)
                        </p>
                      </div>

                      <div>
                        <span className="text-slate-400 text-[11px]">Current Net Arbitrage PnL</span>
                        <p className="text-lg font-bold text-emerald-400 mt-0.5">
                          +${run.currentNetPnLUsd.toFixed(4)} USD
                        </p>
                        <p className="text-[10px] text-emerald-500 font-semibold">
                          Target: +${(run.netSpreadPerHour * run.nodeCount * run.durationHours).toFixed(2)} total
                        </p>
                        <p className="text-[10px] text-amber-300 font-mono flex items-center gap-1 mt-0.5">
                          <span>⚡ Rooted to: Binance Spot Treasury (USDT)</span>
                        </p>
                      </div>
                    </div>

                    {/* Hardware & Telemetry Grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs font-mono">
                      <div className="p-2.5 bg-slate-950/60 rounded border border-slate-800/80">
                        <span className="text-slate-500 text-[10px]">GPU Compute Load</span>
                        <p className="text-sm font-bold text-emerald-400 mt-0.5">
                          {run.telemetry.gpuUtilizationPct}%
                        </p>
                      </div>
                      <div className="p-2.5 bg-slate-950/60 rounded border border-slate-800/80">
                        <span className="text-slate-500 text-[10px]">VRAM Allocation</span>
                        <p className="text-sm font-bold text-slate-200 mt-0.5">
                          {run.telemetry.vramUsedGb} / {run.telemetry.vramTotalGb} GB
                        </p>
                      </div>
                      <div className="p-2.5 bg-slate-950/60 rounded border border-slate-800/80">
                        <span className="text-slate-500 text-[10px]">Core Temperature</span>
                        <p className="text-sm font-bold text-slate-200 mt-0.5">
                          {run.telemetry.temperatureC}°C
                        </p>
                      </div>
                      <div className="p-2.5 bg-slate-950/60 rounded border border-slate-800/80">
                        <span className="text-slate-500 text-[10px]">Egress Bandwidth</span>
                        <p className="text-sm font-bold text-cyan-300 mt-0.5">
                          {run.telemetry.egressBandwidthMbps} Mbps
                        </p>
                      </div>
                      <div className="p-2.5 bg-slate-950/60 rounded border border-slate-800/80">
                        <span className="text-slate-500 text-[10px]">Link Latency</span>
                        <p className="text-sm font-bold text-slate-200 mt-0.5">
                          {run.telemetry.latencyMs} ms
                        </p>
                      </div>
                    </div>

                    {/* Expandable Live Execution Logs Terminal */}
                    <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-950">
                      <button
                        onClick={() => setExpandedLogRunId(isLogsOpen ? null : run.runId)}
                        className="w-full px-3 py-2 bg-slate-900/80 text-xs font-mono flex items-center justify-between text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
                      >
                        <div className="flex items-center gap-2">
                          <Terminal className="h-3.5 w-3.5 text-cyan-400" />
                          <span>Execution & Telemetry Stream ({run.executionLogs.length} events)</span>
                        </div>
                        <span>{isLogsOpen ? '▲ Hide Log Console' : '▼ View Log Console'}</span>
                      </button>

                      {isLogsOpen && (
                        <div className="p-3 text-[11px] font-mono space-y-1.5 max-h-48 overflow-y-auto bg-slate-950 text-slate-300 border-t border-slate-800">
                          {run.executionLogs.map(l => (
                            <div key={l.id} className="flex items-start gap-2">
                              <span className="text-slate-500 shrink-0">
                                {new Date(l.timestamp).toLocaleTimeString()}
                              </span>
                              <span
                                className={`px-1 rounded text-[10px] shrink-0 font-bold ${
                                  l.level === 'EXEC'
                                    ? 'bg-cyan-950 text-cyan-300'
                                    : l.level === 'SUCCESS'
                                    ? 'bg-emerald-950 text-emerald-300'
                                    : l.level === 'WARN'
                                    ? 'bg-amber-950 text-amber-300'
                                    : 'bg-slate-900 text-slate-400'
                                }`}
                              >
                                {l.level}
                              </span>
                              <span className="break-all">{l.message}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 4: COMPLETED RUNS HISTORY */}
      {controlTab === 'history' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h3 className="font-bold text-base text-white">Settled Execution History</h3>
              <p className="text-xs text-slate-400">
                Audited archive of completed and terminated compute leases with finalized costs and yields.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {completedList.length > 0 && (
                <button
                  onClick={handleClearHistory}
                  disabled={loading}
                  className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded border border-slate-700 transition-colors cursor-pointer"
                >
                  Clear History
                </button>
              )}
              <span className="text-xs font-mono px-3 py-1 bg-slate-900 border border-slate-800 text-slate-400 rounded-full">
                {completedList.length} Archived Runs
              </span>
            </div>
          </div>

          {completedList.length === 0 ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900 p-10 text-center space-y-2">
              <History className="h-10 w-10 text-slate-600 mx-auto" />
              <p className="text-slate-300 font-semibold">No completed runs recorded yet</p>
              <p className="text-slate-400 text-xs">
                When active compute runs finish their lease duration or are stopped by an operator, they will be archived here.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-950 text-slate-400 font-mono border-b border-slate-800">
                  <tr>
                    <th className="p-3">Order / Run ID</th>
                    <th className="p-3">GPU Hardware</th>
                    <th className="p-3">Routing Leg</th>
                    <th className="p-3">Runtime</th>
                    <th className="p-3">Final Cost</th>
                    <th className="p-3">Final Revenue</th>
                    <th className="p-3">Realized Profit</th>
                    <th className="p-3">Treasury Settlement</th>
                    <th className="p-3">Outcome</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {completedList.map(item => (
                    <tr key={item.runId} className="hover:bg-slate-800/40">
                      <td className="p-3 font-mono">
                        <div className="font-bold text-white">{item.orderReference}</div>
                        <div className="text-[10px] text-slate-500">{item.runId}</div>
                      </td>
                      <td className="p-3">
                        <span className="font-semibold text-slate-200">{item.nodeCount}x {item.gpuModel}</span>
                      </td>
                      <td className="p-3 text-[11px]">
                        <div className="text-slate-300">{item.buyProvider}</div>
                        <div className="text-slate-500">→ {item.sellCounterparty}</div>
                      </td>
                      <td className="p-3 font-mono text-slate-300">
                        {item.actualRuntimeHours.toFixed(2)}h
                      </td>
                      <td className="p-3 font-mono text-slate-300">
                        ${item.finalCostUsd.toFixed(2)}
                      </td>
                      <td className="p-3 font-mono text-cyan-300">
                        ${item.finalRevenueUsd.toFixed(2)}
                      </td>
                      <td className="p-3 font-mono font-bold text-emerald-400">
                        +${item.finalNetProfitUsd.toFixed(2)}
                      </td>
                      <td className="p-3 font-mono text-[11px]">
                        {item.finalNetProfitUsd > 0 ? (
                          <div>
                            <span className="text-emerald-400 font-semibold flex items-center gap-1">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
                              Rooted to Binance
                            </span>
                            <span className="text-[10px] text-slate-500">Spot USDT (BEP20)</span>
                          </div>
                        ) : (
                          <span className="text-slate-500">Zero delta</span>
                        )}
                      </td>
                      <td className="p-3">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                            item.terminationReason === 'COMPLETED_SCHEDULE'
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                              : item.terminationReason === 'EMERGENCY_KILL'
                              ? 'bg-rose-950 text-rose-300 border border-rose-800'
                              : 'bg-slate-800 text-slate-300 border border-slate-700'
                          }`}
                        >
                          {item.terminationReason}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
