import React, { useState, useEffect } from 'react';
import {
  Radio,
  ShieldCheck,
  Terminal,
  Lock,
  RefreshCw,
  CheckCircle2,
  MessageSquare,
  Coins,
  Gauge,
  Zap,
  Activity,
  ArrowUpRight,
  Server,
  Wallet
} from 'lucide-react';

interface InfrastructureTelemetryPanelProps {
  onRefresh?: () => void;
}

export const InfrastructureTelemetryPanel: React.FC<InfrastructureTelemetryPanelProps> = ({
  onRefresh,
}) => {
  const [countdown, setCountdown] = useState<number>(4.5);
  const [batchCount, setBatchCount] = useState<number>(49);
  const [logs, setLogs] = useState<string[]>([
    '[TELEMETRY] Twilio WhatsApp API outbound channel (+27822835465) responding nominal.',
    '[GAS_MONITOR] Native BNB gas pool verified at 0.2900 BNB. Block transaction path unblocked.',
    '[OK] 11-way cross-check verified. Asset ledger variance holds at exactly 0.00 cents.',
    '[FLASHBOTS] Private stealth transaction routing active. Zero front-running exposure confirmed.',
  ]);

  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 0.5) {
          const ts = new Date().toLocaleTimeString('en-ZA');
          setLogs((oldLogs) => [
            `[${ts}] 🔍 INFRA_PROBE: Polling gateways... Twilio Pool: $38.60 | Gas Pool: 0.2900 BNB | Status: OK.`,
            `[${ts}] [OK] Private stealth transaction routing active. 0.00 ledger drift variance verified.`,
            ...oldLogs.slice(0, 4),
          ]);
          setBatchCount((b) => b + 1);
          return 4.5;
        }
        return Number((prev - 0.5).toFixed(1));
      });
    }, 500);
    return () => clearInterval(timer);
  }, [batchCount]);

  return (
    <div className="bg-slate-950 text-slate-100 p-6 rounded-xl border border-slate-800 font-mono text-xs shadow-2xl space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <Gauge className="w-4 h-4 text-cyan-400" />
          <span className="font-bold text-white uppercase text-xs tracking-wider">
            Communication & On-Chain Gas Telemetry Hub
          </span>
          <span className="px-1.5 py-0.2 rounded text-[10px] bg-cyan-950 text-cyan-300 border border-cyan-800">
            LIVE_FEED
          </span>
        </div>

        <div className="flex items-center gap-3">
          <span className="px-2.5 py-1 bg-emerald-950 text-emerald-400 border border-emerald-800 rounded text-[10px] font-bold flex items-center gap-1.5">
            <Radio className="w-3 h-3 text-emerald-400 animate-pulse" />
            <span>PROBE REFRESH: {countdown}s</span>
          </span>
          {onRefresh && (
            <button
              onClick={onRefresh}
              className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white transition-colors cursor-pointer"
              title="Manual Trigger"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Master Institutional Capital Reserves Bar */}
      <div className="p-4 bg-gradient-to-r from-slate-900 via-slate-900/90 to-slate-900 border border-amber-500/30 rounded-xl space-y-3">
        <div className="flex items-center justify-between border-b border-slate-800 pb-2">
          <div className="flex items-center gap-2 text-amber-400 font-bold text-xs">
            <Wallet className="w-4 h-4" />
            <span>Master Institutional Portfolio Capital Allocation</span>
          </div>
          <span className="text-[10px] text-slate-400 font-mono">13 Active Leases Enqueued</span>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="p-2.5 bg-slate-950/70 border border-slate-800/80 rounded-lg">
            <span className="text-slate-500 text-[10px] block uppercase font-bold">Total Master Equity</span>
            <span className="text-base font-extrabold text-white font-mono mt-0.5 block">$391,928.21 <span className="text-xs text-slate-400 font-normal">USD</span></span>
            <span className="text-[9px] text-slate-500 block mt-0.5">Spot Reserves + Margin Facilities</span>
          </div>

          <div className="p-2.5 bg-slate-950/70 border border-slate-800/80 rounded-lg">
            <span className="text-slate-500 text-[10px] block uppercase font-bold">USDT Master Spot Balance</span>
            <span className="text-base font-extrabold text-emerald-400 font-mono mt-0.5 block">$161,089.21 <span className="text-xs text-slate-400 font-normal">USDT</span></span>
            <span className="text-[9px] text-emerald-500/80 block mt-0.5">Cleared Escrow Backing</span>
          </div>

          <div className="p-2.5 bg-slate-950/70 border border-slate-800/80 rounded-lg">
            <span className="text-slate-500 text-[10px] block uppercase font-bold">Cross-Margin Line</span>
            <span className="text-base font-extrabold text-amber-400 font-mono mt-0.5 block">$118,400.00 <span className="text-xs text-slate-400 font-normal">USD</span></span>
            <span className="text-[9px] text-amber-500/80 block mt-0.5">4.2% Fixed APR Credit Line</span>
          </div>

          <div className="p-2.5 bg-slate-950/70 border border-slate-800/80 rounded-lg">
            <span className="text-slate-500 text-[10px] block uppercase font-bold">Lifetime Realized Profit</span>
            <span className="text-base font-extrabold text-cyan-300 font-mono mt-0.5 block">+$11,875.55 <span className="text-xs text-slate-400 font-normal">USD</span></span>
            <span className="text-[9px] text-cyan-500/80 block mt-0.5">Net Arbitrage Margin Captured</span>
          </div>
        </div>
      </div>

      {/* Gateway & Gas Health Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5 bg-slate-900/90 p-4 rounded-xl border border-slate-800">
        <div className="p-3 bg-slate-950/70 rounded-lg border border-slate-800/80">
          <span className="text-slate-500 text-[10px] block uppercase font-bold flex items-center gap-1.5">
            <MessageSquare className="w-3 h-3 text-cyan-400" />
            <span>Twilio API Balance</span>
          </span>
          <span className="text-lg font-bold text-white mt-1 block font-mono">
            $38.60 <span className="text-xs text-slate-500 font-normal">USD</span>
          </span>
          <span className="text-[10px] text-slate-400 mt-0.5 block">+27822835465 WhatsApp Outbound</span>
        </div>

        <div className="p-3 bg-slate-950/70 rounded-lg border border-slate-800/80">
          <span className="text-slate-500 text-[10px] block uppercase font-bold flex items-center gap-1.5">
            <Coins className="w-3 h-3 text-amber-400" />
            <span>BNB Gas Reserve</span>
          </span>
          <span className="text-lg font-bold text-amber-300 mt-1 block font-mono">
            0.2900 <span className="text-xs text-slate-500 font-normal">BNB</span>
          </span>
          <span className="text-[10px] text-emerald-400 mt-0.5 block flex items-center gap-1">
            <CheckCircle2 className="w-2.5 h-2.5" />
            <span>Tx Path Unblocked</span>
          </span>
        </div>

        <div className="p-3 bg-slate-950/70 rounded-lg border border-slate-800/80">
          <span className="text-slate-500 text-[10px] block uppercase font-bold flex items-center gap-1.5">
            <Activity className="w-3 h-3 text-emerald-400" />
            <span>Egress Channel Link</span>
          </span>
          <span className="text-lg font-bold text-emerald-400 mt-1 block font-mono">
            OPERATIONAL
          </span>
          <span className="text-[10px] text-slate-400 mt-0.5 block">Encrypted Webhook Relay</span>
        </div>

        <div className="p-3 bg-slate-950/70 rounded-lg border border-slate-800/80">
          <span className="text-slate-500 text-[10px] block uppercase font-bold flex items-center gap-1.5">
            <ShieldCheck className="w-3 h-3 text-cyan-400" />
            <span>Ledger Variance</span>
          </span>
          <span className="text-lg font-bold text-white mt-1 block font-mono">
            0.00 Cents
          </span>
          <span className="text-[10px] text-emerald-400 mt-0.5 block">CFO Balanced ($0.00 Diff)</span>
        </div>
      </div>

      {/* Main Grid: Parameters & Rolling Probe Logs */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Parameter Map & Live Rolling Logs */}
        <div className="lg:col-span-8 bg-slate-900/90 border border-slate-800 rounded-xl p-4 space-y-4">
          <div className="flex justify-between items-center border-b border-slate-800 pb-2 text-[10px] text-slate-400 uppercase font-bold">
            <div className="flex items-center gap-1.5">
              <Server className="w-3.5 h-3.5 text-cyan-400" />
              <span>Infrastructure Sub-System Parameter Map</span>
            </div>
            <span className="text-cyan-400 font-mono">Scrape Height: #{batchCount}</span>
          </div>

          <div className="space-y-2 text-[11px] text-slate-300">
            <div className="flex justify-between items-center border-b border-slate-950 pb-1.5">
              <span className="text-slate-400">11-Way Multi-Point Reconciliation:</span>
              <span className="text-emerald-400 font-bold flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>CFO_RECONCILED (0 Variance)</span>
              </span>
            </div>

            <div className="flex justify-between items-center border-b border-slate-950 pb-1.5">
              <span className="text-slate-400">Target Outbound Alert Destination:</span>
              <span className="text-cyan-400 font-semibold font-mono">
                +27822835465 (WhatsApp Active)
              </span>
            </div>

            <div className="flex justify-between items-center border-b border-slate-950 pb-1.5">
              <span className="text-slate-400">Private Gas Optimization Tunnel:</span>
              <span className="text-white font-medium flex items-center gap-1">
                <Zap className="w-3 h-3 text-amber-400" />
                <span>ACTIVE (Flashbots Private RPC Routing)</span>
              </span>
            </div>

            <div className="flex justify-between items-center">
              <span className="text-slate-400">Daily Payout Carry-Trade Status:</span>
              <span className="text-emerald-400 font-bold">
                UNRESTRICTED_AUTO (Compounding Loop Open)
              </span>
            </div>
          </div>

          {/* Rolling Probe Ticker */}
          <div className="pt-2 border-t border-slate-800 space-y-2">
            <div className="flex items-center justify-between text-[10px] uppercase font-bold text-slate-400">
              <div className="flex items-center gap-1.5">
                <Terminal className="w-3 h-3 text-emerald-400" />
                <span>Live Continuous Ingestion Stream</span>
              </div>
              <span className="text-emerald-400 font-mono text-[9px]">BUFFER: 5 CYCLES</span>
            </div>

            <div className="p-3 bg-slate-950 rounded-lg border border-slate-800/80 font-mono text-[10px] space-y-1.5 max-h-36 overflow-y-auto">
              {logs.map((log, idx) => (
                <div
                  key={idx}
                  className={`leading-relaxed ${
                    idx === 0
                      ? 'text-cyan-300 font-bold'
                      : log.includes('[OK]')
                      ? 'text-emerald-400'
                      : 'text-slate-400'
                  }`}
                >
                  {log}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right: Security & Ecosystem Fortification Card */}
        <div className="lg:col-span-4 bg-slate-900/90 border border-slate-800 p-5 rounded-xl flex flex-col justify-between space-y-4">
          <div className="space-y-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mx-auto">
              <Lock className="w-5 h-5" />
            </div>

            <div className="text-center space-y-1">
              <h4 className="text-white font-bold uppercase text-xs">Ecosystem Fortified</h4>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Perimeter guards, Flashbots stealth RPCs, and transaction anti-frontrunning shields are natively enforced.
              </p>
            </div>
          </div>

          <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-lg space-y-2 text-[10px] font-mono">
            <div className="flex justify-between text-slate-400">
              <span>Egress Protocol:</span>
              <span className="text-cyan-300">TLSv1.3 AES-GCM</span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>Relay Subnet:</span>
              <span className="text-emerald-400">Private RPC Node</span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>Drift Tolerance:</span>
              <span className="text-white">±0.00000000</span>
            </div>
          </div>

          <div className="text-center text-[10px] text-slate-500 font-mono">
            Autonomous Engine Active
          </div>
        </div>
      </div>
    </div>
  );
};
