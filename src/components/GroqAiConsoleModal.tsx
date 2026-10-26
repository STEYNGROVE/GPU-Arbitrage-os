import React, { useState, useEffect } from 'react';
import {
  X,
  Zap,
  Cpu,
  Brain,
  Activity,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Send,
  Sliders,
  ShieldCheck,
  TrendingUp,
  Server,
  Terminal,
  ExternalLink,
  ChevronRight,
  Layers,
  Copy,
  Check
} from 'lucide-react';
import { ArbitrageOpportunity } from '../types/arbitrage';

interface GroqAiStatus {
  provider: 'GROQ_LPU_INFERENCE';
  isPrimary: boolean;
  status: 'CONNECTED_LIVE' | 'STANDBY_SIMULATION' | 'OFFLINE';
  model: string;
  hasLiveKey: boolean;
  keyMasked: string;
  inferenceArchitecture: string;
  averageSpeedTokensPerSec: number;
  averageLatencyMs: number;
  capabilities: string[];
}

interface SpreadAnalysisResult {
  opportunityId: string;
  recommendation: 'EXECUTE_IMMEDIATELY' | 'EXECUTE_WITH_HEDGE' | 'HOLD_FOR_BETTER_FILL' | 'REJECT_HIGH_PREEMPTION';
  confidenceScore: number;
  executiveSummary: string;
  strategicRationale: string;
  riskAssessment: {
    preemptionRisk: string;
    spreadDurabilityHours: number;
    providerSlaRisk: string;
    liquidityRisk: string;
  };
  hedgingRecommendation: {
    recommendedToken: string;
    hedgeRatio: number;
    action: string;
  };
  netYieldProjectionUsdPerHour: number;
  lpuInferenceTimeMs: number;
  modelUsed: string;
  tokensProcessed: number;
  generatedAt: string;
}

interface FleetOptimizationInsights {
  fleetHealth: 'OPTIMAL' | 'REBALANCE_RECOMMENDED' | 'UNDER_UTILIZED';
  summary: string;
  discoveryRecommendation: string;
  optimizerRecommendation: string;
  suggestedProviderPriority: Array<{ provider: string; weightPct: number; reason: string }>;
  expectedYieldIncreasePct: number;
  lpuInferenceTimeMs: number;
  modelUsed: string;
}

interface GroqAiConsoleModalProps {
  isOpen: boolean;
  onClose: () => void;
  opportunities: ArbitrageOpportunity[];
  initialSelectedOpportunity?: ArbitrageOpportunity | null;
  discoveryWorkersCount: number;
  optimizerWorkersCount: number;
}

