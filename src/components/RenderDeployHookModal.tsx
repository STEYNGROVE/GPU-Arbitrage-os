import React, { useState, useEffect } from 'react';
import {
  X,
  Rocket,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  ExternalLink,
  ClipboardPaste,
  RefreshCw,
  Server,
  Terminal,
  ShieldCheck,
  Play,
  Zap,
} from 'lucide-react';

interface RenderDeployHookModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface DeployHookStatus {
  configured: boolean;
  maskedUrl: string;
  lastTriggeredAt: string | null;
  lastStatus: string | null;
  instructions: {
    step1: string;
    step2: string;
    step3: string;
    step4: string;
    docsUrl: string;
  };
}

export const RenderDeployHookModal: React.FC<RenderDeployHookModalProps> = ({ isOpen, onClose }) => {
  const [hookUrlInput, setHookUrlInput] = useState<string>('');
  const [status, setStatus] = useState<DeployHookStatus | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isDeploying, setIsDeploying] = useState<boolean>(false);
  const [deployResult, setDeployResult] = useState<{
    success: boolean;
    statusCode?: number;
    message: string;
    details?: any;
    error?: string;
    triggeredAt: string;
  } | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [copiedDoc, setCopiedDoc] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadStatus();
      setFeedback(null);
    }
  }, [isOpen]);

  const loadStatus = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/deploy/hook');
      if (res.ok) {
        const data: DeployHookStatus = await res.json();
        setStatus(data);
        if (data.maskedUrl && !hookUrlInput) {
          // Keep placeholder visible
        }
      }
    } catch (err: any) {
      console.warn('Failed to fetch deploy hook status:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handlePasteClipboard = async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text && text.trim().startsWith('http')) {
          setHookUrlInput(text.trim());
          setFeedback({ type: 'success', message: 'Pasted Deploy Hook URL from clipboard!' });
          setTimeout(() => setFeedback(null), 3000);
          return;
        }
      }
      setFeedback({ type: 'error', message: 'Clipboard did not contain a valid URL.' });
    } catch {
      setFeedback({ type: 'error', message: 'Unable to access clipboard. Please paste manually into the input box.' });
    }
  };

  const handleSaveHook = async () => {
    if (!hookUrlInput.trim()) {
      setFeedback({ type: 'error', message: 'Please enter a Deploy Hook URL or click Clear to reset.' });
      return;
    }
    setIsSaving(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/deploy/hook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: hookUrlInput.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setStatus(data);
        setHookUrlInput('');
        setFeedback({ type: 'success', message: 'Render Deploy Hook URL successfully configured and saved!' });
      } else {
        setFeedback({ type: 'error', message: data.error || 'Failed to save deploy hook URL.' });
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: `Save error: ${err.message}` });
    } finally {
      setIsSaving(false);
    }
  };

  const handleClearHook = async () => {
    setIsSaving(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/deploy/hook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: '' }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus(data);
        setHookUrlInput('');
        setFeedback({ type: 'success', message: 'Deploy Hook cleared.' });
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message });
    } finally {
      setIsSaving(false);
    }
  };

  const handleTriggerDeploy = async () => {
    setIsDeploying(true);
    setDeployResult(null);
    setFeedback(null);
    try {
      const res = await fetch('/api/deploy/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      setDeployResult(data);
      if (data.success) {
        setFeedback({ type: 'success', message: data.message });
      } else {
        setFeedback({ type: 'error', message: data.message });
      }
      loadStatus();
    } catch (err: any) {
      setDeployResult({
        success: false,
        message: `Network error triggering deploy: ${err.message}`,
        error: err.message,
        triggeredAt: new Date().toISOString(),
      });
      setFeedback({ type: 'error', message: err.message });
    } finally {
      setIsDeploying(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md overflow-y-auto animate-in fade-in duration-150">
      <div className="bg-[#0b101b] border border-cyan-500/40 rounded-xl w-full max-w-3xl shadow-2xl shadow-cyan-950/60 overflow-hidden my-8">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-[#0d1424]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-cyan-500/10 border border-cyan-500/40 flex items-center justify-center text-cyan-400">
              <Rocket className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white tracking-wide">
                  Render Deploy Hook Space
                </h2>
                {status?.configured ? (
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-950/80 text-emerald-300 border border-emerald-700/80 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                    ACTIVE HOOK
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-amber-950/80 text-amber-300 border border-amber-700/80 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                    AWAITING HOOK
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 font-mono mt-0.5">
                Trigger cloud builds & redeployments to your existing Render Web Service instantly
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-6 max-h-[80vh] overflow-y-auto">
          {/* Status Banner */}
          <div className="p-4 rounded-lg bg-slate-900/60 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full ${status?.configured ? 'bg-emerald-400' : 'bg-amber-400'}`}></div>
              <div>
                <div className="text-xs font-semibold text-slate-300">
                  Current Deploy Hook Target
                </div>
                <div className="text-xs font-mono text-cyan-300 mt-0.5">
                  {status?.configured ? status.maskedUrl : 'No hook URL currently active'}
                </div>
              </div>
            </div>
            {status?.lastTriggeredAt && (
              <div className="text-[11px] font-mono text-slate-400 text-right">
                Last Triggered: {new Date(status.lastTriggeredAt).toLocaleTimeString()}
              </div>
            )}
          </div>

          {/* Feedback message */}
          {feedback && (
            <div
              className={`p-3 rounded-md text-xs flex items-center gap-2 ${
                feedback.type === 'success'
                  ? 'bg-emerald-950/50 text-emerald-300 border border-emerald-800'
                  : 'bg-rose-950/50 text-rose-300 border border-rose-800'
              }`}
            >
              {feedback.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              )}
              <span>{feedback.message}</span>
            </div>
          )}

          {/* Input Space */}
          <div className="p-5 rounded-lg bg-slate-900/40 border border-slate-800 space-y-3">
            <label className="block text-xs font-bold text-white uppercase tracking-wider">
              Configure Deploy Hook URL
            </label>
            <p className="text-xs text-slate-400 leading-relaxed">
              Paste the webhook URL generated by Render for your Web Service. Triggering this hook causes Render to rebuild and deploy your service without needing GitHub pushes.
            </p>

            <div className="flex gap-2 pt-1">
              <input
                type="text"
                value={hookUrlInput}
                onChange={(e) => setHookUrlInput(e.target.value)}
                placeholder={status?.configured ? status.maskedUrl : 'https://api.render.com/deploy/srv-cxxxxxx?key=yyyyyy'}
                className="flex-1 px-3.5 py-2 bg-slate-950 border border-slate-700 rounded-md text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500 font-mono"
              />
              <button
                type="button"
                onClick={handlePasteClipboard}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md transition-colors cursor-pointer"
                title="Paste from clipboard"
              >
                <ClipboardPaste className="w-3.5 h-3.5 text-cyan-400" />
                <span className="hidden sm:inline">Paste</span>
              </button>
              <button
                type="button"
                onClick={handleSaveHook}
                disabled={isSaving}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-md transition-colors cursor-pointer disabled:opacity-50"
              >
                {isSaving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                <span>Save</span>
              </button>
              {status?.configured && (
                <button
                  type="button"
                  onClick={handleClearHook}
                  disabled={isSaving}
                  className="px-3 py-2 text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-950/30 border border-rose-900/60 rounded-md transition-colors cursor-pointer"
                  title="Clear configured hook"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Trigger Deployment Action */}
          <div className="p-5 rounded-lg bg-gradient-to-r from-slate-900/80 to-[#0e172a] border border-cyan-500/30 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Play className="w-4 h-4 text-cyan-400 fill-cyan-400" />
                  <span>Execute Render Deployment</span>
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Fires an authenticated POST request to Render to initiate an immediate build and release.
                </p>
              </div>

              <button
                type="button"
                onClick={handleTriggerDeploy}
                disabled={isDeploying || !status?.configured}
                className={`inline-flex items-center justify-center gap-2 px-5 py-2.5 text-xs font-bold rounded-lg transition-all cursor-pointer shadow-lg whitespace-nowrap ${
                  status?.configured
                    ? 'text-slate-950 bg-gradient-to-r from-cyan-400 to-teal-300 hover:from-cyan-300 hover:to-teal-200 shadow-cyan-950/50 active:scale-95'
                    : 'text-slate-500 bg-slate-800 border border-slate-700 cursor-not-allowed opacity-60'
                }`}
              >
                {isDeploying ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin text-slate-950" />
                    <span>Triggering Render...</span>
                  </>
                ) : (
                  <>
                    <Rocket className="w-4 h-4 text-slate-950" />
                    <span>Trigger Live Deploy</span>
                  </>
                )}
              </button>
            </div>

            {/* Deploy Trigger Result Output Log */}
            {deployResult && (
              <div className="mt-3 p-3.5 rounded-md bg-black/70 border border-slate-800 font-mono text-xs space-y-1.5">
                <div className="flex items-center justify-between text-slate-400 text-[11px] border-b border-slate-800 pb-1.5">
                  <span className="flex items-center gap-1.5">
                    <Terminal className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Render Deployment Log</span>
                  </span>
                  <span>{new Date(deployResult.triggeredAt).toLocaleTimeString()}</span>
                </div>
                <div className={deployResult.success ? 'text-emerald-300' : 'text-rose-300'}>
                  Status: {deployResult.success ? 'SUCCESS (HTTP 200/201)' : `FAILED (HTTP ${deployResult.statusCode || 500})`}
                </div>
                <div className="text-slate-300">{deployResult.message}</div>
                {deployResult.details && (
                  <pre className="text-[11px] text-slate-400 overflow-x-auto p-2 bg-slate-950/80 rounded border border-slate-900 whitespace-pre-wrap">
                    {JSON.stringify(deployResult.details, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </div>

          {/* Step-by-Step Instructions */}
          <div className="p-5 rounded-lg bg-slate-900/40 border border-slate-800 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                <span>How to Get Your Deploy Hook From Render</span>
              </h3>
              <a
                href="https://dashboard.render.com"
                target="_blank"
                rel="noreferrer"
                className="text-xs text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-1"
              >
                Open Render Dashboard <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            <ol className="list-decimal list-inside space-y-2 text-xs text-slate-300 leading-relaxed pt-1">
              <li>
                Sign in to <a href="https://dashboard.render.com" target="_blank" rel="noreferrer" className="text-cyan-300 underline font-mono">dashboard.render.com</a> and select your Web Service.
              </li>
              <li>
                Click on the <strong className="text-white">Settings</strong> tab in the left-hand navigation.
              </li>
              <li>
                Scroll down to the <strong className="text-white">Deploy Hook</strong> section.
              </li>
              <li>
                Click <strong className="text-white">Create Deploy Hook</strong> (or copy your existing hook URL).
              </li>
              <li>
                Paste the URL into the input field above and click <strong className="text-cyan-300">Save</strong>.
              </li>
            </ol>

            <div className="p-3 bg-cyan-950/20 border border-cyan-800/40 rounded text-xs text-cyan-300 font-mono">
              <strong>Environment Variable:</strong> You can also set <code className="text-white bg-slate-900 px-1 py-0.5 rounded">RENDER_DEPLOY_HOOK_URL</code> in your Render service environment settings or <code className="text-white bg-slate-900 px-1 py-0.5 rounded">.env</code> to make it permanent.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
