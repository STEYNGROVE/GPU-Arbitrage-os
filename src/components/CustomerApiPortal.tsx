import React, { useState, useEffect, useCallback } from 'react';
import { useArbitrage } from '../context/ArbitrageContext';
import { 
  Zap, 
  Key, 
  Send, 
  CheckCircle2, 
  Copy, 
  Code, 
  ShieldCheck, 
  DollarSign,
  Layers,
  Plus,
  CreditCard,
  ExternalLink,
  Wallet,
  Building2,
  RefreshCw,
  Sliders,
  ChevronDown,
  ChevronUp,
  Inbox,
  Clock,
  UserCheck
} from 'lucide-react';
import { GpuModel, WorkloadType, DemandClass, GPU_WORKLOAD_CATALOG, getGpuWorkloadSpec } from '../types';

export const CustomerApiPortal: React.FC = () => {
  // Commercial Leads & Enquiries State (Phase 2 & 3)
  interface CommercialLead {
    id: string;
    created_at: string;
    company: string;
    contact_name: string;
    email: string;
    workload: string;
    gpu_model: string;
    gpu_count: number;
    hours: number;
    notes: string;
    status: 'NEW' | 'REVIEWING' | 'QUOTED' | 'CLOSED';
  }

  const [enquiries, setEnquiries] = useState<CommercialLead[]>([]);
  const [isLoadingEnquiries, setIsLoadingEnquiries] = useState(false);
  const [enquiryFilter, setEnquiryFilter] = useState<'ALL' | 'NEW' | 'REVIEWING' | 'QUOTED' | 'CLOSED'>('ALL');
  const [enquiryFeedback, setEnquiryFeedback] = useState<string | null>(null);

  const fetchCommercialEnquiries = useCallback(async () => {
    setIsLoadingEnquiries(true);
    try {
      const res = await fetch('/api/commercial/requests', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.requests)) {
          setEnquiries(data.requests);
        }
      }
    } catch (e) {
      console.warn('[CustomerApiPortal] Notice: Failed to fetch commercial requests:', e);
    } finally {
      setIsLoadingEnquiries(false);
    }
  }, []);

  useEffect(() => {
    fetchCommercialEnquiries();
  }, [fetchCommercialEnquiries]);

  const updateEnquiryStatus = async (id: string, newStatus: 'NEW' | 'REVIEWING' | 'QUOTED' | 'CLOSED') => {
    try {
      const res = await fetch(`/api/commercial/requests/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: newStatus })
      });
      if (res.ok) {
        setEnquiries(prev => prev.map(item => item.id === id ? { ...item, status: newStatus } : item));
        setEnquiryFeedback(`Updated lead ${id.slice(0, 8)} to ${newStatus}`);
        setTimeout(() => setEnquiryFeedback(null), 3000);
      }
    } catch (e) {
      console.warn('[CustomerApiPortal] Failed to update lead status:', e);
    }
  };

  const {
    apiKeys,
    generateNewApiKey,
    submitNewDemandOrder,
    simulateEscrowWebhook,
    demandOrders,
    ownerConfig
  } = useArbitrage();

  const [clientName, setClientName] = useState('');
  const [clientQuota, setClientQuota] = useState(2500);
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);

  // Job Submission Form State
  const [jobCustomer, setJobCustomer] = useState('');
  const [jobGpu, setJobGpu] = useState<GpuModel>('H100 SXM5 80GB');
  const [jobCount, setJobCount] = useState(2);
  const [jobDuration, setJobDuration] = useState(6);
  const [jobWorkload, setJobWorkload] = useState<WorkloadType>('LLM_INFERENCE');
  const [jobHourlyBudget, setJobHourlyBudget] = useState(4.50);
  const [jobDemandClass, setJobDemandClass] = useState<DemandClass>('CONFIRMED');
  const [jobDesc, setJobDesc] = useState('');

  const [submitResult, setSubmitResult] = useState<{ id: string; message: string } | null>(null);
  const [escrowFeedback, setEscrowFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Payment Gateways & APIs State
  const [selectedGateway] = useState<'BINANCE'>('BINANCE');
  const [gatewaysData, setGatewaysData] = useState<any>(null);
  const [activeIntent, setActiveIntent] = useState<any>(null);
  const [isProcessingGateway, setIsProcessingGateway] = useState(false);
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const [isRefreshingGateways, setIsRefreshingGateways] = useState(false);

  const fetchGateways = useCallback(async () => {
    setIsRefreshingGateways(true);
    try {
      const res = await fetch('/api/gateways/status');
      if (res.ok) {
        const data = await res.json();
        setGatewaysData(data);
      }
    } catch {
      // Fallback
    } finally {
      setIsRefreshingGateways(false);
    }
  }, []);

  useEffect(() => {
    fetchGateways();
  }, [fetchGateways]);

  const handleInitiateGatewayPayment = async (orderId?: string, customAmount?: number) => {
    setIsProcessingGateway(true);
    setGatewayError(null);
    try {
      const targetAmount = customAmount || (jobHourlyBudget * jobDuration * jobCount);
      const res = await fetch('/api/payments/intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: selectedGateway,
          amount: targetAmount,
          currency: 'USD',
          reference: `escrow_${orderId || 'job'}_${Date.now()}`,
          orderId: orderId || submitResult?.id,
          customerName: jobCustomer,
          customerEmail: 'enterprise-billing@client.corp'
        })
      });
      const data = await res.json();
      if (res.ok && data.intent) {
        setActiveIntent(data.intent);
      } else {
        setGatewayError(data.message || 'Failed to create payment intent');
      }
    } catch (err: any) {
      setGatewayError(err.message);
    } finally {
      setIsProcessingGateway(false);
    }
  };

  // Dynamic Safety Pricing Estimator (Section 19)
  const baseGpuCost = jobGpu.includes('H100') ? 2.25 : jobGpu.includes('A100') ? 1.40 : jobGpu.includes('4090') ? 0.40 : 0.90;
  const landedMultiplier = 1.15; // 15% estimated storage/bandwidth/fees
  const minRequiredMargin = 1 + (ownerConfig.minMarginPct / 100);
  const calculatedSafetyFloorPrice = Math.round((baseGpuCost * landedMultiplier * minRequiredMargin) * 100) / 100;
  const isBudgetProfitable = jobHourlyBudget >= calculatedSafetyFloorPrice;

  const handleCreateKey = (e: React.FormEvent) => {
    e.preventDefault();
    if (!clientName) return;
    generateNewApiKey(clientName, clientQuota);
    setClientName('');
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKeyId(id);
    setTimeout(() => setCopiedKeyId(null), 2000);
  };

  const handleSubmitJob = async (e: React.FormEvent) => {
    e.preventDefault();
    const totalGross = jobHourlyBudget * jobDuration * jobCount;
    const res = await submitNewDemandOrder({
      customerName: jobCustomer,
      gpuModel: jobGpu,
      gpuCount: jobCount,
      durationHours: jobDuration,
      workloadType: jobWorkload,
      customerHourlyRate: jobHourlyBudget,
      customerGrossOfferPrice: totalGross,
      demandClass: jobDemandClass,
      workloadDescription: jobDesc,
      paymentStatus: 'QUOTE_PENDING'
    });

    setSubmitResult({
      id: res.demandId,
      message: `Job request ${res.demandId} submitted and queued for deal verification!`
    });
  };

  return (
    <div className="space-y-6 pb-12 font-mono">
      {/* Header */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-cyan-400" />
            <h2 className="text-base font-bold text-white uppercase tracking-wide">
              Private Customer Compute API & Ingestion Portal
            </h2>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Section 18 & 19: Private authenticated interface for approved enterprise clients with automated safety pricing.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Left: Interactive Job Submission Sandbox (7 Cols) */}
        <div className="lg:col-span-7 bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
            <Send className="w-4 h-4 text-emerald-400" />
            <span>Submit Verified Demand Order</span>
          </h3>

          <form onSubmit={handleSubmitJob} className="space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-slate-300 block mb-1">Customer / Organization:</label>
                <input
                  type="text"
                  value={jobCustomer}
                  onChange={e => setJobCustomer(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white focus:outline-none focus:border-cyan-500"
                  required
                />
              </div>

              <div>
                <label className="text-slate-300 block mb-1">Demand Class:</label>
                <select
                  value={jobDemandClass}
                  onChange={e => setJobDemandClass(e.target.value as DemandClass)}
                  className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white focus:outline-none focus:border-cyan-500"
                >
                  <option value="CONFIRMED">CONFIRMED (Escrow Authorized)</option>
                  <option value="PROBABLE">PROBABLE (Quote Request)</option>
                  <option value="PREDICTED">PREDICTED (Model Forecast)</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-slate-300 block mb-1">Target GPU Model:</label>
                <select
                  value={jobGpu}
                  onChange={e => setJobGpu(e.target.value as GpuModel)}
                  className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white focus:outline-none focus:border-cyan-500"
                >
                  <option value="H100 SXM5 80GB">H100 SXM5 80GB</option>
                  <option value="A100 80GB SXM">A100 80GB SXM</option>
                  <option value="RTX 4090 24GB">RTX 4090 24GB</option>
                  <option value="L40S 48GB">L40S 48GB</option>
                  <option value="RTX 6000 Ada 48GB">RTX 6000 Ada 48GB</option>
                  <option value="H200 141GB">H200 141GB</option>
                </select>
              </div>

              <div>
                <label className="text-slate-300 block mb-1">GPU Units Count:</label>
                <input
                  type="number"
                  min="1"
                  max="16"
                  value={jobCount}
                  onChange={e => setJobCount(parseInt(e.target.value) || 1)}
                  className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div>
                <label className="text-slate-300 block mb-1">Duration (Hours):</label>
                <input
                  type="number"
                  min="1"
                  max="48"
                  value={jobDuration}
                  onChange={e => setJobDuration(parseInt(e.target.value) || 1)}
                  className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white focus:outline-none focus:border-cyan-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-slate-300 block mb-1">GPU Workload (All 16 Supported):</label>
                <select
                  value={jobWorkload}
                  onChange={e => {
                    const nextWorkload = e.target.value as WorkloadType;
                    setJobWorkload(nextWorkload);
                    const spec = getGpuWorkloadSpec(nextWorkload, jobGpu);
                    setJobDesc(`${spec.name} — Customer pays for: ${spec.customerPaysFor} (${spec.example})`);
                  }}
                  className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white focus:outline-none focus:border-cyan-500"
                >
                  {GPU_WORKLOAD_CATALOG.map(w => (
                    <option key={w.id} value={w.id}>
                      {w.name} — Pays for: {w.customerPaysFor}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-slate-300 block mb-1">Customer Offer ($ / GPU-hr):</label>
                <input
                  type="number"
                  step="0.10"
                  value={jobHourlyBudget}
                  onChange={e => setJobHourlyBudget(parseFloat(e.target.value) || 0)}
                  className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white focus:outline-none focus:border-cyan-500"
                />
              </div>
            </div>

            {/* Selected Workload Billing Model & Example Card */}
            {(() => {
              const selectedSpec = getGpuWorkloadSpec(jobWorkload, jobGpu);
              return (
                <div className="bg-slate-950 border border-cyan-900/60 rounded-lg p-3 text-xs grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div>
                    <span className="text-[10px] uppercase text-cyan-400 font-bold block">GPU Workload</span>
                    <span className="text-white font-bold">{selectedSpec.name}</span>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase text-amber-400 font-bold block">What Customer Pays For</span>
                    <span className="text-amber-300 font-semibold">{selectedSpec.customerPaysFor}</span>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase text-emerald-400 font-bold block">Production Example</span>
                    <span className="text-slate-200">{selectedSpec.example}</span>
                  </div>
                </div>
              );
            })()}

            <div>
              <label className="text-slate-300 block mb-1">Workload Details / Contract Scope:</label>
              <input
                type="text"
                value={jobDesc}
                onChange={e => setJobDesc(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white focus:outline-none focus:border-cyan-500"
              />
            </div>

            {/* Section 19: Dynamic Safety Floor Price Check Indicator */}
            <div className={`p-3 rounded-lg border text-xs space-y-1 ${
              isBudgetProfitable ? 'bg-emerald-950/40 border-emerald-800/80 text-emerald-300' : 'bg-rose-950/40 border-rose-800/80 text-rose-300'
            }`}>
              <div className="flex justify-between font-bold">
                <span>Automated Pricing Engine Safety Check:</span>
                <span>{isBudgetProfitable ? 'APPROVED (Profitable)' : 'REJECTED (Below Margin Floor)'}</span>
              </div>
              <div className="text-[11px] text-slate-300">
                Minimum Safety Floor Price: <strong>${(calculatedSafetyFloorPrice ?? 0).toFixed(2)}/hr</strong> (Base cost ${(baseGpuCost ?? 0).toFixed(2)} + 15% landed cost + {ownerConfig.minMarginPct}% min margin).
              </div>
            </div>

            <button
              type="submit"
              disabled={!isBudgetProfitable && jobDemandClass === 'CONFIRMED'}
              className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded text-xs font-bold transition-colors cursor-pointer shadow-lg shadow-emerald-950 flex items-center justify-center gap-2"
            >
              <Send className="w-4 h-4" />
              <span>Submit & Ingest Job Request</span>
            </button>
          </form>

          {submitResult && (
            <div className="p-3 bg-emerald-950 border border-emerald-800 rounded text-xs text-emerald-300 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{submitResult.message}</span>
            </div>
          )}
        </div>

        {/* Right: API Keys & curl snippet (5 Cols) */}
        <div className="lg:col-span-5 space-y-4">
          
          {/* Issue API Key */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
              <Key className="w-4 h-4 text-amber-400" />
              <span>Active Customer API Keys ({apiKeys.length})</span>
            </h3>

            <form onSubmit={handleCreateKey} className="space-y-2 text-xs">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Enterprise Client Name..."
                  value={clientName}
                  onChange={e => setClientName(e.target.value)}
                  className="flex-1 bg-slate-950 border border-slate-700 rounded px-3 py-1.5 text-white focus:outline-none focus:border-cyan-500"
                />
                <button
                  type="submit"
                  className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded font-bold cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </form>

            <div className="space-y-2 max-h-56 overflow-y-auto">
              {apiKeys.map(key => (
                <div key={key.id} className="bg-slate-950 p-2.5 rounded border border-slate-800 text-xs space-y-1">
                  <div className="flex justify-between items-center">
                    <span className="font-bold text-white">{key.name}</span>
                    <span className="text-[10px] text-emerald-400 font-semibold">{key.status}</span>
                  </div>
                  <div className="flex justify-between items-center text-slate-400 text-[11px]">
                    <code className="text-cyan-300">{key.keyPrefix}</code>
                    <button
                      onClick={() => handleCopy(key.id, key.keyPrefix)}
                      className="text-slate-400 hover:text-slate-200 cursor-pointer"
                      title="Copy Key Prefix (Full secrets are held server-side only)"
                    >
                      {copiedKeyId === key.id ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  <div className="text-[10px] text-slate-500 flex justify-between pt-1 border-t border-slate-900">
                    <span>Spent: ${(key.spentThisMonthDollars ?? 0).toFixed(2)}</span>
                    <span>Quota: ${(key.monthlyQuotaDollars ?? 0).toFixed(2)}/mo</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Multi-Gateway Escrow Deposit & Checkout */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold text-cyan-400 uppercase flex items-center gap-1.5">
                <CreditCard className="w-4 h-4 text-cyan-400" />
                <span>Payment Gateways & Escrow Checkout</span>
              </h4>
              <button
                onClick={fetchGateways}
                disabled={isRefreshingGateways}
                className="text-[10px] text-slate-400 hover:text-cyan-400 flex items-center gap-1 cursor-pointer transition-colors"
                title="Refresh Gateway APIs"
              >
                <RefreshCw className={`w-3 h-3 ${isRefreshingGateways ? 'animate-spin' : ''}`} />
                <span>Sync</span>
              </button>
            </div>

            <p className="text-[11px] text-slate-400 leading-relaxed">
              Institutional and enterprise customers deposit escrow through authorized payment gateways. Funds settle directly into PostgreSQL double-entry accounts.
            </p>

            {/* Gateway Selection Card */}
            <div className="text-[10px] space-y-2">
              {(() => {
                const isConfigured = gatewaysData?.paymentGateways?.BINANCE?.configured;
                return (
                  <div>
                    <div className="p-2.5 rounded-lg border bg-cyan-950/40 border-cyan-500 text-cyan-200 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Zap className="w-4 h-4 text-amber-400" />
                        <div>
                          <div className="font-semibold text-xs">Binance Canonical Payment & Treasury Rail</div>
                          <div className="text-[10px] text-slate-400">USDT / BEP-20 Institutional Escrow Settlement</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${isConfigured ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-amber-950 text-amber-400 border border-amber-800'}`}>
                          {isConfigured ? 'LIVE GATEWAY' : 'ENV SECRETS REQUIRED'}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Action & Checkout Trigger */}
            <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-2.5">
              <div className="flex justify-between items-center text-[11px]">
                <span className="text-slate-400">Selected Provider:</span>
                <span className="text-cyan-300 font-mono font-bold">{selectedGateway}</span>
              </div>
              <div className="flex justify-between items-center text-[11px]">
                <span className="text-slate-400">Estimated Escrow Deposit:</span>
                <span className="text-emerald-400 font-mono font-bold">
                  ${(jobHourlyBudget * jobDuration * jobCount).toFixed(2)} USD
                </span>
              </div>

              {gatewayError && (
                <div className="p-2 bg-red-950/50 border border-red-800 rounded text-[11px] text-red-300">
                  {gatewayError}
                </div>
              )}

              <button
                type="button"
                onClick={() => handleInitiateGatewayPayment(submitResult?.id)}
                disabled={isProcessingGateway}
                className="w-full py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-bold transition-colors cursor-pointer flex items-center justify-center gap-1.5 shadow-lg shadow-cyan-900/20"
              >
                <CreditCard className="w-3.5 h-3.5" />
                <span>
                  {isProcessingGateway
                    ? 'Creating PostgreSQL Payment Intent...'
                    : `Generate ${selectedGateway} Payment Intent`}
                </span>
              </button>

              {activeIntent && (
                <div className="mt-2 p-3 bg-slate-900 border border-cyan-800/60 rounded-lg space-y-2 text-[11px]">
                  <div className="flex items-center justify-between">
                    <span className="text-emerald-400 font-bold flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      Intent Authoritative: {activeIntent.id}
                    </span>
                    <span className="text-slate-400 font-mono text-[10px]">Status: {activeIntent.status}</span>
                  </div>
                  <div className="text-slate-300 text-[10px] font-mono">
                    Ref: {activeIntent.reference} | Provider: {activeIntent.provider} | ${(activeIntent.amountCents / 100).toFixed(2)} {activeIntent.currency}
                  </div>
                  {activeIntent.paymentUrl ? (
                    <a
                      href={activeIntent.paymentUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block w-full text-center py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded text-xs transition-colors flex items-center justify-center gap-1"
                    >
                      <span>Proceed to {selectedGateway} Checkout</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  ) : (
                    <div className="p-2 bg-slate-950 rounded border border-slate-800 text-[10px] text-slate-400">
                      Bank Wire Ref: <code className="text-amber-400">{activeIntent.reference}</code> | Account: <code className="text-slate-200">STANDARD-BANK-049281</code>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Authoritative Escrow Webhook Simulation Tool */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-3">
            <h4 className="text-xs font-bold text-emerald-400 uppercase flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Escrow Webhook Ingestion Gate</span>
            </h4>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Client requests cannot be executed in LIVE mode without an authoritative HMAC-signed payment lock from the canonical Binance payment & escrow rail.
            </p>
            <div className="space-y-2 pt-1 text-xs">
              <div className="bg-slate-950 p-3 rounded border border-slate-800 space-y-2">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-slate-400 font-mono">POST /api/webhooks/escrow</span>
                  <span className="text-emerald-400 font-bold text-[10px]">HMAC-SHA256</span>
                </div>
                <div className="text-[11px] text-slate-300">
                  Select unverified demand order to trigger verified escrow lock:
                </div>
                {submitResult?.id ? (
                  <button
                    onClick={async () => {
                      const totalGross = jobHourlyBudget * jobDuration * jobCount;
                      const res = await simulateEscrowWebhook(submitResult.id, totalGross);
                      setEscrowFeedback({
                        type: res?.success ? 'success' : 'error',
                        message: res?.message || (res?.success ? 'Escrow Locked!' : 'Escrow verification failed.')
                      });
                    }}
                    className="w-full py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded text-xs font-bold transition-colors cursor-pointer"
                  >
                    Lock Escrow for {submitResult.id} (${(jobHourlyBudget * jobDuration * jobCount).toFixed(2)})
                  </button>
                ) : (
                  <div className="space-y-1.5">
                    {demandOrders.filter(d => d.paymentStatus !== 'ESCROW_AUTHORIZED').slice(0, 2).map(order => (
                      <button
                        key={order.id}
                        onClick={async () => {
                          const res = await simulateEscrowWebhook(order.id, order.customerGrossOfferPrice);
                          setEscrowFeedback({
                            type: res?.success ? 'success' : 'error',
                            message: res?.message || (res?.success ? `Escrow Authorized for ${order.id}!` : 'Escrow verification failed.')
                          });
                        }}
                        className="w-full py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded text-[11px] font-mono flex items-center justify-between px-2 cursor-pointer"
                      >
                        <span>{order.id} ({order.customerName.slice(0, 14)})</span>
                        <span className="text-emerald-400 font-bold">${order.customerGrossOfferPrice.toFixed(2)}</span>
                      </button>
                    ))}
                    <div className="text-[10px] text-slate-500 italic">
                      Submit a new job above or click a pending order to fire verified HMAC webhook.
                    </div>
                  </div>
                )}
                {escrowFeedback && (
                  <div className={`text-[11px] font-mono pt-1 ${escrowFeedback.type === 'success' ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {escrowFeedback.message}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* cURL Code Snippet */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-2">
            <h4 className="text-xs font-bold text-slate-300 uppercase flex items-center gap-1.5">
              <Code className="w-4 h-4 text-purple-400" />
              <span>Private Job Submission Endpoint</span>
            </h4>

            <div className="bg-black/90 p-3 rounded text-[10px] text-slate-300 overflow-x-auto leading-relaxed border border-slate-800">
              <pre>
{`curl -X POST https://api.gpu-os.internal/v1/jobs \\
  -H "Authorization: Bearer g_arb_live_***" \\
  -H "Content-Type: application/json" \\
  -d '{
    "gpu_model": "${jobGpu}",
    "gpu_count": ${jobCount},
    "duration_hours": ${jobDuration},
    "max_budget_per_hour": ${jobHourlyBudget.toFixed(2)},
    "workload_type": "${jobWorkload}"
  }'`}
              </pre>
            </div>
          </div>

        </div>

      </div>

      {/* ALL 16 GPU WORKLOADS INTERACTIVE CATALOG & BILLING TAXONOMY */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-800">
          <div>
            <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
              <Layers className="w-4 h-4 text-cyan-400" />
              <span>Supported GPU Workloads Catalog (All 16 Production Workloads Integrated)</span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Click any row below to pre-fill the Verified Demand Order form with that GPU workload, what the customer pays for, and recommended GPU hardware.
            </p>
          </div>
          <span className="px-2.5 py-1 bg-cyan-950/80 border border-cyan-800 text-cyan-300 rounded text-[11px] font-bold">
            16 / 16 WORKLOADS ACTIVE
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-400 bg-slate-950/70">
                <th className="py-2.5 px-3">GPU Workload</th>
                <th className="py-2.5 px-3">What the Customer Pays For</th>
                <th className="py-2.5 px-3">Example</th>
                <th className="py-2.5 px-3">Unit Billing Benchmark</th>
                <th className="py-2.5 px-3">Preferred GPUs</th>
                <th className="py-2.5 px-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {GPU_WORKLOAD_CATALOG.map(spec => {
                const isSelected = jobWorkload === spec.id;
                return (
                  <tr
                    key={spec.id}
                    onClick={() => {
                      setJobWorkload(spec.id);
                      const targetGpu = spec.preferredGpuModels[0] || 'H100 SXM5 80GB';
                      setJobGpu(targetGpu);
                      setJobDuration(spec.defaultDurationHours);
                      setJobDesc(`${spec.name} — Customer pays for: ${spec.customerPaysFor} (${spec.example})`);
                    }}
                    className={`cursor-pointer transition-colors ${
                      isSelected ? 'bg-cyan-950/40 border-l-2 border-cyan-400' : 'hover:bg-slate-950/60'
                    }`}
                  >
                    <td className="py-2.5 px-3 font-bold text-cyan-300 whitespace-nowrap">
                      {spec.name}
                    </td>
                    <td className="py-2.5 px-3 font-semibold text-amber-300">
                      {spec.customerPaysFor}
                    </td>
                    <td className="py-2.5 px-3 text-slate-200">
                      {spec.example}
                    </td>
                    <td className="py-2.5 px-3 text-slate-400 text-[11px]">
                      {spec.unitPricingBenchmark}
                    </td>
                    <td className="py-2.5 px-3 text-slate-400 text-[11px]">
                      {spec.preferredGpuModels.slice(0, 2).join(', ')}
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                        isSelected
                          ? 'bg-emerald-950 text-emerald-300 border-emerald-700'
                          : 'bg-slate-950 text-cyan-300 border-slate-800'
                      }`}>
                        {isSelected ? 'SELECTED' : 'Load Spec'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