export const GroqAiConsoleModal: React.FC<GroqAiConsoleModalProps> = ({
  isOpen,
  onClose,
  opportunities,
  initialSelectedOpportunity,
  discoveryWorkersCount,
  optimizerWorkersCount,
}) => {
  const [activeTab, setActiveTab] = useState<'spreads' | 'fleet' | 'copilot' | 'config'>('spreads');
  const [status, setStatus] = useState<GroqAiStatus | null>(null);
  const [selectedOpportunity, setSelectedOpportunity] = useState<ArbitrageOpportunity | null>(
    initialSelectedOpportunity || opportunities[0] || null
  );

  // Spread analysis state
  const [analysisResult, setAnalysisResult] = useState<SpreadAnalysisResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);

  // Fleet insights state
  const [fleetInsights, setFleetInsights] = useState<FleetOptimizationInsights | null>(null);
  const [isFetchingFleetInsights, setIsFetchingFleetInsights] = useState<boolean>(false);

  // Copilot Chat state
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string; latencyMs?: number }>>([
    {
      role: 'assistant',
      content:
        '**[Groq Primary AI Initialized]**\nI am the dedicated real-time intelligence engine for GPU Compute Arbitrage OS v13, operating on high-speed Groq LPU hardware (~520 tokens/sec).\n\nAsk me about live GPU spread feasibility, DePIN futures hedging (RENDER, TAO, AKT), or Bellman-Ford multi-hop routing.',
    },
  ]);
  const [chatInput, setChatInput] = useState<string>('');
  const [isCopilotTyping, setIsCopilotTyping] = useState<boolean>(false);

  // Config state
  const [apiKeyInput, setApiKeyInput] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<string>('qwen/qwen3.8-27b');
  const [configMsg, setConfigMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  const fetchStatus = () => {
    fetch('/api/ai/status')
      .then((res) => res.json())
      .then((data: GroqAiStatus) => {
        setStatus(data);
        if (data.model) setSelectedModel(data.model);
      })
      .catch((err) => console.warn('Could not fetch Groq status:', err));
  };

  useEffect(() => {
    if (isOpen) {
      fetchStatus();
      if (initialSelectedOpportunity) {
        setSelectedOpportunity(initialSelectedOpportunity);
        triggerSpreadAnalysis(initialSelectedOpportunity);
      } else if (opportunities.length > 0 && !analysisResult) {
        setSelectedOpportunity(opportunities[0]);
        triggerSpreadAnalysis(opportunities[0]);
      }
    }
  }, [isOpen, initialSelectedOpportunity]);

  const triggerSpreadAnalysis = (opp: ArbitrageOpportunity) => {
    setIsAnalyzing(true);
    fetch('/api/ai/analyze-spread', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opp),
    })
      .then((res) => res.json())
      .then((data: SpreadAnalysisResult) => {
        setAnalysisResult(data);
        setIsAnalyzing(false);
      })
      .catch((err) => {
        console.error('Spread analysis error:', err);
        setIsAnalyzing(false);
      });
  };

  const triggerFleetInsights = () => {
    setIsFetchingFleetInsights(true);
    fetch('/api/ai/fleet-insights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        discoveryCount: discoveryWorkersCount,
        optimizerCount: optimizerWorkersCount,
      }),
    })
      .then((res) => res.json())
      .then((data: FleetOptimizationInsights) => {
        setFleetInsights(data);
        setIsFetchingFleetInsights(false);
      })
      .catch((err) => {
        console.error('Fleet insights error:', err);
        setIsFetchingFleetInsights(false);
      });
  };

  const handleSendChat = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!chatInput.trim() || isCopilotTyping) return;

    const userText = chatInput.trim();
    setChatInput('');
    const newHistory = [...chatMessages, { role: 'user' as const, content: userText }];
    setChatMessages(newHistory);
    setIsCopilotTyping(true);

    fetch('/api/ai/copilot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: newHistory }),
    })
      .then((res) => res.json())
      .then((data) => {
        setIsCopilotTyping(false);
        setChatMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: data.reply || 'Analysis complete.',
            latencyMs: data.latencyMs,
          },
        ]);
      })
      .catch((err) => {
        setIsCopilotTyping(false);
        setChatMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: `Error contacting Groq API: ${err.message}. Emulated LPU fallback active.`,
          },
        ]);
      });
  };

  const handleSaveConfig = () => {
    setConfigMsg(null);
    fetch('/api/ai/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: apiKeyInput.trim() || undefined,
        model: selectedModel,
      }),
    })
      .then((res) => res.json())
      .then((res) => {
        if (res.success) {
          setConfigMsg({ type: 'success', text: 'Groq Primary AI parameters updated and locked successfully.' });
          fetchStatus();
        } else {
          setConfigMsg({ type: 'error', text: res.error || 'Failed to update configuration.' });
        }
      })
      .catch((err) => {
        setConfigMsg({ type: 'error', text: err.message });
      });
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(label);
    setTimeout(() => setCopiedText(null), 2500);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/85 backdrop-blur-md overflow-y-auto">
      <div className="bg-[#0a0f1d] border border-orange-500/40 rounded-xl w-full max-w-5xl shadow-2xl shadow-orange-950/40 overflow-hidden my-6 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-3.5 border-b border-slate-800/90 bg-slate-900/70">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-orange-950/80 border border-orange-500/60 flex items-center justify-center text-orange-400 shadow-sm shadow-orange-950/60">
              <Zap className="w-5 h-5 fill-current" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white tracking-wide flex items-center gap-2">
                  <span>Groq Primary AI Engine</span>
                  <span className="px-2 py-0.5 text-[10px] font-mono font-bold bg-orange-950 text-orange-300 border border-orange-700/60 rounded">
                    LPU ~520 T/S
                  </span>
                  <span className="px-2 py-0.5 text-[10px] font-mono font-bold bg-emerald-950 text-emerald-300 border border-emerald-700/60 rounded">
                    PRIMARY REASONER
                  </span>
                </h3>
              </div>
              <p className="text-xs text-slate-400">
                Ultra-low latency LPU inference powering real-time spread analysis, preemption risk modeling, and CFO hedging
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center gap-2 px-6 pt-3 pb-0 border-b border-slate-800 bg-slate-950/40 overflow-x-auto">
          <button
            onClick={() => setActiveTab('spreads')}
            className={`flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-t-lg transition-all border-b-2 ${
              activeTab === 'spreads'
                ? 'bg-slate-900/90 text-orange-400 border-orange-500'
                : 'text-slate-400 hover:text-slate-200 border-transparent'
            }`}
          >
            <TrendingUp className="w-3.5 h-3.5" />
            <span>Spread Intelligence</span>
          </button>

          <button
            onClick={() => {
              setActiveTab('fleet');
              if (!fleetInsights) triggerFleetInsights();
            }}
            className={`flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-t-lg transition-all border-b-2 ${
              activeTab === 'fleet'
                ? 'bg-slate-900/90 text-orange-400 border-orange-500'
                : 'text-slate-400 hover:text-slate-200 border-transparent'
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            <span>Fleet & Bellman-Ford Insights</span>
          </button>

          <button
            onClick={() => setActiveTab('copilot')}
            className={`flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-t-lg transition-all border-b-2 ${
              activeTab === 'copilot'
                ? 'bg-slate-900/90 text-orange-400 border-orange-500'
                : 'text-slate-400 hover:text-slate-200 border-transparent'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>Groq Copilot Terminal</span>
          </button>

          <button
            onClick={() => setActiveTab('config')}
            className={`flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-t-lg transition-all border-b-2 ${
              activeTab === 'config'
                ? 'bg-slate-900/90 text-orange-400 border-orange-500'
                : 'text-slate-400 hover:text-slate-200 border-transparent'
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            <span>Engine Configuration</span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-5 flex-1">
          {/* Diagnostic Stat Banner */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3 bg-slate-900/60 border border-slate-800 rounded-lg">
              <span className="text-[10px] text-slate-400 block font-mono">PRIMARY AI PROVIDER</span>
              <span className="text-xs font-bold text-orange-400">Groq LPU Tensor Processor</span>
            </div>
            <div className="p-3 bg-slate-900/60 border border-slate-800 rounded-lg">
              <span className="text-[10px] text-slate-400 block font-mono">ACTIVE MODEL</span>
              <span className="text-xs font-bold text-white font-mono truncate block">
                {status?.model || selectedModel}
              </span>
            </div>
            <div className="p-3 bg-slate-900/60 border border-slate-800 rounded-lg">
              <span className="text-[10px] text-slate-400 block font-mono">INFERENCE SPEED</span>
              <span className="text-xs font-bold text-emerald-400 font-mono">~520 tokens / sec</span>
            </div>
            <div className="p-3 bg-slate-900/60 border border-slate-800 rounded-lg">
              <span className="text-[10px] text-slate-400 block font-mono">LPU LATENCY</span>
              <span className="text-xs font-bold text-cyan-300 font-mono">
                {status?.averageLatencyMs || 12} ms
              </span>
            </div>
          </div>

          {/* TAB 1: SPREAD INTELLIGENCE */}
          {activeTab === 'spreads' && (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 bg-slate-950 border border-slate-800 rounded-lg">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-slate-300">Select Target Spread Opportunity:</span>
                  <select
                    value={selectedOpportunity?.id || ''}
                    onChange={(e) => {
                      const opp = opportunities.find((o) => o.id === e.target.value);
                      if (opp) {
                        setSelectedOpportunity(opp);
                        triggerSpreadAnalysis(opp);
                      }
                    }}
                    className="px-3 py-1.5 bg-slate-900 border border-slate-700 rounded text-xs font-mono text-cyan-300 outline-none"
                  >
                    {opportunities.map((opp) => (
                      <option key={opp.id} value={opp.id}>
                        {opp.gpuName} — {opp.buyProvider} → {opp.sellCounterparty} (${opp.netSpreadPerHour.toFixed(2)}/hr)
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  onClick={() => selectedOpportunity && triggerSpreadAnalysis(selectedOpportunity)}
                  disabled={isAnalyzing}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-slate-950 bg-orange-400 hover:bg-orange-300 rounded transition-colors disabled:opacity-50 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isAnalyzing ? 'animate-spin' : ''}`} />
                  <span>{isAnalyzing ? 'Evaluating on Groq LPU...' : 'Re-Run LPU Spread Evaluation'}</span>
                </button>
              </div>

              {analysisResult && (
                <div className="p-4 bg-slate-900/90 border border-orange-500/40 rounded-xl space-y-4 shadow-lg">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-3">
                    <div className="flex items-center gap-3">
                      <span
                        className={`px-2.5 py-1 text-xs font-bold rounded border ${
                          analysisResult.recommendation === 'EXECUTE_IMMEDIATELY'
                            ? 'bg-emerald-950 text-emerald-400 border-emerald-600'
                            : analysisResult.recommendation === 'EXECUTE_WITH_HEDGE'
                            ? 'bg-amber-950 text-amber-400 border-amber-600'
                            : 'bg-rose-950 text-rose-400 border-rose-600'
                        }`}
                      >
                        {analysisResult.recommendation.replace(/_/g, ' ')}
                      </span>
                      <span className="text-xs text-slate-300">
                        AI Confidence Rating: <strong className="text-white font-mono">{analysisResult.confidenceScore}%</strong>
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-slate-400 font-mono">
                      <span>Inference: <strong className="text-cyan-400">{analysisResult.lpuInferenceTimeMs}ms</strong></span>
                      <span>Model: <strong className="text-slate-300">{analysisResult.modelUsed}</strong></span>
                    </div>
                  </div>

                  {/* Summary */}
                  <div className="space-y-1">
                    <span className="text-[11px] font-mono text-slate-400 uppercase tracking-wider block">
                      Executive Summary & Rationale
                    </span>
                    <p className="text-sm text-slate-200 font-medium leading-relaxed">
                      {analysisResult.executiveSummary}
                    </p>
                    <p className="text-xs text-slate-400 leading-relaxed pt-1">
                      {analysisResult.strategicRationale}
                    </p>
                  </div>

                  {/* Risk and Hedging Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
                    <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-lg space-y-2 text-xs">
                      <span className="text-[11px] font-mono text-amber-400 font-bold uppercase tracking-wider block">
                        DePIN Futures Hedging Instruction
                      </span>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">Hedging Asset:</span>
                        <span className="font-bold font-mono text-amber-300">
                          {analysisResult.hedgingRecommendation.recommendedToken}USDT
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">Recommended Ratio:</span>
                        <span className="font-bold font-mono text-white">
                          {(analysisResult.hedgingRecommendation.hedgeRatio * 100).toFixed(0)}%
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 pt-1 border-t border-slate-800/80">
                        {analysisResult.hedgingRecommendation.action}
                      </p>
                    </div>

                    <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-lg space-y-2 text-xs">
                      <span className="text-[11px] font-mono text-cyan-400 font-bold uppercase tracking-wider block">
                        SLA & Durability Risk Matrix
                      </span>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">Preemption Risk:</span>
                        <span className="font-bold font-mono text-emerald-400">
                          {analysisResult.riskAssessment.preemptionRisk}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">Estimated Durability:</span>
                        <span className="font-bold font-mono text-white">
                          {analysisResult.riskAssessment.spreadDurabilityHours} hours
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">Provider SLA Integrity:</span>
                        <span className="font-bold font-mono text-emerald-400">
                          {analysisResult.riskAssessment.providerSlaRisk}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: FLEET INSIGHTS */}
          {activeTab === 'fleet' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 bg-slate-950 border border-slate-800 rounded-lg">
                <div>
                  <span className="text-xs font-bold text-white block">Autonomous Fleet Orchestration Intelligence</span>
                  <span className="text-[11px] text-slate-400">
                    Active: {discoveryWorkersCount} Discovery Crawlers · {optimizerWorkersCount} Yield Optimizers
                  </span>
                </div>
                <button
                  onClick={triggerFleetInsights}
                  disabled={isFetchingFleetInsights}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-slate-950 bg-orange-400 hover:bg-orange-300 rounded transition-colors disabled:opacity-50 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isFetchingFleetInsights ? 'animate-spin' : ''}`} />
                  <span>{isFetchingFleetInsights ? 'Evaluating Fleet...' : 'Re-compute Fleet Balance'}</span>
                </button>
              </div>

              {fleetInsights && (
                <div className="p-4 bg-slate-900/90 border border-slate-800 rounded-xl space-y-4">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-3 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">Fleet Health:</span>
                      <span className="px-2 py-0.5 rounded font-mono font-bold bg-emerald-950 text-emerald-400 border border-emerald-800">
                        {fleetInsights.fleetHealth}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">Projected Yield Boost:</span>
                      <span className="text-emerald-400 font-bold font-mono">
                        +{fleetInsights.expectedYieldIncreasePct}%
                      </span>
                    </div>
                  </div>

                  <p className="text-sm text-slate-200 leading-relaxed font-medium">
                    {fleetInsights.summary}
                  </p>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                    <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-lg space-y-1">
                      <span className="font-bold text-cyan-300 block font-mono">Discovery Fleet Strategy:</span>
                      <p className="text-slate-400 leading-relaxed">{fleetInsights.discoveryRecommendation}</p>
                    </div>
                    <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-lg space-y-1">
                      <span className="font-bold text-amber-300 block font-mono">Optimizer Fleet Strategy:</span>
                      <p className="text-slate-400 leading-relaxed">{fleetInsights.optimizerRecommendation}</p>
                    </div>
                  </div>

                  {fleetInsights.suggestedProviderPriority && (
                    <div className="space-y-2 pt-1">
                      <span className="text-[11px] font-mono text-slate-400 uppercase tracking-wider block">
                        Recommended Multi-Cloud Provider Priority Allocation
                      </span>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {fleetInsights.suggestedProviderPriority.map((item, idx) => (
                          <div key={idx} className="p-2.5 bg-slate-950/90 border border-slate-800 rounded-lg flex items-center justify-between text-xs">
                            <div>
                              <span className="font-bold text-white block">{item.provider}</span>
                              <span className="text-[11px] text-slate-400">{item.reason}</span>
                            </div>
                            <span className="text-sm font-mono font-bold text-orange-400">{item.weightPct}%</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: COPILOT TERMINAL */}
          {activeTab === 'copilot' && (
            <div className="space-y-3">
              <div className="h-72 bg-slate-950 border border-slate-800 rounded-xl p-4 overflow-y-auto space-y-3 font-mono text-xs">
                {chatMessages.map((msg, i) => (
                  <div
                    key={i}
                    className={`p-3 rounded-lg leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-slate-900 border border-slate-700/80 text-cyan-200 ml-8'
                        : 'bg-slate-900/40 border border-slate-800/80 text-slate-200 mr-8'
                    }`}
                  >
                    <div className="flex items-center justify-between text-[10px] text-slate-500 mb-1 font-bold">
                      <span>{msg.role === 'user' ? 'OPERATOR' : 'GROQ PRIMARY AI (LPU)'}</span>
                      {msg.latencyMs && (
                        <span className="text-orange-400 font-mono">{msg.latencyMs} ms · ~520 T/s</span>
                      )}
                    </div>
                    <div className="whitespace-pre-wrap">{msg.content}</div>
                  </div>
                ))}
                {isCopilotTyping && (
                  <div className="p-2.5 bg-slate-900/40 rounded-lg text-slate-400 text-xs flex items-center gap-2">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-orange-400" />
                    <span>Groq LPU streaming response at 520 tokens/sec...</span>
                  </div>
                )}
              </div>

              <form onSubmit={handleSendChat} className="flex gap-2">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Ask Groq AI about GPU yields, DePIN hedging, or Binance cross-margin allocations..."
                  className="flex-1 px-4 py-2.5 bg-slate-950 border border-slate-800 focus:border-orange-500 rounded-lg text-xs font-mono text-white outline-none"
                />
                <button
                  type="submit"
                  disabled={!chatInput.trim() || isCopilotTyping}
                  className="px-4 py-2.5 text-xs font-bold text-slate-950 bg-orange-400 hover:bg-orange-300 rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>Send</span>
                </button>
              </form>
            </div>
          )}

          {/* TAB 4: CONFIGURATION */}
          {activeTab === 'config' && (
            <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-xl space-y-4 text-xs">
              {configMsg && (
                <div
                  className={`p-3 rounded-lg border text-xs font-medium flex items-center gap-2 ${
                    configMsg.type === 'success'
                      ? 'bg-emerald-950/60 border-emerald-500/50 text-emerald-200'
                      : 'bg-rose-950/60 border-rose-500/50 text-rose-200'
                  }`}
                >
                  {configMsg.type === 'success' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                  )}
                  <span>{configMsg.text}</span>
                </div>
              )}

              <div className="space-y-2">
                <label className="text-slate-300 font-bold block">Groq API Key (GROQ_API_KEY):</label>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder="gsk_••••••••••••••••••••••••••••••••"
                    className="flex-1 px-3.5 py-2 bg-slate-950 border border-slate-700 rounded-lg font-mono text-white outline-none focus:border-orange-500"
                  />
                </div>
                <p className="text-[11px] text-slate-400">
                  Current Key Status:{' '}
                  <strong className="text-orange-400 font-mono">
                    {status?.hasLiveKey ? 'Authenticated Live API Key' : 'Fast Standby Emulation Active'}
                  </strong>{' '}
                  ({status?.keyMasked || 'Not set'})
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-slate-300 font-bold block">Primary Reasoning Model:</label>
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="w-full px-3.5 py-2 bg-slate-950 border border-slate-700 rounded-lg font-mono text-white outline-none focus:border-orange-500"
                >
                  <option value="qwen/qwen3.8-27b">qwen/qwen3.8-27b (Verified High-Precision Reasoning LPU · 520 tok/s)</option>
                  <option value="openai/gpt-oss-120b">openai/gpt-oss-120b (Deep Reasoning 120B LPU)</option>
                  <option value="openai/gpt-oss-20b">openai/gpt-oss-20b (Ultra-Fast 20B LPU)</option>
                  <option value="allam-2-7b">allam-2-7b (7B Fast Reasoning)</option>
                  <option value="llama-3.3-70b-versatile">llama-3.3-70b-versatile (Meta Llama 70B)</option>
                  <option value="llama-3.1-8b-instant">llama-3.1-8b-instant (Sub-10ms Ultra-Speed)</option>
                </select>
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  onClick={handleSaveConfig}
                  className="px-5 py-2 text-xs font-bold text-slate-950 bg-gradient-to-r from-orange-400 to-amber-300 hover:from-orange-300 hover:to-amber-200 rounded-lg shadow-md transition-all active:scale-95 cursor-pointer"
                >
                  Save & Lock Groq Parameters
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-slate-800 bg-slate-950/60 text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>Groq LPU Acceleration: <strong>ACTIVE</strong></span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-semibold text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
